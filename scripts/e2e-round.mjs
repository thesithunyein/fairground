// FAIRGROUND end-to-end round against the local simulator.
// Drives LocalCasinoHost.openSession → real VRF → settlement and checks the
// payout against the declared math. Run while `npm start` is up in the SDK.
//
//   node scripts/e2e-round.mjs

import { createPublicClient, createWalletClient, http, encodeFunctionData, decodeFunctionResult, formatEther, parseEther } from 'viem';
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

const { host, token, games } = await (await fetch(DEPLOYED_URL)).json();
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
  { name: 'registerGame', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'g', type: 'address' }, { name: 'n', type: 'string' }], outputs: [] },
  {
    name: 'openSession', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'game', type: 'address' }, { name: 'vault', type: 'address' }, { name: 'wager', type: 'uint256' }, { name: 'gameData', type: 'bytes' }],
    outputs: [{ name: 'sessionId', type: 'uint256' }, { name: 'requestId', type: 'bytes32' }],
  },
  {
    name: 'decodeSession', type: 'function', stateMutability: 'pure',
    inputs: [{ name: 'encoded', type: 'bytes' }], outputs: [],
  },
];
const GAME_ABI = [
  { name: 'quoteRiskParams', type: 'function', stateMutability: 'view', inputs: [{ name: 'w', type: 'uint256' }, { name: 'd', type: 'bytes' }], outputs: [{ name: 'maxPayout', type: 'uint256' }, { name: 'probabilityWad', type: 'uint256' }, { name: 'expectedPayout', type: 'uint256' }, { name: 'bodyVarianceScaled', type: 'uint256' }] },
  { name: 'quoteCaps', type: 'function', stateMutability: 'view', inputs: [{ name: 'w', type: 'uint256' }, { name: 'd', type: 'bytes' }], outputs: [{ name: 'maxEscrowStake', type: 'uint256' }, { name: 'maxReservedProfit', type: 'uint256' }] },
];
const SETTLED_EVENT = {
  name: 'CasinoSessionSettled',
  type: 'event',
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

// ── paint: 12 segments, classic default (risky/safe×3/mid ×4) ────────────────
// byte0 = 12; then pairs: (2,0)(0,1)(2,0)(0,1)(2,0)(0,1) low=seg2i, high=seg2i+1
const paintBytes = new Uint8Array(9);
paintBytes[0] = 12;
const tiers = [2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1];
for (let i = 0; i < 12; i += 2) paintBytes[1 + (i >> 1)] = tiers[i] | (tiers[i + 1] << 4);
const gameData = '0x' + [...paintBytes].map(b => b.toString(16).padStart(2, '0')).join('');

const wager = parseEther('1');

console.log('FAIRGROUND e2e round');
console.log('  game   :', game.address);
console.log('  player :', account.address);
console.log('  gameData:', gameData);

// fund player + approve host
await walletClient.writeContract({ address: token, abi: ERC20_ABI, functionName: 'mint', args: [account.address, parseEther('100')] });
await walletClient.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [host, parseEther('100')] });

// risk quotes before opening (declared math check on-chain)
const risk = await publicClient.readContract({ address: game.address, abi: GAME_ABI, functionName: 'quoteRiskParams', args: [wager, gameData] });
const caps = await publicClient.readContract({ address: game.address, abi: GAME_ABI, functionName: 'quoteCaps', args: [wager, gameData] });
console.log('  quoteRiskParams:', risk.map(v => v.toString()));
console.log('  quoteCaps      :', caps.map(v => v.toString()));

const balanceBefore = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });

// open the session — triggers onSessionStart → VRF request
const hash = await walletClient.writeContract({ address: host, abi: HOST_ABI, functionName: 'openSession', args: [game.address, process.env.SESSION_VAULT ?? (await localVault()), wager, gameData] });

async function localVault() {
  const res = await fetch(DEPLOYED_URL);
  return (await res.json()).vault;
}

const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
console.log('  openSession tx:', hash.slice(0, 18) + '…  block', receipt.status);

// wait for VRF fulfillment + settlement (poll balance for change, then read event)
let settled = null;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 500));
  const logs = await publicClient.getLogs({ address: host, event: SETTLED_EVENT, fromBlock: receipt.blockNumber, toBlock: 'latest' });
  const ours = logs.find(l => l.args.game?.toLowerCase() === game.address.toLowerCase());
  if (ours) { settled = ours; break; }
}
if (!settled) { console.error('NOT SETTLED within 30s'); process.exit(1); }

const { payout, randomness, gameState, sessionId, phase } = settled.args;
const balanceAfter = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });

// decode outcome from the VRF word using the same rules as the client
const rndBytes = Uint8Array.from(randomness.slice(2).match(/.{2}/g).map(h => parseInt(h, 16)));
const limit = Math.floor(256 / 12) * 12;
let seg = -1;
for (const b of rndBytes) { if (b < limit) { seg = b % 12; break; } }
const tier = tiers[seg];
// exact pricing per game.ts / FairgroundWheel.sol:
//   SAFE = 0.2e18, MID = 2λ, RISKY = 6λ, λ = (0.96e18·N − 0.2e18·cSafe)/(2·cMid + 6·cRisky)
const WAD = 10n ** 18n;
const RTP = 960n * (WAD / 1000n);
let cSafe = 0n, cMid = 0n, cRisky = 0n;
for (const t of tiers) { if (t === 0) cSafe++; else if (t === 1) cMid++; else cRisky++; }
const n = BigInt(tiers.length);
const lambda = (RTP * n - (WAD / 5n) * cSafe) / (2n * cMid + 6n * cRisky);
const multWad = tier === 0 ? WAD / 5n : tier === 1 ? 2n * lambda : 6n * lambda;
const expectPayout = (wager * multWad) / WAD;

console.log('');
console.log('  ── SETTLED ──');
console.log('  sessionId :', sessionId.toString());
console.log('  phase     :', phase.toString(), '(3 = SETTLED)');
console.log('  randomness:', randomness);
console.log('  segment   :', seg, ' tier:', tier === 0 ? 'SAFE' : tier === 1 ? 'MID' : 'RISKY');
console.log('  payout    :', formatEther(payout), 'chUSD  (expected', formatEther(expectPayout) + ')');
console.log('  balance   :', formatEther(balanceBefore), '→', formatEther(balanceAfter));

const okPayout = payout === expectPayout;
console.log('');
console.log(okPayout ? '✅ E2E PASS: payout matches declared math exactly.' : '❌ E2E FAIL: payout mismatch.');
process.exit(okPayout ? 0 : 1);
