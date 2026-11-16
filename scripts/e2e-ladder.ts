// FAIRGROUND end-to-end: plays real sessions against the SDK simulator's chain.
//
// Opens sessions on the deployed graph-engine title, BANKs or RIDEs at the rung through the
// same submitAction the host sends, waits for the local VRF node, and checks every settlement
// against the SDK's walkLadder replay and against the floored prizes (never above them, at
// most one base unit under), and the player's token balance against wager and payout.
//
// Run while `npm run simulator` is up:   node scripts/e2e-ladder.ts [sessions]
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  maxUint256,
  parseEventLogs,
  type Hex,
} from 'viem';
import { encodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { localCasinoHostAbi, localTestTokenAbi } from '@chain-protocol/casino-sdk/local-host';
import { compileGraphGame, encodePlainGameData, walkLadder, type LadderAction } from '@chain-protocol/casino-sdk/graph-engine';
import fairground, { ACTION_BANK, ACTION_RIDE, COMPOSITIONS, LABEL, PRIZE_DENOMINATOR, entryPrizes } from '../src/title.ts';

const SIMULATOR = process.env.SIMULATOR_URL ?? 'http://127.0.0.1:3300';
const SESSIONS = Number(process.argv[2] ?? 12);
// Hardhat's well-known test account #9: local chain only.
const PLAYER_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6';

const contracts = await (await fetch(`${SIMULATOR}/__local-contracts.json`)).json();
const game = contracts.games.find((g: { name: string }) => g.name === 'Fairground')?.address as Hex;
if (!game) throw new Error('Fairground is not deployed on the simulator: is `npm run simulator` running?');
const chain = defineChain({
  id: contracts.chainId, name: 'simulator', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [contracts.rpcUrl] } },
});
const account = privateKeyToAccount(PLAYER_KEY);
const publicClient = createPublicClient({ chain, transport: http(), pollingInterval: 200 });
const wallet = createWalletClient({ chain, transport: http(), account });
const host = contracts.host as Hex;
const token = contracts.token as Hex;

const { graph } = compileGraphGame(fairground);
const action = (index: number) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(index)]);

async function payment(): Promise<bigint> {
  const { maxFeePerGas } = await publicClient.estimateFeesPerGas();
  const required = await publicClient.readContract({ address: host, abi: localCasinoHostAbi, functionName: 'requiredPayment', args: [16384n, maxFeePerGas] });
  return required + required / 10n; // the simulator page adds the same 10% headroom
}

async function send(functionName: 'openSession' | 'submitAction', args: readonly unknown[]) {
  const hash = await wallet.writeContract({ address: host, abi: localCasinoHostAbi, functionName, args: args as never, value: await payment() } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
  return parseEventLogs({ abi: localCasinoHostAbi, logs: receipt.logs });
}

type Step = { kind: 'advanced'; randomness: Hex; session: Hex } | { kind: 'settled'; payout: bigint; randomness: Hex };

/** The session's next step after `afterBlock`: a VRF word delivered, or the settlement. */
async function nextStep(sessionId: bigint, afterBlock: bigint): Promise<Step> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const logs = await publicClient.getContractEvents({ address: host, abi: localCasinoHostAbi, fromBlock: afterBlock + 1n, args: { sessionId } as never });
    for (const log of logs as { eventName: string; args: Record<string, unknown> }[]) {
      if (log.eventName === 'CasinoSessionSettled') return { kind: 'settled', payout: log.args.payout as bigint, randomness: log.args.randomness as Hex };
      if (log.eventName === 'CasinoSessionAdvanced' && BigInt(log.args.randomness as Hex) !== 0n) {
        return { kind: 'advanced', randomness: log.args.randomness as Hex, session: log.args.session as Hex };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`session ${sessionId}: no VRF word within 60 s`);
}

const balance = () => publicClient.readContract({ address: token, abi: localTestTokenAbi, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>;

await (async () => {
  const mint = await wallet.writeContract({ address: token, abi: localTestTokenAbi, functionName: 'mint', args: [account.address, 10_000n * PRIZE_DENOMINATOR] } as never);
  await publicClient.waitForTransactionReceipt({ hash: mint });
  const approve = await wallet.writeContract({ address: token, abi: localTestTokenAbi, functionName: 'approve', args: [host, maxUint256] } as never);
  await publicClient.waitForTransactionReceipt({ hash: approve });
})();

let failures = 0;
for (let s = 0; s < SESSIONS; s++) {
  // spread the sessions over wheel sizes and shapes; plan 0..3 rides, then bank
  const configuration = (s * 37) % COMPOSITIONS.length;
  const c = COMPOSITIONS[configuration];
  const wager = [PRIZE_DENOMINATOR, 3n * PRIZE_DENOMINATOR, 1_234_567n][s % 3];
  const plannedRides = s % 4;
  const before = await balance();

  const opened = await send('openSession', [game, contracts.vault, wager, encodePlainGameData(configuration, '0x0c')]);
  const open = opened.find(l => l.eventName === 'CasinoSessionOpened') as unknown as { args: { sessionId: bigint }; blockNumber: bigint };
  const sessionId = open.args.sessionId;
  let block = open.blockNumber;

  const words: Hex[] = [];
  const actions: LadderAction[] = [];
  let payout: bigint | undefined;
  for (;;) {
    const step = await nextStep(sessionId, block);
    block = await publicClient.getBlockNumber();
    if (step.kind === 'settled') {
      if (BigInt(step.randomness) !== 0n && !words.includes(step.randomness)) {
        // the word that settled it: a lost ride, or a win that reached the cap
        words.push(step.randomness);
        if (words.length > 1) actions.push({ option: ACTION_RIDE, randomness: step.randomness });
      }
      payout = step.payout;
      break;
    }
    words.push(step.randomness);
    if (words.length > 1) actions.push({ option: ACTION_RIDE, randomness: step.randomness });
    const ride = actions.length < plannedRides;
    if (!ride) actions.push('cashOut');
    const logs = await send('submitAction', [step.session, action(ride ? ACTION_RIDE : ACTION_BANK)]);
    block = await publicClient.getBlockNumber();
    if (!ride) {
      // a cash-out needs no word: the action itself settles the session
      const settled = logs.find(l => l.eventName === 'CasinoSessionSettled') as unknown as { args: { payout: bigint } } | undefined;
      if (!settled) throw new Error(`session ${sessionId}: BANK did not settle`);
      payout = settled.args.payout;
      break;
    }
  }

  // The engine's settlement against the SDK's replay and the floored prizes.
  const walk = walkLadder(graph, graph.roots[configuration], words[0], actions, wager);
  const [tierLabel, ...rideLabels] = walk.labels;
  const prizes = entryPrizes(c);
  const prize = tierLabel === LABEL.safe ? prizes.safe : tierLabel === LABEL.mid ? prizes.mid : prizes.risky;
  const wins = rideLabels.filter(l => l === LABEL.win).length;
  const lost = rideLabels.includes(LABEL.lose);
  const floored = lost ? 0n : (wager * prize * 2n ** BigInt(wins)) / PRIZE_DENOMINATOR;
  const after = await balance();
  const tier = ['SAFE', 'MID', 'RISKY'][tierLabel];
  const ok = walk.status === 'settled' && walk.payout === payout && (payout === floored || payout === floored - 1n) && after - before === payout - wager;
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} session ${sessionId}  N=${c.n} ${c.cSafe}/${c.cMid}/${c.cRisky}  ${tier} ${wins} win${lost ? ' + loss' : ''}  ` +
    `paid ${payout} (walk ${walk.status === 'settled' ? walk.payout : 'waiting'}, floored ${floored})  balance ${after - before}`,
  );
}

console.log(failures ? `FAIL: ${failures} of ${SESSIONS} sessions` : `OK: ${SESSIONS} sessions opened, played and settled as walkLadder and the floored prizes say`);
process.exit(failures ? 1 : 0);
