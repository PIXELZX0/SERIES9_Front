/**
 * Read side of the DEX. Every function here is a pure "chain → plain object"
 * loader built on batched `eth_call`s; React state lives in the hooks.
 */
import { MONAD, normalizeTokenImageUri, rpcBatch } from '../chain.ts';
import {
  asAddress,
  asBool,
  asInt,
  asString,
  asUint,
  dynamicArray,
  encodeFunction,
  wordToAddress,
  words,
  type AbiValue,
} from './abi.ts';
import { DEX, NATIVE_MON, POSITION_SCAN_LIMIT, normalizeAddress, sameAddress, type TokenInfo } from './config.ts';

type RpcCall = { method: string; params: unknown[] };

const BATCH_LIMIT = 60;

export function call(to: string, signature: string, args: AbiValue[] = []): RpcCall {
  return { method: 'eth_call', params: [{ to, data: encodeFunction(signature, args) }, 'latest'] };
}

/** `rpcBatch`, split into RPC-friendly chunks. Failed calls resolve to null. */
export async function batch(calls: RpcCall[], signal?: AbortSignal): Promise<unknown[]> {
  if (calls.length <= BATCH_LIMIT) return rpcBatch(calls, signal);
  const chunks: RpcCall[][] = [];
  for (let index = 0; index < calls.length; index += BATCH_LIMIT) chunks.push(calls.slice(index, index + BATCH_LIMIT));
  const results = await Promise.all(chunks.map((chunk) => rpcBatch(chunk, signal)));
  return results.flat();
}

// ─────────────────── registry ───────────────────

export type RegistryStatus = {
  ready: boolean;
  paused: boolean | null;
  guardian: string | null;
  treasury: string | null;
  /** Human-readable wiring problems; empty when everything matches the configured deployment. */
  mismatches: string[];
};

export async function readRegistry(signal?: AbortSignal): Promise<RegistryStatus> {
  const results = await batch([
    call(DEX.registry, 'paused()'),
    call(DEX.registry, 'guardian()'),
    call(DEX.registry, 'treasury()'),
    call(DEX.registry, 'spotPoolFactory()'),
    call(DEX.registry, 'perpPoolFactory()'),
    call(DEX.router, 'registry()'),
    call(DEX.positionManager, 'registry()'),
  ], signal);
  const paused = asBool(results[0]);
  const treasury = asAddress(results[2]);
  const mismatches: string[] = [];
  const expect = (value: string | null, target: string, label: string) => {
    if (value !== null && !sameAddress(value, target)) mismatches.push(label);
  };
  expect(treasury, DEX.treasury, 'treasury');
  expect(asAddress(results[3]), DEX.spotPoolFactory, 'spot pool factory');
  expect(asAddress(results[4]), DEX.perpPoolFactory, 'perp pool factory');
  expect(asAddress(results[5]), DEX.registry, 'router');
  expect(asAddress(results[6]), DEX.registry, 'position manager');
  return {
    ready: paused !== null,
    paused,
    guardian: asAddress(results[1]),
    treasury,
    mismatches,
  };
}

// ─────────────────── tokens ───────────────────

const tokenCache = new Map<string, TokenInfo>();

export function cacheToken(token: TokenInfo): void {
  tokenCache.set(token.address.toLowerCase(), token);
}

export function cachedToken(address: string): TokenInfo | null {
  return tokenCache.get(address.toLowerCase()) ?? null;
}

/** symbol / decimals / name / ERC-20M `image()` for tokens not already known. */
export async function readTokens(addresses: string[], signal?: AbortSignal): Promise<TokenInfo[]> {
  const unknown = [...new Set(addresses.map((address) => address.toLowerCase()))]
    .filter((address) => !tokenCache.has(address) && normalizeAddress(address) && address !== NATIVE_MON.toLowerCase());
  if (unknown.length > 0) {
    const results = await batch(unknown.flatMap((address) => [
      call(address, 'symbol()'),
      call(address, 'decimals()'),
      call(address, 'name()'),
      call(address, 'image()'),
    ]), signal);
    unknown.forEach((address, index) => {
      const decimals = asUint(results[index * 4 + 1]);
      if (decimals === null || decimals > 36n) return;
      tokenCache.set(address, {
        address: normalizeAddress(address) ?? address,
        symbol: asString(results[index * 4]) ?? `${address.slice(0, 6)}…`,
        decimals: Number(decimals),
        name: asString(results[index * 4 + 2]) ?? undefined,
        logo: normalizeTokenImageUri(asString(results[index * 4 + 3])),
      });
    });
  }
  return addresses.map((address) => tokenCache.get(address.toLowerCase())).filter((token): token is TokenInfo => !!token);
}

// ─────────────────── markets ───────────────────

export type SpotPoolInfo = {
  address: string;
  pair: string;
  token0: string;
  token1: string;
  feePpm: bigint;
  reserve0: bigint;
  reserve1: bigint;
  totalShares: bigint;
};

export type PairInfo = {
  address: string;
  base: TokenInfo;
  quote: TokenInfo;
  spotPools: SpotPoolInfo[];
  perpPools: string[];
  customSpotPools: bigint;
};

export type Universe = {
  pairs: PairInfo[];
};

function pairCombos(tokens: TokenInfo[]): Array<[TokenInfo, TokenInfo]> {
  const combos: Array<[TokenInfo, TokenInfo]> = [];
  const erc20 = tokens.filter((token) => !token.native);
  for (let left = 0; left < erc20.length; left += 1) {
    for (let right = left + 1; right < erc20.length; right += 1) combos.push([erc20[left], erc20[right]]);
  }
  return combos;
}

/**
 * The registry cannot enumerate pairs, so markets are discovered from the
 * token list: every combination is looked up with `getPair`, then each live
 * pair's pools are listed and their reserves read.
 */
export async function readUniverse(tokens: TokenInfo[], extraPairs: string[], signal?: AbortSignal): Promise<Universe> {
  const combos = pairCombos(tokens);
  const lookups = await batch(combos.map(([a, b]) => call(DEX.registry, 'getPair(address,address)', [a.address, b.address])), signal);
  const pairAddresses = new Set<string>();
  lookups.forEach((result) => {
    const pair = asAddress(result);
    if (pair) pairAddresses.add(pair.toLowerCase());
  });
  extraPairs.forEach((pair) => pairAddresses.add(pair.toLowerCase()));
  const pairs = [...pairAddresses];
  if (pairs.length === 0) return { pairs: [] };

  const heads = await batch(pairs.flatMap((pair) => [
    call(pair, 'base()'),
    call(pair, 'quote()'),
    call(pair, 'spotPoolsLength()'),
    call(pair, 'perpPoolsLength()'),
    call(pair, 'customSpotPools()'),
    call(DEX.registry, 'isPair(address)', [pair]),
  ]), signal);

  const listCalls: RpcCall[] = [];
  const listIndex: Array<{ pair: number; kind: 'spot' | 'perp' }> = [];
  const meta = pairs.map((pair, index) => {
    const base = asAddress(heads[index * 6]);
    const quote = asAddress(heads[index * 6 + 1]);
    const spotCount = Number(asUint(heads[index * 6 + 2]) ?? 0n);
    const perpCount = Number(asUint(heads[index * 6 + 3]) ?? 0n);
    const legit = asBool(heads[index * 6 + 5]) === true;
    if (legit) {
      for (let slot = 0; slot < Math.min(spotCount, 16); slot += 1) {
        listCalls.push(call(pair, 'spotPools(uint256)', [BigInt(slot)]));
        listIndex.push({ pair: index, kind: 'spot' });
      }
      for (let slot = 0; slot < Math.min(perpCount, 32); slot += 1) {
        listCalls.push(call(pair, 'perpPools(uint256)', [BigInt(slot)]));
        listIndex.push({ pair: index, kind: 'perp' });
      }
    }
    return { pair, base, quote, legit, customSpotPools: asUint(heads[index * 6 + 4]) ?? 0n };
  });

  const [lists, tokenInfos] = await Promise.all([
    batch(listCalls, signal),
    readTokens(meta.flatMap((entry) => [entry.base, entry.quote]).filter((address): address is string => !!address), signal),
  ]);
  void tokenInfos;

  const spotByPair = new Map<number, string[]>();
  const perpByPair = new Map<number, string[]>();
  lists.forEach((result, index) => {
    const pool = asAddress(result);
    if (!pool) return;
    const { pair, kind } = listIndex[index];
    const target = kind === 'spot' ? spotByPair : perpByPair;
    target.set(pair, [...(target.get(pair) ?? []), pool]);
  });

  const spotPools = [...spotByPair.entries()].flatMap(([pair, pools]) => pools.map((pool) => ({ pair, pool })));
  const poolReads = await batch(spotPools.flatMap(({ pool }) => [
    call(pool, 'lpFeeRatePpm()'),
    call(pool, 'getReserves()'),
    call(pool, 'totalShares()'),
  ]), signal);

  const poolsByPair = new Map<number, SpotPoolInfo[]>();
  spotPools.forEach(({ pair, pool }, index) => {
    const reserves = words(poolReads[index * 3 + 1]);
    const entry = meta[pair];
    if (!entry.base || !entry.quote) return;
    const info: SpotPoolInfo = {
      address: pool,
      pair: entry.pair,
      token0: entry.base,
      token1: entry.quote,
      feePpm: asUint(poolReads[index * 3]) ?? 0n,
      reserve0: reserves?.[0] ?? 0n,
      reserve1: reserves?.[1] ?? 0n,
      totalShares: asUint(poolReads[index * 3 + 2]) ?? 0n,
    };
    poolsByPair.set(pair, [...(poolsByPair.get(pair) ?? []), info]);
  });

  const result: PairInfo[] = [];
  meta.forEach((entry, index) => {
    if (!entry.legit || !entry.base || !entry.quote) return;
    const base = cachedToken(entry.base);
    const quote = cachedToken(entry.quote);
    if (!base || !quote) return;
    result.push({
      address: normalizeAddress(entry.pair) ?? entry.pair,
      base,
      quote,
      spotPools: (poolsByPair.get(index) ?? []).sort((left, right) => Number(left.feePpm - right.feePpm)),
      perpPools: perpByPair.get(index) ?? [],
      customSpotPools: entry.customSpotPools,
    });
  });
  return { pairs: result };
}

/** Deepest pool's price, which is what a small swap would see. */
export function pairMidX18(pair: PairInfo): bigint | null {
  const deepest = [...pair.spotPools].filter((pool) => pool.reserve0 > 0n).sort((left, right) => (right.reserve1 > left.reserve1 ? 1 : -1))[0];
  return deepest ? (deepest.reserve1 * 10n ** 18n) / deepest.reserve0 : null;
}

export async function readPairAddress(tokenA: string, tokenB: string, signal?: AbortSignal): Promise<string | null> {
  const [result] = await batch([call(DEX.registry, 'getPair(address,address)', [tokenA, tokenB])], signal);
  return asAddress(result);
}

// ─────────────────── order book ───────────────────

export type BookLevel = { priceX18: bigint; totalBase: bigint };

export type Book = {
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: bigint;
  bestAsk: bigint;
};

function decodeLevels(result: unknown): BookLevel[] {
  const all = words(result);
  if (!all) return [];
  const prices = dynamicArray(all, 0);
  const sizes = dynamicArray(all, 1);
  if (!prices || !sizes || prices.length !== sizes.length) return [];
  return prices.map((price, index) => ({ priceX18: price[0], totalBase: sizes[index][0] }));
}

export async function readBook(pair: string, depth = 14, signal?: AbortSignal): Promise<Book> {
  const results = await batch([
    call(pair, 'levels(uint8,uint256,uint256)', [0n, 0n, BigInt(depth)]),
    call(pair, 'levels(uint8,uint256,uint256)', [1n, 0n, BigInt(depth)]),
    call(pair, 'bestBidPrice()'),
    call(pair, 'bestAskPrice()'),
  ], signal);
  return {
    bids: decodeLevels(results[0]),
    asks: decodeLevels(results[1]),
    bestBid: asUint(results[2]) ?? 0n,
    bestAsk: asUint(results[3]) ?? 0n,
  };
}

export const ORDER_SIDE = { buy: 0, sell: 1 } as const;
export const ORDER_STATUS = ['open', 'filled', 'cancelled', 'expired'] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

export type Order = {
  id: bigint;
  maker: string;
  side: 'buy' | 'sell';
  status: OrderStatus;
  expiry: bigint;
  priceX18: bigint;
  amountBase: bigint;
  filledBase: bigint;
  escrowRemaining: bigint;
};

const ORDER_WORDS = 9;

function decodeOrderWords(id: bigint, chunk: bigint[]): Order | null {
  const maker = wordToAddress(chunk[0]);
  if (!maker || chunk[1] > 1n || chunk[2] > 3n) return null;
  return {
    id,
    maker,
    side: chunk[1] === 0n ? 'buy' : 'sell',
    status: ORDER_STATUS[Number(chunk[2])],
    expiry: chunk[3],
    priceX18: chunk[4],
    amountBase: chunk[5],
    filledBase: chunk[6],
    escrowRemaining: chunk[7],
  };
}

/** The wallet's newest `count` orders on `pair`, newest first (closed orders included). */
export async function readMyOrders(pair: string, wallet: string, count = 40, signal?: AbortSignal): Promise<Order[]> {
  const [lengthResult] = await batch([call(pair, 'ordersOfLength(address)', [wallet])], signal);
  const length = asUint(lengthResult) ?? 0n;
  if (length === 0n) return [];
  const start = length > BigInt(count) ? length - BigInt(count) : 0n;
  const [page] = await batch([call(pair, 'ordersOf(address,uint256,uint256)', [wallet, start, BigInt(count)])], signal);
  const all = words(page);
  if (!all) return [];
  const ids = dynamicArray(all, 0);
  const orders = dynamicArray(all, 1, ORDER_WORDS);
  if (!ids || !orders || ids.length !== orders.length) return [];
  return orders
    .map((chunk, index) => decodeOrderWords(ids[index][0], chunk))
    .filter((order): order is Order => order !== null)
    .reverse();
}

// ─────────────────── wallet ───────────────────

export type Allowance = { token: string; spender: string };

export type WalletBalances = {
  native: bigint | null;
  balances: Map<string, bigint>;
  allowances: Map<string, bigint>;
};

export function allowanceKey(token: string, spender: string): string {
  return `${token.toLowerCase()}:${spender.toLowerCase()}`;
}

export async function readWallet(wallet: string, tokens: string[], allowances: Allowance[], signal?: AbortSignal): Promise<WalletBalances> {
  const erc20 = [...new Set(tokens.map((token) => token.toLowerCase()))].filter((token) => token !== NATIVE_MON.toLowerCase());
  const results = await batch([
    { method: 'eth_getBalance', params: [wallet, 'latest'] },
    ...erc20.map((token) => call(token, 'balanceOf(address)', [wallet])),
    ...allowances.map(({ token, spender }) => call(token, 'allowance(address,address)', [wallet, spender])),
  ], signal);
  const balances = new Map<string, bigint>();
  erc20.forEach((token, index) => {
    const value = asUint(results[index + 1]);
    if (value !== null) balances.set(token, value);
  });
  const allowanceMap = new Map<string, bigint>();
  allowances.forEach(({ token, spender }, index) => {
    const value = asUint(results[1 + erc20.length + index]);
    if (value !== null) allowanceMap.set(allowanceKey(token, spender), value);
  });
  const native = typeof results[0] === 'string' ? BigInt(results[0] as string) : null;
  if (native !== null) balances.set(NATIVE_MON.toLowerCase(), native);
  return { native, balances, allowances: allowanceMap };
}

// ─────────────────── swap routing ───────────────────

export type Route = {
  pools: SpotPoolInfo[];
  tokens: string[];
  amountOut: bigint;
};

/**
 * Candidate paths from the known pools: every direct pool, plus every
 * two-hop path through a shared token. Each is priced by the router's own
 * `quoteExactInput`, so the UI never re-implements pool math for quoting.
 */
export function candidatePaths(pairs: PairInfo[], tokenIn: string, tokenOut: string): Array<{ pools: SpotPoolInfo[]; tokens: string[] }> {
  const live = pairs.flatMap((pair) => pair.spotPools).filter((pool) => pool.reserve0 > 0n && pool.reserve1 > 0n);
  const touches = (pool: SpotPoolInfo, token: string) => sameAddress(pool.token0, token) || sameAddress(pool.token1, token);
  const other = (pool: SpotPoolInfo, token: string) => (sameAddress(pool.token0, token) ? pool.token1 : pool.token0);
  const paths: Array<{ pools: SpotPoolInfo[]; tokens: string[] }> = [];
  for (const first of live) {
    if (!touches(first, tokenIn)) continue;
    const mid = other(first, tokenIn);
    if (sameAddress(mid, tokenOut)) {
      paths.push({ pools: [first], tokens: [tokenIn, tokenOut] });
      continue;
    }
    for (const second of live) {
      if (second === first || !touches(second, mid) || !sameAddress(other(second, mid), tokenOut)) continue;
      paths.push({ pools: [first, second], tokens: [tokenIn, mid, tokenOut] });
    }
  }
  return paths.slice(0, 40);
}

export async function quoteRoutes(
  pairs: PairInfo[],
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  signal?: AbortSignal,
): Promise<Route[]> {
  const paths = candidatePaths(pairs, tokenIn, tokenOut);
  if (paths.length === 0 || amountIn <= 0n) return [];
  const results = await batch(paths.map((path) => call(
    DEX.router,
    'quoteExactInput(address[],address,uint256)',
    [path.pools.map((pool) => pool.address), tokenIn, amountIn],
  )), signal);
  return paths
    .map((path, index) => ({ ...path, amountOut: asUint(results[index]) ?? 0n }))
    .filter((route) => route.amountOut > 0n)
    .sort((left, right) => (right.amountOut > left.amountOut ? 1 : right.amountOut < left.amountOut ? -1 : left.pools.length - right.pools.length));
}

// ─────────────────── LP positions (ERC-721) ───────────────────

export type LpPosition = {
  tokenId: bigint;
  pool: string;
  isSpot: boolean;
  liquidity: bigint;
  pair: string | null;
  feePpm: bigint;
  totalShares: bigint;
  /** Spot: token0/token1 and the position's share of reserves. */
  token0: string | null;
  token1: string | null;
  amount0: bigint;
  amount1: bigint;
  /** Perp LP: quote token and the position's share of LP equity. */
  quoteToken: string | null;
  quoteValue: bigint;
};

/**
 * `DexPositionManager` is a plain ERC-721 (not enumerable), so the wallet's
 * positions are found by checking `ownerOf` over the newest ids.
 */
export async function readPositions(wallet: string, signal?: AbortSignal): Promise<LpPosition[]> {
  const [nextResult, balanceResult] = await batch([
    call(DEX.positionManager, 'nextTokenId()'),
    call(DEX.positionManager, 'balanceOf(address)', [wallet]),
  ], signal);
  const next = asUint(nextResult) ?? 1n;
  const held = asUint(balanceResult) ?? 0n;
  if (next <= 1n || held === 0n) return [];
  const lowest = next - 1n > BigInt(POSITION_SCAN_LIMIT) ? next - BigInt(POSITION_SCAN_LIMIT) : 1n;
  const ids: bigint[] = [];
  for (let id = next - 1n; id >= lowest; id -= 1n) ids.push(id);
  const owners = await batch(ids.map((id) => call(DEX.positionManager, 'ownerOf(uint256)', [id])), signal);
  const mine = ids.filter((_, index) => sameAddress(asAddress(owners[index]), wallet));
  if (mine.length === 0) return [];

  const raw = await batch(mine.map((id) => call(DEX.positionManager, 'positions(uint256)', [id])), signal);
  const decoded = mine.map((id, index) => {
    const all = words(raw[index]);
    return all && all.length >= 3 ? { id, pool: wordToAddress(all[0]), isSpot: all[1] === 1n, liquidity: all[2] } : null;
  }).filter((entry): entry is { id: bigint; pool: string; isSpot: boolean; liquidity: bigint } => !!entry && !!entry.pool);

  const details = await batch(decoded.flatMap((entry) => entry.isSpot
    ? [
        call(entry.pool, 'token0()'),
        call(entry.pool, 'token1()'),
        call(entry.pool, 'getReserves()'),
        call(entry.pool, 'totalShares()'),
        call(entry.pool, 'lpFeeRatePpm()'),
        call(DEX.registry, 'poolToPair(address)', [entry.pool]),
      ]
    : [
        call(entry.pool, 'quoteToken()'),
        call(entry.pool, 'baseToken()'),
        call(entry.pool, 'lpEquity()'),
        call(entry.pool, 'totalShares()'),
        call(entry.pool, 'lpFeeRatePpm()'),
        call(DEX.registry, 'poolToPair(address)', [entry.pool]),
      ]), signal);

  const positions = decoded.map((entry, index): LpPosition => {
    const at = (offset: number) => details[index * 6 + offset];
    const totalShares = asUint(at(3)) ?? 0n;
    const share = (amount: bigint) => (totalShares > 0n ? (amount * entry.liquidity) / totalShares : 0n);
    if (entry.isSpot) {
      const reserves = words(at(2));
      return {
        tokenId: entry.id, pool: entry.pool, isSpot: true, liquidity: entry.liquidity, pair: asAddress(at(5)),
        feePpm: asUint(at(4)) ?? 0n, totalShares,
        token0: asAddress(at(0)), token1: asAddress(at(1)),
        amount0: share(reserves?.[0] ?? 0n), amount1: share(reserves?.[1] ?? 0n),
        quoteToken: null, quoteValue: 0n,
      };
    }
    return {
      tokenId: entry.id, pool: entry.pool, isSpot: false, liquidity: entry.liquidity, pair: asAddress(at(5)),
      feePpm: asUint(at(4)) ?? 0n, totalShares,
      token0: asAddress(at(1)), token1: asAddress(at(0)),
      amount0: 0n, amount1: 0n,
      quoteToken: asAddress(at(0)), quoteValue: share(asUint(at(2)) ?? 0n),
    };
  });
  await readTokens(positions.flatMap((position) => [position.token0, position.token1]).filter((address): address is string => !!address), signal);
  return positions;
}

// ─────────────────── perps ───────────────────

export type PerpSide = {
  sizeBase: bigint;
  marginQuote: bigint;
  entryNotional: bigint;
  equity: bigint;
};

export type PerpMarket = {
  address: string;
  pair: string;
  spotPool: string;
  base: TokenInfo;
  quote: TokenInfo;
  feePpm: bigint;
  maxLeverageX: bigint;
  maintenanceMarginBps: bigint;
  liquidationFeeBps: bigint;
  maxUtilizationBps: bigint;
  fundingCoeffPpmPerHour: bigint;
  markX18: bigint;
  twapTsCheckpoint: bigint;
  lpEquity: bigint;
  totalLiquidity: bigint;
  totalShares: bigint;
  longSizeBase: bigint;
  shortSizeBase: bigint;
  longOpenNotional: bigint;
  shortOpenNotional: bigint;
  long: PerpSide | null;
  short: PerpSide | null;
};

const PERP_FIELDS = [
  'pair()', 'spotPool()', 'baseToken()', 'quoteToken()', 'lpFeeRatePpm()', 'maxLeverageX()', 'maintenanceMarginBps()',
  'liquidationFeeBps()', 'maxUtilizationBps()', 'fundingCoeffPpmPerHour()', 'cachedMarkX18()', 'twapTsCheckpoint()',
  'lpEquity()', 'totalLiquidity()', 'totalShares()', 'longSizeBase()', 'shortSizeBase()', 'longOpenNotional()',
  'shortOpenNotional()',
] as const;

export async function readPerpMarkets(pools: string[], wallet: string | null, signal?: AbortSignal): Promise<PerpMarket[]> {
  if (pools.length === 0) return [];
  const perWallet = wallet ? 4 : 0;
  const stride = PERP_FIELDS.length + perWallet;
  const results = await batch(pools.flatMap((pool) => [
    ...PERP_FIELDS.map((field) => call(pool, field)),
    ...(wallet
      ? [
          call(pool, 'positions(address,bool)', [wallet, true]),
          call(pool, 'positions(address,bool)', [wallet, false]),
          call(pool, 'equityOf(address,bool)', [wallet, true]),
          call(pool, 'equityOf(address,bool)', [wallet, false]),
        ]
      : []),
  ]), signal);

  const baseAddresses = pools.flatMap((_, index) => [asAddress(results[index * stride + 2]), asAddress(results[index * stride + 3])])
    .filter((address): address is string => !!address);
  await readTokens(baseAddresses, signal);

  const markets: PerpMarket[] = [];
  pools.forEach((pool, index) => {
    const at = (offset: number) => results[index * stride + offset];
    const uint = (offset: number) => asUint(at(offset)) ?? 0n;
    const baseAddress = asAddress(at(2));
    const quoteAddress = asAddress(at(3));
    const base = baseAddress ? cachedToken(baseAddress) : null;
    const quote = quoteAddress ? cachedToken(quoteAddress) : null;
    const pair = asAddress(at(0));
    const spotPool = asAddress(at(1));
    if (!base || !quote || !pair || !spotPool) return;
    const side = (positionOffset: number, equityOffset: number): PerpSide | null => {
      if (!wallet) return null;
      const all = words(at(positionOffset));
      if (!all || all.length < 4 || all[0] === 0n) return null;
      return { sizeBase: all[0], marginQuote: all[1], entryNotional: all[2], equity: asInt(at(equityOffset)) ?? 0n };
    };
    const n = PERP_FIELDS.length;
    markets.push({
      address: pool, pair, spotPool, base, quote,
      feePpm: uint(4), maxLeverageX: uint(5), maintenanceMarginBps: uint(6), liquidationFeeBps: uint(7),
      maxUtilizationBps: uint(8), fundingCoeffPpmPerHour: uint(9), markX18: uint(10), twapTsCheckpoint: uint(11),
      lpEquity: uint(12), totalLiquidity: uint(13), totalShares: uint(14),
      longSizeBase: uint(15), shortSizeBase: uint(16), longOpenNotional: uint(17), shortOpenNotional: uint(18),
      long: side(n, n + 2),
      short: side(n + 1, n + 3),
    });
  });
  return markets;
}

// ─────────────────── simulation ───────────────────

export type Simulation = { ok: true; returnData: string } | { ok: false; error: string; data: string | null };

/**
 * `eth_call` a write from the wallet before it is signed. Uses its own request
 * rather than `rpcBatch` so the revert payload survives for decoding.
 */
export async function simulate(from: string, to: string, data: string, value?: bigint, signal?: AbortSignal): Promise<Simulation> {
  const tx: Record<string, string> = { from, to, data };
  if (value !== undefined && value > 0n) tx.value = `0x${value.toString(16)}`;
  let body: { result?: unknown; error?: { message?: unknown; data?: unknown } };
  try {
    const response = await fetch(MONAD.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [tx, 'latest'] }),
      signal,
    });
    if (!response.ok) return { ok: false, error: `Simulation RPC ${response.status}.`, data: null };
    body = await response.json() as typeof body;
  } catch {
    return { ok: false, error: 'The simulation request to Monad failed.', data: null };
  }
  if (body.error) {
    const data = typeof body.error.data === 'string'
      ? body.error.data
      : typeof (body.error.data as { data?: unknown } | undefined)?.data === 'string'
        ? (body.error.data as { data: string }).data
        : null;
    return { ok: false, error: typeof body.error.message === 'string' ? body.error.message : 'The simulation reverted.', data };
  }
  return typeof body.result === 'string' ? { ok: true, returnData: body.result } : { ok: false, error: 'Empty simulation result.', data: null };
}
