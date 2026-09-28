/**
 * Just enough ABI for the Series9 DEX.
 *
 * Selectors are derived from their Solidity signatures at load time rather than
 * pasted as hex, so a typo in a signature shows up as a failed call in
 * `dex.check.ts` instead of a silently wrong four bytes.
 */
import { keccak256 } from '../keccak.ts';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const WORD = 64;
const UINT256_LIMIT = 2n ** 256n;

export type AbiValue = bigint | number | boolean | string | AbiValue[];

function utf8Keccak(text: string): string {
  const digest = keccak256(new TextEncoder().encode(text));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const selectorCache = new Map<string, string>();

/** `0x` + first four bytes of keccak256(signature). */
export function selector(signature: string): string {
  let cached = selectorCache.get(signature);
  if (cached === undefined) {
    cached = `0x${utf8Keccak(signature).slice(0, 8)}`;
    selectorCache.set(signature, cached);
  }
  return cached;
}

/** Split a signature's argument list at top-level commas: `f(a,(b,c),d[])` → [a, (b,c), d[]]. */
export function parseArgTypes(signature: string): string[] {
  const open = signature.indexOf('(');
  const body = signature.slice(open + 1, -1);
  if (body === '') return [];
  const types: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      types.push(body.slice(start, index));
      start = index + 1;
    }
  }
  types.push(body.slice(start));
  return types;
}

function word(value: bigint): string {
  if (value < 0n) value += UINT256_LIMIT;
  if (value < 0n || value >= UINT256_LIMIT) throw new Error('ABI value out of range.');
  return value.toString(16).padStart(WORD, '0');
}

function encodeStatic(type: string, value: AbiValue): string {
  if (type.startsWith('(')) {
    const inner = parseArgTypes(`f${type}`);
    if (!Array.isArray(value) || value.length !== inner.length) throw new Error(`Tuple ${type} needs ${inner.length} fields.`);
    return inner.map((innerType, index) => encodeStatic(innerType, value[index])).join('');
  }
  if (type === 'address') {
    if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) throw new Error('Invalid address argument.');
    return value.slice(2).toLowerCase().padStart(WORD, '0');
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new Error('Invalid bool argument.');
    return word(value ? 1n : 0n);
  }
  const uint = /^uint(\d*)$/.exec(type);
  if (uint) {
    const bits = BigInt(uint[1] || '256');
    const big = typeof value === 'bigint' ? value : typeof value === 'number' ? BigInt(value) : null;
    if (big === null || big < 0n || big >= 2n ** bits) throw new Error(`Argument does not fit ${type}.`);
    return word(big);
  }
  throw new Error(`Unsupported ABI type ${type}.`);
}

/**
 * Encode `signature` with `args`. Static types and static tuples go inline;
 * the only dynamic type the DEX takes is `address[]` (router paths).
 */
export function encodeFunction(signature: string, args: AbiValue[] = []): string {
  const types = parseArgTypes(signature);
  if (types.length !== args.length) throw new Error(`${signature} expects ${types.length} arguments.`);
  const headWords = types.map((type) => (type.startsWith('(') ? parseArgTypes(`f${type}`).length : 1));
  const headSize = headWords.reduce((sum, count) => sum + count, 0) * 32;
  let head = '';
  let tail = '';
  types.forEach((type, index) => {
    const value = args[index];
    if (type.endsWith('[]')) {
      if (!Array.isArray(value)) throw new Error(`${type} argument must be an array.`);
      head += word(BigInt(headSize + tail.length / 2));
      tail += word(BigInt(value.length)) + value.map((item) => encodeStatic(type.slice(0, -2), item)).join('');
    } else {
      head += encodeStatic(type, value);
    }
  });
  return `${selector(signature)}${head}${tail}`;
}

// ─────────────────── decoding ───────────────────

/** Every 32-byte word of return data, or null for empty / ragged data. */
export function words(result: unknown): bigint[] | null {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) return null;
  const body = result.slice(2);
  if (body.length === 0 || body.length % WORD !== 0) return null;
  const out: bigint[] = [];
  for (let offset = 0; offset < body.length; offset += WORD) out.push(BigInt(`0x${body.slice(offset, offset + WORD)}`));
  return out;
}

export function asUint(result: unknown): bigint | null {
  const decoded = words(result);
  return decoded && decoded.length >= 1 ? decoded[0] : null;
}

export function asInt(result: unknown): bigint | null {
  const value = asUint(result);
  if (value === null) return null;
  return value >= 2n ** 255n ? value - UINT256_LIMIT : value;
}

export function asBool(result: unknown): boolean | null {
  const value = asUint(result);
  return value === null ? null : value !== 0n;
}

export function wordToAddress(value: bigint): string | null {
  if (value === 0n || value >= 2n ** 160n) return null;
  return `0x${value.toString(16).padStart(40, '0')}`;
}

export function asAddress(result: unknown): string | null {
  const value = asUint(result);
  return value === null ? null : wordToAddress(value);
}

/** A dynamic array whose head offset sits at `headIndex`; `stride` words per element. */
export function dynamicArray(all: bigint[], headIndex: number, stride = 1): bigint[][] | null {
  const offset = all[headIndex];
  if (offset === undefined || offset % 32n !== 0n) return null;
  const lengthIndex = Number(offset / 32n);
  const length = all[lengthIndex];
  if (length === undefined || lengthIndex + 1 + Number(length) * stride > all.length) return null;
  const items: bigint[][] = [];
  for (let item = 0; item < Number(length); item += 1) {
    const start = lengthIndex + 1 + item * stride;
    items.push(all.slice(start, start + stride));
  }
  return items;
}

/** ABI `string`, with a bytes32 fallback for old tokens that return a fixed symbol. */
export function asString(result: unknown): string | null {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) return null;
  const body = result.slice(2);
  const toText = (hex: string): string | null => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  };
  if (body.length === WORD) return toText(body.replace(/(00)+$/, ''))?.trim() || null;
  if (body.length < WORD * 2) return null;
  const offset = Number(BigInt(`0x${body.slice(0, WORD)}`));
  if (offset * 2 + WORD > body.length) return null;
  const length = Number(BigInt(`0x${body.slice(offset * 2, offset * 2 + WORD)}`));
  const start = offset * 2 + WORD;
  if (start + length * 2 > body.length) return null;
  return toText(body.slice(start, start + length * 2));
}

// ─────────────────── custom errors ───────────────────

/** Every custom error the DEX and its ERC-20 dependencies can revert with, in plain words. */
const ERROR_COPY: Record<string, string> = {
  'Paused()': 'The DEX is paused. New trades, orders and deposits are stopped; withdrawals and cancels still work.',
  'ZeroAddress()': 'An address argument was the zero address.',
  'ZeroAmount()': 'The amount is zero, or the token transferred nothing.',
  'ZeroToken()': 'A token address is the zero address.',
  'IdenticalTokens()': 'Both sides of the pair are the same token.',
  'PairAlreadyExists()': 'A pair for these two tokens already exists.',
  'FactoryNotSet()': 'This pool type has not been enabled on the registry.',
  'InvalidFeeRate()': 'The fee must be between 0.0001% and 1%.',
  'DuplicateFeeRate()': 'A pool with this fee already exists for the pair.',
  'TooManyCustomSpotPools()': 'All 12 custom fee slots on this pair are taken. Use one of the four standard tiers.',
  'InvalidQuoteToken()': 'The margin token must be one of the pair\'s two tokens.',
  'UnknownSpotPool()': 'That spot pool does not belong to this pair.',
  'InvalidPerpParams()': 'The perp risk parameters are out of range or would make max leverage liquidatable on open.',
  'InvalidPrice()': 'The limit price is not on the 6-significant-digit price grid.',
  'InvalidAmount()': 'The order amount is not accepted.',
  'InvalidExpiry()': 'The expiry must be in the future.',
  'NotionalTooSmall()': 'The order is too small. Increase the amount or price.',
  'NotMaker()': 'Only the wallet that placed this order can cancel it.',
  'OrderNotOpen()': 'That order is no longer open.',
  'OrderNotExpired()': 'That order has not expired yet.',
  'OnlySpotPool()': 'Only a spot pool of this pair can call this.',
  'InvalidToken()': 'The token is not part of this pool.',
  'InsufficientOutput()': 'Output fell below your minimum. The price moved; raise slippage or retry.',
  'InsufficientLiquidity()': 'The pool does not have enough liquidity for this.',
  'InsufficientLiquidityMinted()': 'The deposit is too small to mint any liquidity.',
  'InsufficientLiquidityBurned()': 'The withdrawal is too small to return both tokens.',
  'InsufficientShares()': 'Not enough pool shares.',
  'SlippageExceeded()': 'The price moved past your slippage tolerance.',
  'OnlyPair()': 'Only the pair contract can call this.',
  'MarkNotReady()': 'The perp mark price is not ready yet. It needs a full 5-minute TWAP window; press "Update mark" and retry after it.',
  'NoPosition()': 'There is no open position on that side.',
  'LeverageTooHigh()': 'Leverage is above the pool maximum, or the margin does not cover the opening fee.',
  'UtilizationExceeded()': 'The pool\'s open-interest cap for that side is reached.',
  'NotLiquidatable()': 'That position is above maintenance margin.',
  'BelowMaintenance()': 'The remaining position would fall below maintenance margin.',
  'ReduceTooLarge()': 'The amount is larger than the position.',
  'Expired()': 'The transaction deadline passed before it was mined.',
  'EmptyPath()': 'No route was selected.',
  'UnknownPool()': 'The route includes a pool the registry does not recognise.',
  'WrongPoolKind()': 'That position belongs to the other pool type.',
  'NotAuthorized()': 'This wallet does not own or control that position.',
  'InsufficientPositionLiquidity()': 'The position holds less liquidity than requested.',
  'PositionNotEmpty()': 'Withdraw all liquidity before burning the position NFT.',
  'NotPauser()': 'Only the owner or guardian can pause.',
  'ReentrancyGuardReentrantCall()': 'The contract rejected a re-entrant call.',
  'SafeERC20FailedOperation(address)': 'A token transfer failed. Check balance and allowance.',
  'ERC20InsufficientBalance(address,uint256,uint256)': 'Token balance is too low.',
  'ERC20InsufficientAllowance(address,uint256,uint256)': 'Token allowance is too low. Approve first.',
  'ERC721NonexistentToken(uint256)': 'That position NFT does not exist.',
  'ERC721InsufficientApproval(address,uint256)': 'This wallet is not approved for that position NFT.',
  'SafeCastOverflowedUintToInt(uint256)': 'A value overflowed. Try a smaller amount.',
};

const ERROR_BY_SELECTOR = new Map<string, string>(
  Object.entries(ERROR_COPY).map(([signature, copy]) => [selector(signature), copy]),
);

export function describeRevert(data: unknown): string | null {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  const known = ERROR_BY_SELECTOR.get(data.slice(0, 10).toLowerCase());
  if (known) return known;
  // Error(string)
  if (data.slice(0, 10).toLowerCase() === '0x08c379a0') return asString(`0x${data.slice(10)}`);
  return null;
}

export function errorSignatures(): string[] {
  return Object.keys(ERROR_COPY);
}
