/**
 * Self-check for the DEX write path: pair-id derivation, calldata layout, and a
 * live `eth_call` dry run of `createSpotPool` against the deployed registry.
 *
 * Run: node src/dex.check.ts
 */
import assert from 'node:assert/strict';
import {
  DEX_CONTRACTS,
  DEX_SELECTOR,
  decodeDexAddressArray,
  decodeDexUint,
  decodeDexUint32,
  describeDexRevert,
  encodeAddLiquidity,
  encodeCreateSpotPool,
  encodeDexNoArgs,
  encodeRemoveLiquidity,
  encodeSharesOf,
  encodeCancelOrder,
  encodeOrderRead,
  encodePlaceOrder,
  decodeDexOrder,
  readOrderWindow,
  DEX_ORDER_SIDE,
  dexCall,
  readSpotPoolsForPair,
  simulateDexWrite,
  monWrapShortfall,
  spendableBalance,
  wrappableMon,
} from './dex.ts';
import { computePairId, keccak256Hex, sortTokenPair } from './keccak.ts';
import { MON_NATIVE_GAS_RESERVE, TOKENS } from './chain.ts';
import { CONTRACTS, rpcBatch } from './chain.ts';

const SER9 = CONTRACTS.ser9;
const IDENTITY = CONTRACTS.identity;
const SIMULATION_SENDER = '0x1111111111111111111111111111111111111111';

// ── keccak ────────────────────────────────────────────────────────────────────
assert.equal(
  keccak256Hex('0x'),
  '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  'keccak256 of empty input',
);

// `DexRegistry` keys pairs by keccak256(abi.encodePacked(token0, token1)), sorted.
assert.equal(
  computePairId(SER9, IDENTITY),
  '0x7b1e9c3fd1e2f00dff804fdcb6717337fe155b2e19eceb5bd09a16e9c5ffa302',
);
assert.equal(computePairId(SER9, IDENTITY), computePairId(IDENTITY, SER9), 'pair id ignores argument order');
assert.equal(computePairId(SER9, SER9), null, 'a pair needs two different tokens');
assert.deepEqual(sortTokenPair(IDENTITY, SER9), [SER9.toLowerCase(), IDENTITY.toLowerCase()]);

// ── calldata ──────────────────────────────────────────────────────────────────
const word = (data: string, index: number): string => data.slice(10 + index * 64, 10 + (index + 1) * 64);
const u256 = (value: bigint): string => value.toString(16).padStart(64, '0');

const createData = encodeCreateSpotPool(SER9, IDENTITY, 3_000n, 1n);
assert.equal(createData.slice(0, 10), DEX_SELECTOR.createSpotPool);
assert.equal(word(createData, 0), SER9.slice(2).toLowerCase().padStart(64, '0'));
assert.equal(word(createData, 1), IDENTITY.slice(2).toLowerCase().padStart(64, '0'));
assert.equal(BigInt(`0x${word(createData, 2)}`), 3_000n);
assert.equal(BigInt(`0x${word(createData, 3)}`), 1n);
assert.equal(createData.length, 10 + 4 * 64);

const addData = encodeAddLiquidity(1n, 2n, 3n, 4n, SER9);
assert.equal(addData.slice(0, 10), DEX_SELECTOR.addLiquidity);
assert.deepEqual([0, 1, 2, 3].map((index) => BigInt(`0x${word(addData, index)}`)), [1n, 2n, 3n, 4n]);
assert.equal(word(addData, 4), SER9.slice(2).toLowerCase().padStart(64, '0'));

const removeData = encodeRemoveLiquidity(9n, 1n, 2n, SER9);
assert.equal(removeData.slice(0, 10), DEX_SELECTOR.removeLiquidity);
assert.deepEqual([0, 1, 2].map((index) => BigInt(`0x${word(removeData, index)}`)), [9n, 1n, 2n]);
assert.equal(encodeSharesOf(SER9).slice(0, 10), DEX_SELECTOR.sharesOf);

// ── orderbook calldata ────────────────────────────────────────────────────────
const PAIR_ID = computePairId(SER9, IDENTITY)!;
const placeData = encodePlaceOrder(PAIR_ID, DEX_ORDER_SIDE.buy, 7n * 10n ** 18n, 5n * 10n ** 18n, 2_000_000_000n);
assert.equal(placeData.slice(0, 10), DEX_SELECTOR.placeOrder);
assert.equal(`0x${word(placeData, 0)}`, PAIR_ID);
assert.deepEqual(
  [1, 2, 3, 4, 5].map((index) => BigInt(`0x${word(placeData, index)}`)),
  [0n, 7n * 10n ** 18n, 5n * 10n ** 18n, 2_000_000_000n, 0n],
);
assert.equal(placeData.length, 10 + 6 * 64, 'placeOrder takes exactly six words');
assert.throws(() => encodePlaceOrder(PAIR_ID, 2n, 1n, 1n, 1n), /side/i, 'the side enum only has two members');
assert.throws(() => encodePlaceOrder(PAIR_ID, DEX_ORDER_SIDE.sell, 1n, 1n, 0n), /expiry/i);
assert.equal(encodeCancelOrder(3n).slice(0, 10), DEX_SELECTOR.cancelOrder);
assert.equal(encodeOrderRead(3n).slice(0, 10), DEX_SELECTOR.orders);

// The ten-word order slot as the live Orderbook returns it.
const orderBlob = '0x' +
  '0000000000000000000000001111111111111111111111111111111111111111' +
  u256(1n) + u256(0n) + u256(2_000_000_000n) + PAIR_ID.slice(2) +
  u256(7n * 10n ** 18n) + u256(5n * 10n ** 18n) + u256(0n) + u256(35n * 10n ** 18n) + u256(0n);
const decodedOrder = decodeDexOrder(orderBlob);
assert.ok(decodedOrder);
assert.equal(decodedOrder.maker, '0x1111111111111111111111111111111111111111');
assert.equal(decodedOrder.side, 1);
assert.equal(decodedOrder.status, 0);
assert.equal(decodedOrder.expiry, 2_000_000_000n);
assert.equal(decodedOrder.pairId, PAIR_ID);
assert.equal(decodedOrder.priceX18, 7n * 10n ** 18n);
assert.equal(decodedOrder.amount, 5n * 10n ** 18n);
assert.equal(decodedOrder.escrow, 35n * 10n ** 18n, 'a sell escrows base, a buy escrows price x amount');
assert.equal(decodeDexOrder('0x' + u256(0n).repeat(9)), null, 'nine words is not an order');

// ── decoding ──────────────────────────────────────────────────────────────────
assert.deepEqual(decodeDexAddressArray('0x' + '20'.padStart(64, '0') + '0'.repeat(64)), []);
assert.equal(decodeDexAddressArray('0x'), null, 'empty return data is not an array');
assert.equal(
  decodeDexAddressArray('0x' + (64).toString(16).padStart(64, '0') + '0'.repeat(64)),
  null,
  'a non-standard head offset is rejected',
);
assert.equal(describeDexRevert('0x747a60fb'), 'The tick size must be greater than zero.');
assert.equal(describeDexRevert('0xdeadbeef'), null);

// ── live registry ─────────────────────────────────────────────────────────────
const [maxFeeResult] = await rpcBatch([
  dexCall(DEX_CONTRACTS.registry, encodeDexNoArgs(DEX_SELECTOR.maxLpFeeRatePpm)),
]);
const maxFeePpm = decodeDexUint32(maxFeeResult);
assert.ok(maxFeePpm !== null && maxFeePpm > 0n, 'the registry should expose an LP fee ceiling');

const pools = await readSpotPoolsForPair(computePairId(SER9, IDENTITY)!);
assert.ok(Array.isArray(pools), 'getSpotPools should decode as an address array');

// A dry run must return the pool address the registry would deploy, without writing.
const okSimulation = await simulateDexWrite(
  SIMULATION_SENDER,
  DEX_CONTRACTS.registry,
  encodeCreateSpotPool(SER9, IDENTITY, 3_000n, 1n),
);
assert.ok(okSimulation.ok, `createSpotPool dry run should succeed: ${okSimulation.error ?? ''}`);
assert.match(okSimulation.returnData ?? '', /^0x0{24}[0-9a-f]{40}$/, 'the dry run returns a pool address');

// A zero tick size is the registry's documented rejection, and it must read as prose.
const badTick = await simulateDexWrite(
  SIMULATION_SENDER,
  DEX_CONTRACTS.registry,
  encodeCreateSpotPool(SER9, IDENTITY, 3_000n, 0n),
);
assert.equal(badTick.ok, false);
assert.equal(badTick.error, 'The tick size must be greater than zero.');

const badFee = await simulateDexWrite(
  SIMULATION_SENDER,
  DEX_CONTRACTS.registry,
  encodeCreateSpotPool(SER9, IDENTITY, maxFeePpm + 1n, 1n),
);
assert.equal(badFee.ok, false, 'a fee above the ceiling must not simulate');

// ── live orderbook ────────────────────────────────────────────────────────────
const [nextOrderIdResult] = await rpcBatch([
  dexCall(DEX_CONTRACTS.orderbook, encodeDexNoArgs(DEX_SELECTOR.nextOrderId)),
]);
const nextOrderId = decodeDexUint(nextOrderIdResult);
assert.ok(nextOrderId !== null && nextOrderId >= 1n, 'order ids start at one');
assert.deepEqual(await readOrderWindow(1n, 10), [], 'an empty book has no order slots to read');
const orderWindow = await readOrderWindow(nextOrderId, 10);
assert.ok(orderWindow.length <= 10);

// Auto-wrap arithmetic: MON above the gas reserve backs a WMON spend 1:1.
const WMON = { address: TOKENS.wmon.toUpperCase() }; // checksum casing must not matter
const SER9_TOKEN = { address: SER9 };
const ONE = 10n ** 18n;
const RESERVE = MON_NATIVE_GAS_RESERVE;

assert.equal(wrappableMon(WMON, RESERVE + ONE), ONE, 'MON above the reserve is wrappable');
assert.equal(wrappableMon(WMON, RESERVE), 0n, 'the reserve itself is never wrapped');
assert.equal(wrappableMon(WMON, null), 0n, 'an unread MON balance wraps nothing');
assert.equal(wrappableMon(SER9_TOKEN, RESERVE + ONE), 0n, 'only WMON is backed by native MON');
assert.equal(wrappableMon(null, RESERVE + ONE), 0n, 'an unknown token is backed by nothing');

assert.equal(spendableBalance(WMON, 2n * ONE, RESERVE + ONE), 3n * ONE, 'MAX spans WMON plus wrappable MON');
assert.equal(spendableBalance(SER9_TOKEN, 2n * ONE, RESERVE + ONE), 2n * ONE, 'a non-WMON MAX is the ERC20 balance');
assert.equal(spendableBalance(WMON, null, RESERVE + ONE), null, 'an unread balance has no MAX');

assert.equal(monWrapShortfall(WMON, 3n * ONE, 2n * ONE, RESERVE + ONE), null, 'a covered spend wraps nothing');
assert.equal(monWrapShortfall(WMON, 2n * ONE, 2n * ONE, RESERVE + ONE), null, 'an exactly covered spend wraps nothing');
assert.equal(monWrapShortfall(WMON, 2n * ONE, 3n * ONE, RESERVE + ONE), ONE, 'the shortfall is wrapped, not the whole spend');
// MAX fills the amount with the full spendable balance, which must stay wrappable.
assert.equal(monWrapShortfall(WMON, 2n * ONE, spendableBalance(WMON, 2n * ONE, RESERVE + ONE), RESERVE + ONE), ONE, 'MAX stays coverable');
assert.equal(monWrapShortfall(WMON, 2n * ONE, 4n * ONE, RESERVE + ONE), null, 'a gap wider than the wrappable MON is refused');
assert.equal(monWrapShortfall(WMON, 2n * ONE, 3n * ONE, RESERVE), null, 'spending the gas reserve is refused');
assert.equal(monWrapShortfall(SER9_TOKEN, 2n * ONE, 3n * ONE, RESERVE + ONE), null, 'a non-WMON shortfall is never wrapped');

// Auto-wrap calls `deposit()` on WMON with the MON shortfall as msg.value.
const depositSignature = `0x${Buffer.from('deposit()', 'utf8').toString('hex')}`;
assert.equal(
  keccak256Hex(depositSignature).slice(0, 10),
  DEX_SELECTOR.deposit,
  'the WMON wrap selector must be keccak256("deposit()")',
);
assert.equal(encodeDexNoArgs(DEX_SELECTOR.deposit), DEX_SELECTOR.deposit, 'deposit() takes no arguments');

// SER9/IDENTITY has no pool, so it has no book, and the order must be refused.
const noBook = await simulateDexWrite(
  SIMULATION_SENDER,
  DEX_CONTRACTS.orderbook,
  encodePlaceOrder(PAIR_ID, DEX_ORDER_SIDE.buy, 10n ** 18n, 10n ** 18n, 4_000_000_000n),
);
assert.equal(noBook.ok, false, 'placing on an uninitialised book must revert');

console.log(
  'ok — max lp fee', maxFeePpm.toString(), 'ppm',
  '| pools for SER9/IDENTITY', pools!.length,
  '| dry-run pool', okSimulation.returnData?.slice(-40),
  '| next order id', nextOrderId.toString(),
);
