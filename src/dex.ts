import {
  CONTRACTS,
  MONAD,
  encodeAddress,
  encodeCall,
  encodeUint,
  rpcBatch,
} from './chain.ts';

type RpcCall = { method: string; params: unknown[] };

const env: Record<string, string | undefined> = import.meta.env ?? {};
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const WORD_BYTES = 32;
const WORD_HEX_LENGTH = WORD_BYTES * 2;
const UINT256_LIMIT = 2n ** 256n;
const UINT32_LIMIT = 2n ** 32n;
const ADDRESS_LIMIT = 2n ** 160n;

export const DEX_CONTRACTS = {
  registry: CONTRACTS.dexRegistry,
  protocolTreasury: CONTRACTS.dexProtocolTreasury,
  orderbook: CONTRACTS.dexOrderbook,
  spotPoolFactory: CONTRACTS.dexSpotPoolFactory,
  perpPoolFactory: CONTRACTS.dexPerpPoolFactory,
  positionManager: CONTRACTS.dexPositionManager,
} as const;

export function normalizeDexAddress(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return ADDRESS_PATTERN.test(normalized) ? normalized : null;
}

export const DEX_CONFIG = {
  chainId: 143,
  pollIntervalMs: 10_000,
  spotPoolAddress: normalizeDexAddress(env.VITE_DEX_SPOT_POOL_ADDRESS),
} as const;

export const DEX_SELECTOR = {
  treasury: '0x61d027b3',
  orderbook: '0xc18b1d5e',
  spotPoolFactory: '0xa790eca8',
  perpPoolFactory: '0xeac05835',
  maxLpFeeRatePpm: '0x82ddaba0',
  isSpotPool: '0x7a49207f',
  poolPairId: '0xe0553ebc',
  registry: '0x7b103999',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  lpFeeRatePpm: '0xe657d184',
  pairId: '0xd1537cc5',
  getReserves: '0x0902f1ac',
  spotPriceX18: '0x440d4d76',
  getAmountOut: '0xca706bcf',
  bestBid: '0x5771f997',
  bestAsk: '0x7e3d8085',
  bookConfig: '0xa0edc33c',
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
  approve: '0x095ea7b3',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  swapExactIn: '0xa6220b66',
  positionManagerName: '0x06fdde03',
  positionManagerSymbol: '0x95d89b41',
  nextTokenId: '0x75794a3c',
  createSpotPool: '0x6267f2c2',
  getSpotPools: '0x7d9ce551',
  getPerpPools: '0xdba106a4',
  pairs: '0x673e0481',
  addLiquidity: '0xe0ab0772',
  removeLiquidity: '0xe39b0eb5',
  sharesOf: '0xf5eb42dc',
  totalShares: '0x3a98ef39',
  minimumLiquidity: '0xba9a7a56',
  protocolFees0: '0x47d792c5',
  protocolFees1: '0x6a2a507b',
  cancelOrder: '0x514fcac7',
  nextOrderId: '0x2a58b330',
  placeOrder: '0x6b8efc36',
  orders: '0xa85c38ef',
  levelOf: '0xbaa602c0',
} as const;

/** `Orderbook.placeOrder` takes the side as a two-member enum, not a bool. */
export const DEX_ORDER_SIDE = { buy: 0n, sell: 1n } as const;

/** `Order.status` as stored by the Orderbook. */
export const DEX_ORDER_STATUS = { open: 0, filled: 1, cancelled: 2 } as const;

/**
 * Custom-error selectors observed from live `eth_call` simulations against the
 * deployed registry and pool. They are the only way to turn a bare revert into a
 * sentence the trader can act on.
 */
export const DEX_ERROR_MESSAGE: Record<string, string> = {
  '0x5c6d7b73': 'Both sides of the pair are the same token.',
  '0x747a60fb': 'The tick size must be greater than zero.',
  '0xe30ce51e': 'The LP fee exceeds the registry maximum.',
  '0xad1991f5': 'A token address resolved to the zero address.',
  '0xd92e233d': 'A supplied address was the zero address.',
  '0x1f2a2005': 'The contract received a zero amount. Check balances, allowances, and that the tokens actually transfer.',
  '0xbb55fd27': 'The pool has no liquidity yet.',
  '0xea8e4eb5': 'The connected wallet is not authorised for this action.',
  '0x3ee5aeb5': 'The contract rejected a re-entrant call.',
  '0x2c5211c6': 'The order amount is not accepted. Check the balance actually transferred to the Orderbook.',
  '0x00bfc921': 'The limit price is not accepted by the book.',
  '0xd36c8500': 'The expiry must be a future timestamp.',
  '0x206931ef': 'That order is no longer open.',
  '0xb6081008': 'No Orderbook book exists for this pair yet.',
};

export function describeDexRevert(data: unknown): string | null {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  return DEX_ERROR_MESSAGE[data.slice(0, 10).toLowerCase()] ?? null;
}

export function dexCall(to: string, data: string): RpcCall {
  return { method: 'eth_call', params: [{ to, data }, 'latest'] };
}

export function dexSimulationCall(from: string, to: string, data: string): RpcCall {
  return { method: 'eth_call', params: [{ from, to, data }, 'latest'] };
}

export function encodeDexNoArgs(selector: string): string {
  return encodeCall(selector);
}

export function encodeIsSpotPool(pool: string): string {
  return encodeCall(DEX_SELECTOR.isSpotPool, [encodeAddress(pool)]);
}

export function encodePoolPairId(pool: string): string {
  return encodeCall(DEX_SELECTOR.poolPairId, [encodeAddress(pool)]);
}

export function encodePoolAmountOut(tokenIn: string, amountIn: bigint): string {
  return encodeCall(DEX_SELECTOR.getAmountOut, [encodeAddress(tokenIn), encodeUint(amountIn)]);
}

export function encodeOrderbookPairRead(selector: string, pairId: string): string {
  return encodeCall(selector, [encodeBytes32(pairId)]);
}

export function encodeErc20BalanceOf(owner: string): string {
  return encodeCall(DEX_SELECTOR.balanceOf, [encodeAddress(owner)]);
}

export function encodeErc20Allowance(owner: string, spender: string): string {
  return encodeCall(DEX_SELECTOR.allowance, [encodeAddress(owner), encodeAddress(spender)]);
}

export function encodeErc20Approve(spender: string, amount: bigint): string {
  return encodeCall(DEX_SELECTOR.approve, [encodeAddress(spender), encodeUint(amount)]);
}

export function encodeCreateSpotPool(
  tokenA: string,
  tokenB: string,
  lpFeeRatePpm: bigint,
  tickSize: bigint,
): string {
  if (lpFeeRatePpm < 0n || lpFeeRatePpm >= UINT32_LIMIT) throw new Error('LP fee rate must fit in uint32.');
  return encodeCall(DEX_SELECTOR.createSpotPool, [
    encodeAddress(tokenA),
    encodeAddress(tokenB),
    encodeUint(lpFeeRatePpm),
    encodeUint(tickSize),
  ]);
}

export function encodeGetSpotPools(pairId: string): string {
  return encodeCall(DEX_SELECTOR.getSpotPools, [encodeBytes32(pairId)]);
}

export function encodeAddLiquidity(
  amount0Desired: bigint,
  amount1Desired: bigint,
  amount0Min: bigint,
  amount1Min: bigint,
  recipient: string,
): string {
  return encodeCall(DEX_SELECTOR.addLiquidity, [
    encodeUint(amount0Desired),
    encodeUint(amount1Desired),
    encodeUint(amount0Min),
    encodeUint(amount1Min),
    encodeAddress(recipient),
  ]);
}

export function encodeRemoveLiquidity(
  shares: bigint,
  amount0Min: bigint,
  amount1Min: bigint,
  recipient: string,
): string {
  return encodeCall(DEX_SELECTOR.removeLiquidity, [
    encodeUint(shares),
    encodeUint(amount0Min),
    encodeUint(amount1Min),
    encodeAddress(recipient),
  ]);
}

/**
 * `placeOrder(pairId, side, priceX18, amount, expiry, reserved)`.
 *
 * `amount` is denominated in the pair's base token (token0). A buy escrows
 * `priceX18 * amount / 1e18` of the quote token; a sell escrows `amount` of the
 * base token. The final `uint256` is accepted but has no observed effect on the
 * resting order, so callers pass zero.
 */
export function encodePlaceOrder(
  pairId: string,
  side: bigint,
  priceX18: bigint,
  amount: bigint,
  expiry: bigint,
): string {
  if (side !== DEX_ORDER_SIDE.buy && side !== DEX_ORDER_SIDE.sell) throw new Error('Order side must be buy or sell.');
  if (expiry <= 0n || expiry >= 2n ** 64n) throw new Error('Order expiry must fit in uint64.');
  return encodeCall(DEX_SELECTOR.placeOrder, [
    encodeBytes32(pairId),
    encodeUint(side),
    encodeUint(priceX18),
    encodeUint(amount),
    encodeUint(expiry),
    encodeUint(0n),
  ]);
}

export function encodeCancelOrder(orderId: bigint): string {
  return encodeCall(DEX_SELECTOR.cancelOrder, [encodeUint(orderId)]);
}

export function encodeOrderRead(orderId: bigint): string {
  return encodeCall(DEX_SELECTOR.orders, [encodeUint(orderId)]);
}

export function encodeLevelOf(pairId: string, side: bigint, priceX18: bigint): string {
  return encodeCall(DEX_SELECTOR.levelOf, [encodeBytes32(pairId), encodeUint(side), encodeUint(priceX18)]);
}

export function encodeSharesOf(owner: string): string {
  return encodeCall(DEX_SELECTOR.sharesOf, [encodeAddress(owner)]);
}

export function encodeSwapExactIn(
  tokenIn: string,
  amountIn: bigint,
  minAmountOut: bigint,
  recipient: string,
): string {
  return encodeCall(DEX_SELECTOR.swapExactIn, [
    encodeAddress(tokenIn),
    encodeUint(amountIn),
    encodeUint(minAmountOut),
    encodeAddress(recipient),
  ]);
}

function asHex(result: unknown): string | null {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) return null;
  const normalized = result.slice(2).toLowerCase();
  return `0x${normalized}`;
}

/** Decode complete ABI words and reject partial or empty return data. */
export function decodeDexWords(result: unknown): bigint[] | null {
  const hex = asHex(result);
  if (!hex || hex === '0x' || (hex.length - 2) % WORD_HEX_LENGTH !== 0) return null;

  const words: bigint[] = [];
  for (let offset = 2; offset < hex.length; offset += WORD_HEX_LENGTH) {
    const word = hex.slice(offset, offset + WORD_HEX_LENGTH);
    if (word.length !== WORD_HEX_LENGTH) return null;
    try {
      words.push(BigInt(`0x${word}`));
    } catch {
      return null;
    }
  }
  return words.length > 0 ? words : null;
}

export function decodeDexUint(result: unknown): bigint | null {
  const words = decodeDexWords(result);
  return words?.length === 1 ? words[0] : null;
}

export function decodeDexUint32(result: unknown): bigint | null {
  const value = decodeDexUint(result);
  return value !== null && value < UINT32_LIMIT ? value : null;
}

export function decodeDexBool(result: unknown): boolean | null {
  const value = decodeDexUint(result);
  return value === null || value > 1n ? null : value === 1n;
}

export type DexAddressRead = {
  ready: boolean;
  address: string | null;
};

function decodeAddressWord(word: bigint): DexAddressRead {
  if (word >= ADDRESS_LIMIT) return { ready: false, address: null };
  if (word === 0n) return { ready: true, address: null };
  return { ready: true, address: `0x${word.toString(16).padStart(40, '0')}` };
}

export function decodeDexAddressRead(result: unknown): DexAddressRead {
  const words = decodeDexWords(result);
  if (!words || words.length !== 1) return { ready: false, address: null };
  return decodeAddressWord(words[0]);
}

export function decodeDexAddress(result: unknown): string | null {
  return decodeDexAddressRead(result).address;
}

/** Decode `address[]` return data, rejecting malformed offsets or dirty words. */
export function decodeDexAddressArray(result: unknown): string[] | null {
  const words = decodeDexWords(result);
  if (!words || words.length < 2) return null;

  const [offset, length] = words;
  if (offset !== 32n) return null;
  if (length > BigInt(words.length - 2)) return null;

  const addresses: string[] = [];
  for (let index = 0; index < Number(length); index += 1) {
    const read = decodeAddressWord(words[2 + index]);
    if (!read.ready || read.address === null) return null;
    addresses.push(read.address);
  }
  return addresses;
}

export function decodeDexBytes32(result: unknown): string | null {
  const hex = asHex(result);
  if (!hex || !BYTES32_PATTERN.test(hex)) return null;
  return hex;
}

export type DecodedReserves = {
  reserve0: bigint;
  reserve1: bigint;
  blockTimestampLast: bigint | null;
};

/** SpotPool returns reserve0, reserve1, and a uint64 timestamp as ABI words. */
export function decodeDexReserves(result: unknown): DecodedReserves | null {
  const words = decodeDexWords(result);
  if (!words || words.length !== 3 || words[2] >= 2n ** 64n) return null;

  return {
    reserve0: words[0],
    reserve1: words[1],
    blockTimestampLast: words[2] ?? null,
  };
}

export type DecodedOrder = {
  maker: string;
  side: number;
  status: number;
  expiry: bigint;
  pairId: string;
  priceX18: bigint;
  amount: bigint;
  filled: bigint;
  escrow: bigint;
};

/** Decode `orders(uint256)`; an unwritten slot decodes to a zero-maker order. */
export function decodeDexOrder(result: unknown): DecodedOrder | null {
  const words = decodeDexWords(result);
  if (!words || words.length !== 10) return null;

  const maker = decodeAddressWord(words[0]);
  if (!maker.ready) return null;
  if (words[1] > 1n || words[2] > 255n || words[3] >= 2n ** 64n) return null;

  return {
    maker: maker.address ?? '0x0000000000000000000000000000000000000000',
    side: Number(words[1]),
    status: Number(words[2]),
    expiry: words[3],
    pairId: `0x${words[4].toString(16).padStart(64, '0')}`,
    priceX18: words[5],
    amount: words[6],
    filled: words[7],
    escrow: words[8],
  };
}

export type DecodedOrderbookLevel = {
  priceX18: bigint;
  totalBase: bigint;
};

export function decodeDexOrderbookLevel(result: unknown): DecodedOrderbookLevel | null {
  const words = decodeDexWords(result);
  if (!words || words.length !== 2) return null;
  return { priceX18: words[0], totalBase: words[1] };
}

export type DecodedBookConfig = {
  initialized: boolean;
  base: string | null;
  quote: string | null;
  tickSize: bigint;
};

export function decodeDexBookConfig(result: unknown): DecodedBookConfig | null {
  const words = decodeDexWords(result);
  if (!words || words.length !== 4 || words[0] > 1n) return null;

  const base = decodeAddressWord(words[1]);
  const quote = decodeAddressWord(words[2]);
  if (!base.ready || !quote.ready) return null;

  return {
    initialized: words[0] === 1n,
    base: base.address,
    quote: quote.address,
    tickSize: words[3],
  };
}

/** Strict ABI string decoder for ERC-20 metadata responses. */
export function decodeDexString(result: unknown): string | null {
  const hex = asHex(result);
  if (!hex || (hex.length - 2) % 2 !== 0 || hex.length < 2 + WORD_HEX_LENGTH * 2) return null;

  const offsetWord = hex.slice(2, 2 + WORD_HEX_LENGTH);
  let offset: bigint;
  try {
    offset = BigInt(`0x${offsetWord}`);
  } catch {
    return null;
  }
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) return null;

  const offsetBytes = Number(offset);
  const payloadHex = hex.slice(2);
  const payloadBytes = payloadHex.length / 2;
  if (offsetBytes < WORD_BYTES || offsetBytes % WORD_BYTES !== 0 || offsetBytes + WORD_BYTES > payloadBytes) return null;

  const lengthStart = offsetBytes * 2;
  const lengthWord = payloadHex.slice(lengthStart, lengthStart + WORD_HEX_LENGTH);
  if (lengthWord.length !== WORD_HEX_LENGTH) return null;

  let byteLengthValue: bigint;
  try {
    byteLengthValue = BigInt(`0x${lengthWord}`);
  } catch {
    return null;
  }
  if (byteLengthValue > BigInt(Number.MAX_SAFE_INTEGER)) return null;

  const byteLength = Number(byteLengthValue);
  const bodyStart = offsetBytes + WORD_BYTES;
  const paddedLength = Math.ceil(byteLength / WORD_BYTES) * WORD_BYTES;
  if (bodyStart + paddedLength > payloadBytes) return null;

  const body = payloadHex.slice(bodyStart * 2, (bodyStart + byteLength) * 2);
  if (body.length !== byteLength * 2) return null;

  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = parseInt(body.slice(index * 2, index * 2 + 2), 16);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeBytes32String(result: unknown): string | null {
  const hex = asHex(result);
  if (!hex || !BYTES32_PATTERN.test(hex)) return null;

  const bytes = new Uint8Array(WORD_BYTES);
  for (let index = 0; index < WORD_BYTES; index += 1) {
    bytes[index] = parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\0+$/, '').trim() || null;
  } catch {
    return null;
  }
}

export function decodeDexTokenSymbol(result: unknown): string | null {
  return decodeDexString(result) ?? decodeBytes32String(result);
}

function encodeBytes32(value: string): string {
  if (!BYTES32_PATTERN.test(value)) throw new Error('Invalid bytes32 value.');
  return value.slice(2).toLowerCase();
}

export async function readSpotQuote(
  poolAddress: string,
  tokenIn: string,
  amountIn: bigint,
  signal?: AbortSignal,
): Promise<bigint | null> {
  const pool = normalizeDexAddress(poolAddress);
  const token = normalizeDexAddress(tokenIn);
  if (!pool || !token || amountIn <= 0n || amountIn >= UINT256_LIMIT) return null;

  const [result] = await rpcBatch([dexCall(pool, encodePoolAmountOut(token, amountIn))], signal);
  return decodeDexUint(result);
}

export async function simulateSwapExactIn(
  poolAddress: string,
  walletAddress: string,
  tokenIn: string,
  amountIn: bigint,
  minAmountOut: bigint,
  recipient: string,
  signal?: AbortSignal,
): Promise<bigint | null> {
  const pool = normalizeDexAddress(poolAddress);
  const wallet = normalizeDexAddress(walletAddress);
  const token = normalizeDexAddress(tokenIn);
  const destination = normalizeDexAddress(recipient);
  if (
    !pool ||
    !wallet ||
    !token ||
    !destination ||
    amountIn <= 0n ||
    amountIn >= UINT256_LIMIT ||
    minAmountOut <= 0n ||
    minAmountOut >= UINT256_LIMIT
  ) return null;

  const data = encodeSwapExactIn(token, amountIn, minAmountOut, destination);
  const [result] = await rpcBatch([dexSimulationCall(wallet, pool, data)], signal);
  return decodeDexUint(result);
}

export type DexSimulation = {
  ok: boolean;
  returnData: string | null;
  error: string | null;
};

/**
 * Dry-run a write with `eth_call` before it is signed. The RPC batch helper
 * swallows per-call errors, so this uses a dedicated request to keep the revert
 * payload and turn known custom errors into readable copy.
 */
export async function simulateDexWrite(
  from: string,
  to: string,
  data: string,
  signal?: AbortSignal,
): Promise<DexSimulation> {
  const wallet = normalizeDexAddress(from);
  const target = normalizeDexAddress(to);
  if (!wallet || !target) return { ok: false, returnData: null, error: 'A malformed address blocked the simulation.' };

  let response: Response;
  try {
    response = await fetch(MONAD.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: wallet, to: target, data }, 'latest'] }),
      signal,
    });
  } catch {
    return { ok: false, returnData: null, error: 'The simulation request to Monad failed.' };
  }
  if (!response.ok) return { ok: false, returnData: null, error: `Simulation RPC ${response.status}.` };

  let body: { result?: unknown; error?: { message?: unknown; data?: unknown } };
  try {
    body = await response.json() as typeof body;
  } catch {
    return { ok: false, returnData: null, error: 'The simulation response was not valid JSON.' };
  }

  if (body.error) {
    const known = describeDexRevert(body.error.data);
    const raw = typeof body.error.message === 'string' ? body.error.message : 'The simulation reverted.';
    return { ok: false, returnData: null, error: known ?? raw };
  }
  if (typeof body.result !== 'string') return { ok: false, returnData: null, error: 'The simulation returned no data.' };
  return { ok: true, returnData: body.result, error: null };
}

/** Read every SpotPool the registry has recorded for a token pair. */
export async function readSpotPoolsForPair(pairId: string, signal?: AbortSignal): Promise<string[] | null> {
  if (!BYTES32_PATTERN.test(pairId)) return null;
  const [result] = await rpcBatch([dexCall(DEX_CONTRACTS.registry, encodeGetSpotPools(pairId))], signal);
  return decodeDexAddressArray(result);
}

/**
 * Read a window of order slots. `nextOrderId` counts up from one, so the newest
 * `limit` ids cover every order a wallet could still have open without walking
 * the whole book.
 */
export async function readOrderWindow(
  nextOrderId: bigint,
  limit: number,
  signal?: AbortSignal,
): Promise<Array<{ id: bigint; order: DecodedOrder }>> {
  if (nextOrderId <= 1n || limit <= 0) return [];

  const highest = nextOrderId - 1n;
  const lowest = highest > BigInt(limit) ? highest - BigInt(limit) + 1n : 1n;
  const ids: bigint[] = [];
  for (let id = highest; id >= lowest; id -= 1n) ids.push(id);

  const results = await rpcBatch(ids.map((id) => dexCall(DEX_CONTRACTS.orderbook, encodeOrderRead(id))), signal);
  const orders: Array<{ id: bigint; order: DecodedOrder }> = [];
  results.forEach((result, index) => {
    const order = decodeDexOrder(result);
    if (order !== null) orders.push({ id: ids[index], order });
  });
  return orders;
}
