/**
 * Self-check for the DEX data layer.
 *
 *   node src/dex/dex.check.ts
 *
 * Always checks selector derivation, calldata layout and the price grid.
 * With DEX_CHECK_ENV pointing at a JSON of local deployment addresses (see
 * the keys read below) and DEX_CHECK_RPC at a node running that deployment,
 * it also runs every reader against real contracts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asString, dynamicArray, encodeFunction, selector, words } from './abi.ts';
import { DEX, DEFAULT_TOKENS } from './config.ts';
import { formatPriceX18, formatSig, parseAmount, parsePriceToX18, priceIsValid, snapPriceToGrid, tickSizeAt } from './math.ts';

// Selectors as reported by `forge inspect … methodIdentifiers` on SERIES9DEX.
const EXPECTED: Record<string, string> = {
  'createPair(address,address)': '0xc9c65396',
  'getPair(address,address)': '0xe6a43905',
  'paused()': '0x5c975abb',
  'createSpotPool(uint32)': '0x19c2adf2',
  'createPerpPool(address,address,uint32,(uint32,uint32,uint32,uint32,uint64))': '0xef8e9c1d',
  'placeOrder(uint8,uint256,uint256,uint64,uint256)': '0x3c2e3faf',
  'levels(uint8,uint256,uint256)': '0xbe823a30',
  'ordersOf(address,uint256,uint256)': '0x70b453a9',
  'cancelOrder(uint256)': '0x514fcac7',
  'matchOrders(uint256)': '0x5a449d1e',
  'swapExactTokensForTokens(address[],address,uint256,uint256,address,uint256)': '0x8485b4cb',
  'quoteExactInput(address[],address,uint256)': '0x76278b93',
  'mintSpot(address,uint256,uint256,uint256,uint256,address,uint256)': '0x872d488e',
  'decreaseSpot(uint256,uint256,uint256,uint256,address,uint256)': '0x43fb47d0',
  'mintPerp(address,uint256,uint256,address,uint256)': '0xd2ce445d',
  'positions(uint256)': '0x99fbab88',
  'positions(address,bool)': '0xe494d2d4',
  'openPosition(bool,uint256,uint256)': '0xe3255731',
  'equityOf(address,bool)': '0xfe0745bb',
  'approve(address,uint256)': '0x095ea7b3',
};
for (const [signature, expected] of Object.entries(EXPECTED)) assert.equal(selector(signature), expected, signature);
assert.equal(selector('Paused()'), '0x9e87fac8');

// Dynamic array head/tail layout.
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const swap = encodeFunction('swapExactTokensForTokens(address[],address,uint256,uint256,address,uint256)', [[A, B], A, 5n, 4n, B, 9n]);
assert.equal(swap.length, 10 + 64 * 9);
assert.equal(BigInt(`0x${swap.slice(10, 74)}`), 192n, 'array offset follows the six head words');
assert.equal(BigInt(`0x${swap.slice(10 + 64 * 6, 10 + 64 * 7)}`), 2n, 'array length');

// Static tuple is inlined.
const perp = encodeFunction('createPerpPool(address,address,uint32,(uint32,uint32,uint32,uint32,uint64))', [A, B, 1000n, [20n, 300n, 100n, 8000n, 100n]]);
assert.equal(perp.length, 10 + 64 * 8);
assert.throws(() => encodeFunction('createSpotPool(uint32)', [2n ** 32n]));

// Return-data helpers.
const levelData = `0x${[64n, 160n, 2n, 5n, 4n, 2n, 7n, 8n].map((v) => v.toString(16).padStart(64, '0')).join('')}`;
const all = words(levelData)!;
assert.deepEqual(dynamicArray(all, 0), [[5n], [4n]]);
assert.deepEqual(dynamicArray(all, 1), [[7n], [8n]]);
assert.equal(asString('0x5553444300000000000000000000000000000000000000000000000000000000'), 'USDC');

// Price grid mirrors Pair.priceIsValid / tickSizeAt.
assert.equal(tickSizeAt(999_999n), 1n);
assert.equal(tickSizeAt(1_000_000n), 10n);
assert.equal(priceIsValid(123_456_000_000n), true);
assert.equal(priceIsValid(1_234_567n), false);
assert.equal(snapPriceToGrid(1_234_567n, 'down'), 1_234_560n);
assert.equal(snapPriceToGrid(1_234_567n, 'up'), 1_234_570n);
assert.equal(snapPriceToGrid(9_999_995n, 'up'), 10_000_000n);
// 1 SER9 (18 dp) = 0.42 USDC (6 dp) → 0.42e6 raw quote per 1e18 raw base, ×1e18.
assert.equal(parsePriceToX18('0.42', 18, 6), 420_000n);
assert.equal(formatPriceX18(420_000n, 18, 6), '0.42');
assert.equal(parseAmount('1.5', 6), 1_500_000n);
assert.equal(parseAmount('1.1234567', 6), null);
assert.equal(formatSig(123456789n, 6, 6), '123.456');
assert.equal(formatSig(1234n, 9, 3), '0.00000123');

console.log('dex.check: static checks passed');

const envPath = process.env.DEX_CHECK_ENV;
const rpc = process.env.DEX_CHECK_RPC;
if (envPath && rpc) {
  const env = JSON.parse(readFileSync(envPath, 'utf8')) as Record<string, string>;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    realFetch(String(input).includes('rpc.monad.xyz') ? rpc : input, init)) as typeof fetch;
  Object.assign(DEX, {
    registry: env.REG, treasury: env.TRE, spotPoolFactory: env.SPF, perpPoolFactory: env.PPF, positionManager: env.PM, router: env.RT,
  });
  DEFAULT_TOKENS[0].address = env.SER9;
  DEFAULT_TOKENS[1].address = env.WMON;
  DEFAULT_TOKENS[2].address = env.USDC;

  const reads = await import('./reads.ts');
  DEFAULT_TOKENS.forEach(reads.cacheToken);
  const registry = await reads.readRegistry();
  assert.equal(registry.paused, false);
  assert.deepEqual(registry.mismatches, []);

  const universe = await reads.readUniverse(DEFAULT_TOKENS, []);
  assert.ok(universe.pairs.length >= 3);
  const serUsdc = universe.pairs.find((pair) => pair.address.toLowerCase() === env.P_SU.toLowerCase())!;
  assert.ok(serUsdc, 'SER9/USDC pair discovered');
  assert.equal(serUsdc.spotPools.length, 1);
  assert.equal(serUsdc.perpPools.length, 1);
  const serWmon = universe.pairs.find((pair) => pair.address.toLowerCase() === env.P_SW.toLowerCase())!;
  const fees = serWmon.spotPools.map((pool) => pool.feePpm);
  assert.ok(fees.includes(500n) && fees.includes(3000n), 'seeded fee tiers listed');
  assert.deepEqual(fees, [...fees].sort((left, right) => Number(left - right)), 'pools sorted by fee');

  const routes = await reads.quoteRoutes(universe.pairs, env.SER9, env.USDC, 10n ** 21n);
  assert.ok(routes.length >= 2, 'direct and two-hop routes');
  assert.ok(routes[0].amountOut > 0n);
  console.log('best SER9→USDC route', routes[0].pools.length, 'hop(s), out', routes[0].amountOut);

  const wallet = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const positions = await reads.readPositions(wallet);
  assert.ok(positions.length >= 1, 'seeded position NFTs found');
  assert.ok(positions.some((position) => !position.isSpot && position.quoteValue > 0n));

  const book = await reads.readBook(env.P_SU);
  console.log('book', book.bids.length, 'bids', book.asks.length, 'asks');
  const orders = await reads.readMyOrders(env.P_SU, wallet);
  console.log('orders', orders.length);

  const perps = await reads.readPerpMarkets(serUsdc.perpPools, wallet);
  assert.equal(perps.length, 1);
  assert.equal(perps[0].maxLeverageX, 20n);
  assert.ok(perps[0].markX18 > 0n, 'mark seeded');
  console.log('perp mark', formatPriceX18(perps[0].markX18, perps[0].base.decimals, perps[0].quote.decimals));

  const balances = await reads.readWallet(wallet, [env.SER9, env.USDC], [{ token: env.SER9, spender: DEX.router }]);
  assert.ok((balances.balances.get(env.SER9.toLowerCase()) ?? 0n) > 0n);
  console.log('dex.check: live checks passed');
}
