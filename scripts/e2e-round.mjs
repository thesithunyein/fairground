// FAIRGROUND end-to-end round against the local simulator.
//
// Drives the REAL host through every branch of the round and checks each payout
// against the declared math:
//
//   1. BANK  — open → word A → submit BANK → settle
//   2. RIDE  — open → word A → submit RIDE → word B (coin) → settle
//   3. the declared risk quotes are the worst case over the player's choices
//   4. quoteForfeitPayout returns the bankable amount while the player decides
//
// Run while the SDK simulator is up (`bun run local-node` + `bun run dev` in
// casino-sdk/simulator, with contract/FairgroundWheel.sol dropped into
// simulator/contracts/):
//
//   node scripts/e2e-round.mjs

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  encodeAbiParameters,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';

const hardhat = defineChain({
  id: 31337,
  name: 'hardhat',
  network: 'hardhat',
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});

const DEPLOYED_URL = 'http://localhost:3300/__local-contracts.json';
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // hardhat #0

const WAD = 10n ** 18n;
const RTP = 960n * (WAD / 1000n);
const SAFE_ANCHOR = WAD / 5n;

const { host, token, vault, games } = await (await fetch(DEPLOYED_URL)).json();
// the drop-in watcher appends every deploy, newest first
const game = games.find(g => g.name === 'FairgroundWheel');
if (!game) { console.error('FairgroundWheel not deployed'); process.exit(1); }

const account = privateKeyToAccount(DEV_KEY);
const publicClient = createPublicClient({ chain: hardhat, transport: http() });
const walletClient = createWalletClient({ account, chain: hardhat, transport: http() });

const ERC20_ABI = [
  { name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
];
const HOST_ABI = [
  {
    name: 'openSession', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'game', type: 'address' }, { name: 'vault', type: 'address' }, { name: 'wager', type: 'uint256' }, { name: 'gameData', type: 'bytes' }],
    outputs: [{ name: 'sessionId', type: 'uint256' }, { name: 'requestId', type: 'bytes32' }],
  },
  {
    name: 'submitAction', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'encodedSession', type: 'bytes' }, { name: 'actionData', type: 'bytes' }],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
];
const GAME_ABI = [
  { name: 'quoteRiskParams', type: 'function', stateMutability: 'view', inputs: [{ name: 'w', type: 'uint256' }, { name: 'd', type: 'bytes' }], outputs: [{ name: 'maxPayout', type: 'uint256' }, { name: 'probabilityWad', type: 'uint256' }, { name: 'expectedPayout', type: 'uint256' }, { name: 'bodyVarianceScaled', type: 'uint256' }] },
  { name: 'quoteCaps', type: 'function', stateMutability: 'view', inputs: [{ name: 'w', type: 'uint256' }, { name: 'd', type: 'bytes' }], outputs: [{ name: 'maxEscrowStake', type: 'uint256' }, { name: 'maxReservedProfit', type: 'uint256' }] },
  { name: 'quoteForfeitPayout', type: 'function', stateMutability: 'view', inputs: [{ name: 'ctx', type: 'tuple', components: [
    { name: 'sessionId', type: 'uint256' }, { name: 'player', type: 'address' }, { name: 'vault', type: 'address' },
    { name: 'wagerBase', type: 'uint256' }, { name: 'escrowedStake', type: 'uint256' }, { name: 'reservedProfit', type: 'uint256' },
    { name: 'step', type: 'uint32' }, { name: 'gameData', type: 'bytes' }, { name: 'gameState', type: 'bytes' },
  ] }], outputs: [{ name: 'cashoutValue', type: 'uint256' }] },
];
const ADVANCED_EVENT = {
  name: 'CasinoSessionAdvanced', type: 'event',
  inputs: [
    { name: 'sessionId', type: 'uint256', indexed: true },
    { name: 'step', type: 'uint32', indexed: true },
    { name: 'requestId', type: 'bytes32', indexed: false },
    { name: 'randomness', type: 'bytes32', indexed: false },
    { name: 'session', type: 'bytes', indexed: false },
  ],
};
const SETTLED_EVENT = {
  name: 'CasinoSessionSettled', type: 'event',
  inputs: [
    { name: 'sessionId', type: 'uint256', indexed: true },
    { name: 'game', type: 'address', indexed: true },
    { name: 'player', type: 'address', indexed: true },
    { name: 'phase', type: 'uint8', indexed: false },
    { name: 'payout', type: 'uint256', indexed: false },
    { name: 'randomness', type: 'bytes32', indexed: false },
    { name: 'gameState', type: 'bytes', indexed: false },
  ],
};

// ── paint: 12 segments (risky/safe×3/mid ×4), the default wheel ──────────────
const tiers = [2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1];
const paintBytes = new Uint8Array(9);
paintBytes[0] = tiers.length;
for (let i = 0; i < tiers.length; i += 2) paintBytes[1 + (i >> 1)] = tiers[i] | (tiers[i + 1] << 4);
const gameData = '0x' + [...paintBytes].map(b => b.toString(16).padStart(2, '0')).join('');

const n = BigInt(tiers.length);
let cSafe = 0n, cMid = 0n, cRisky = 0n;
for (const t of tiers) { if (t === 0) cSafe++; else if (t === 1) cMid++; else cRisky++; }

// exact pricing per game.ts / FairgroundWheel.sol
const lambda = (RTP * n - SAFE_ANCHOR * cSafe) / (2n * cMid + 6n * cRisky);
const MULT = { 0: SAFE_ANCHOR, 1: 2n * lambda, 2: 6n * lambda };
const payoutFor = (wager, mult) => (wager * mult) / WAD;
const baseOf = (wager, tier) => payoutFor(wager, MULT[tier]);

const segmentFrom = (rand) => {
  const bytes = Uint8Array.from(rand.slice(2).match(/.{2}/g).map(h => parseInt(h, 16)));
  const limit = Math.floor(256 / tiers.length) * tiers.length;
  for (const b of bytes) if (b < limit) return b % tiers.length;
  return Number(BigInt(rand) % n);
};

// body variance closed form: X² · cMid · (2N − cMid) / N², scaled by 1e18
const bodyVarianceWad = (wager) => {
  const mid = MULT[1];
  if (mid <= WAD / 2n) return 0n;
  const X = payoutFor(wager, mid);
  return (((X * X) * cMid * (2n * n - cMid)) / (n * n)) * WAD;
};

const wager = parseEther('1');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  ${detail}` : ''}`);
};

const logsFor = async (address, event, fromBlock, filter) => {
  const logs = await publicClient.getLogs({ address, event, fromBlock, toBlock: 'latest' });
  // the action step is looked up before we know the session id
  if (filter.sessionId === undefined) return logs;
  return logs.filter(l => l.args.sessionId === filter.sessionId);
};

const waitFor = async (address, event, fromBlock, filter, predicate, label, tries = 90) => {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 400));
    const found = (await logsFor(address, event, fromBlock, filter)).find(predicate);
    if (found) return found;
  }
  throw new Error(`${label} not observed within ${(tries * 0.4).toFixed(0)}s`);
};

// ── fund + approve ──────────────────────────────────────────────────────────
await walletClient.writeContract({ address: token, abi: ERC20_ABI, functionName: 'mint', args: [account.address, parseEther('500')] });
await walletClient.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [host, parseEther('500')] });

console.log('FAIRGROUND e2e round');
console.log('  game   :', game.address);
console.log('  player :', account.address);
console.log('  gameData:', gameData);

// ── declared risk quotes (worst case over the player's choices) ─────────────
console.log('\n── declared quotes ──');
const [maxPayout, probabilityWad, expectedPayout, bodyVariance] = await publicClient.readContract({
  address: game.address, abi: GAME_ABI, functionName: 'quoteRiskParams', args: [wager, gameData],
});
const [maxEscrowStake, maxReservedProfit] = await publicClient.readContract({
  address: game.address, abi: GAME_ABI, functionName: 'quoteCaps', args: [wager, gameData],
});
const heaviest = MULT[2];
console.log(`  λ = ${formatEther(lambda)}  safe ${formatEther(MULT[0])}×  mid ${formatEther(MULT[1])}×  risky ${formatEther(heaviest)}×`);
console.log(`  maxPayout ${formatEther(maxPayout)}  p ${Number(probabilityWad) / 1e18}  expected ${formatEther(expectedPayout)}`);
check('expectedPayout is exactly 96% of the wager', expectedPayout === (wager * RTP) / WAD);
check('maxPayout is the doubled top tier (worst case)', maxPayout === 2n * payoutFor(wager, heaviest));
check('probabilityWad is the top payout: cRisky/N · 1/2', probabilityWad === (cRisky * WAD) / (2n * n));
check('body variance matches the closed form', bodyVariance === bodyVarianceWad(wager), `${bodyVariance}`);
check('maxReservedProfit covers the whole reserve', maxReservedProfit === maxPayout - wager);
check('maxEscrowStake is the stake alone', maxEscrowStake === wager);

// ── helpers to drive one full round ─────────────────────────────────────────
async function openRound() {
  const hash = await walletClient.writeContract({
    address: host, abi: HOST_ABI, functionName: 'openSession',
    args: [game.address, vault, wager, gameData],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
  // step 2 is the transition into WAITING_PLAYER_ACTION: the first spin landed
  // and the host is waiting for BANK or RIDE. Its `session` bytes are the handle
  // submitAction needs.
  const decide = await waitFor(
    host, ADVANCED_EVENT, receipt.blockNumber, { sessionId: undefined },
    l => l.args.requestId === `0x${'0'.repeat(64)}` && l.args.randomness !== `0x${'0'.repeat(64)}`,
    'player-action step',
  );
  const firstWord = decide.args.randomness;
  return { sessionId: decide.args.sessionId, encodedSession: decide.args.session, firstWord, fromBlock: receipt.blockNumber };
}

async function settleAfter(round, actionData, label) {
  const hash = await walletClient.writeContract({
    address: host, abi: HOST_ABI, functionName: 'submitAction',
    args: [round.encodedSession, actionData],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
  const settled = await waitFor(
    host, SETTLED_EVENT, round.fromBlock, { sessionId: round.sessionId },
    l => Number(l.args.phase) === 3, `${label} settlement`,
  );
  return settled.args;
}

// ── 1. BANK ─────────────────────────────────────────────────────────────────
console.log('\n── 1. BANK ──');
{
  const round = await openRound();
  const segment = segmentFrom(round.firstWord);
  const tier = tiers[segment];
  const banked = baseOf(wager, tier);

  // while the player decides, the honest mid-round cash-out is the bank value
  const gameState = encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'uint8' }, { type: 'uint8' }],
    [tiers.length, segment, 1],
  );
  const forfeit = await publicClient.readContract({
    address: game.address, abi: GAME_ABI, functionName: 'quoteForfeitPayout',
    args: [{ sessionId: round.sessionId, player: account.address, vault, wagerBase: wager, escrowedStake: wager, reservedProfit: maxReservedProfit, step: 2, gameData, gameState }],
  });
  check('quoteForfeitPayout is the bankable amount', forfeit === banked, `${formatEther(forfeit)}`);

  const { payout } = await settleAfter(round, '0x00', 'bank');
  console.log(`  segment ${segment} → ${['SAFE', 'MID', 'RISKY'][tier]}`);
  check('bank pays the landed tier exactly', payout === banked, `${formatEther(payout)} chUSD`);
}

// ── 2. RIDE (until both a win and a loss are seen) ──────────────────────────
console.log('\n── 2. RIDE ──');
{
  const seen = { win: false, lose: false };
  for (let attempt = 0; attempt < 10 && !(seen.win && seen.lose); attempt++) {
    const round = await openRound();
    const segment = segmentFrom(round.firstWord);
    const tier = tiers[segment];
    const { payout, randomness: coin } = await settleAfter(round, '0x01', 'ride');

    // the coin is byte 0 of a word that did not exist when the player chose
    const coinByte = parseInt(coin.slice(2, 4), 16);
    const expectWin = coinByte < 128;
    const expected = expectWin ? 2n * baseOf(wager, tier) : 0n;

    console.log(`  attempt ${attempt + 1}: ${['SAFE', 'MID', 'RISKY'][tier]} → coin ${coinByte} → ${formatEther(payout)} chUSD`);
    check(`ride payout matches the coin (${expectWin ? 'win' : 'lose'})`, payout === expected);
    seen[expectWin ? 'win' : 'lose'] = true;
  }
  check('both ride outcomes observed', seen.win && seen.lose, seen.win && seen.lose ? '' : JSON.stringify(seen));
}

console.log('');
if (failures === 0) {
  console.log('✅ E2E PASS: bank, ride and every declared quote match the math.');
} else {
  console.log(`❌ E2E FAIL: ${failures} check(s) failed.`);
}
process.exit(failures === 0 ? 0 : 1);
