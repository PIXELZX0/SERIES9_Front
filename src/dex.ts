import {
  CONTRACTS,
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
} as const;

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
