/**
 * Minimal Monad mainnet JSON-RPC client.
 *
 * No viem/wagmi: the site only needs a small set of hand-rolled reads and
 * writes, so standard ABI helpers keep the bundle smaller than a full toolkit.
 */

export const MONAD = {
  id: 143,
  idHex: '0x8f',
  name: 'Monad Mainnet',
  rpcUrl: 'https://rpc.monad.xyz',
  explorer: 'https://socialscan.io',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
} as const;

// `import.meta.env` is Vite-only; guard it so this module also runs under plain node.
const env: Record<string, string | undefined> = import.meta.env ?? {};

/** Live SERIES9 deployment on Monad mainnet (mirrors series9connect's config). */
export const CONTRACTS = {
  identity: env.VITE_IDENTITY_ADDRESS ?? '0xEBa0Fd485ADe50AE5182EbB4ff98fCC5613572e9',
  ser9: env.VITE_SER9_ADDRESS ?? '0x461b9beFb3c81c988501C89F5caaBa03b02565d0',
  staking: env.VITE_STAKING_ADDRESS ?? '0xFa76a92716D9fE7DF902266651Ca64014c4dC35A',
} as const;

export const SELECTOR = {
  totalStaked: '0x817b1cd2',
  balanceOf: '0x70a08231',
  totalSupply: '0x18160ddd',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  image: '0xf3ccaac0',
  description: '0x7284e416',
  ownerTokenId: '0x27329fea',
  walletOf: '0xe0fa88e1',
  handleOf: '0x49491987',
  ownerOf: '0x6352211e',
  hasIdentity: '0x237f1a21',
  isVerified: '0x37b6d96b',
  nameOf: '0xf5c57382',
  reputationScoreOf: '0xa6e7237d',
  totalReputationScore: '0xb266266d',
  humanMintFee: '0xcfdf36f8',
  aiMintFee: '0x9d236668',
  stakedBalance: '0x60217267',
  rewardPerTokenStored: '0xdf136d65',
  rewardRatePerBlock: '0x90870492',
  monadRewardPerTokenStored: '0xd7d03426',
  monadRewardRatePerBlock: '0x26c08f7e',
  totalMonadStaked: '0x6780a855',
  pendingNFTRewards: '0x4ff9f5fa',
  nftRewardPerToken: '0xd37df755',
  approve: '0x095ea7b3',
  stake: '0xa694fc3a',
  unstake: '0x2e17de78',
  claimRewards: '0x372500ab',
  claimUnstaked: '0x9af40f0c',
  stakeMonad: '0xcb0773a3',
  requestUnstakeMonad: '0x5abb2907',
  claimUnstakedMonad: '0xdd47e035',
  mintIdentity: '0x1714a810',
  mintIdentityWithHandle: '0x77c3c628',
  createWallet: '0x7a675bb6',
  setHandle: '0xa6e6178d',
  earned: '0x008cc262',
  monadEarned: '0x30104a83',
  monadStakedBalance: '0xc639cb69',
  ser9UnstakeRequestCount: '0x90c1865e',
  ser9UnstakeRequest: '0x92b20c6b',
  monadUnstakeRequestCount: '0x90440c4f',
  monadUnstakeRequest: '0xdeb869ea',
  collectStakingRewards: '0xbfe13d9a',
  claimNFTRewards: '0x3f022627',
  getEntityType: '0xe5a46071',
  predictWalletAddress: '0x38834b75',
} as const;

// ─────────────────── transport ───────────────────

type RpcCall = { method: string; params: unknown[] };
type RpcResponse = { id: number; result?: unknown; error?: { message: string } };

/**
 * One HTTP round trip for N calls. Individual failures resolve to `null`
 * instead of rejecting, so a single reverting read cannot blank the page.
 */
export async function rpcBatch(calls: RpcCall[], signal?: AbortSignal): Promise<unknown[]> {
  if (calls.length === 0) return [];

  const payload = calls.map((call, index) => ({ jsonrpc: '2.0', id: index, ...call }));
  const response = await fetch(MONAD.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) throw new Error(`RPC ${response.status}`);

  const body = (await response.json()) as RpcResponse | RpcResponse[];
  const rows = Array.isArray(body) ? body : [body];
  const results: unknown[] = new Array(calls.length).fill(null);

  rows.forEach((row) => {
    if (row.error || row.result === undefined || row.result === null) return;
    results[row.id] = row.result;
  });

  return results;
}

export function ethCall(to: string, data: string): RpcCall {
  return { method: 'eth_call', params: [{ to, data }, 'latest'] };
}

type AbiUint = bigint | number;

function asUint(value: AbiUint): bigint {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error('ABI uint256 values must be non-negative safe integers.');
  }

  const result = typeof value === 'bigint' ? value : BigInt(value);
  if (result < 0n || result >= 2n ** 256n) throw new Error('ABI uint256 value is out of range.');
  return result;
}

/** Encode a uint256 value as one ABI word. */
export function encodeUint(value: AbiUint): string {
  return asUint(value).toString(16).padStart(64, '0');
}

export function encodeUint8(value: AbiUint): string {
  const normalized = asUint(value);
  if (normalized > 255n) throw new Error('ABI uint8 value is out of range.');
  return normalized.toString(16).padStart(64, '0');
}

/** Encode an address as one ABI word, rejecting malformed calldata inputs. */
export function encodeAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid EVM address.');
  return address.slice(2).toLowerCase().padStart(64, '0');
}

function encodeSelector(selector: string): string {
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) throw new Error('Invalid ABI function selector.');
  return selector.toLowerCase();
}

/** Join already ABI-encoded arguments to a four-byte selector. */
export function encodeCall(selector: string, encodedArgs: string[] = []): string {
  const args = encodedArgs.map((arg) => {
    const normalized = arg.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0) {
      throw new Error('Invalid ABI argument encoding.');
    }
    return normalized;
  });

  return `${encodeSelector(selector)}${args.join('')}`;
}

/** Encode the tail of a dynamic ABI string: length plus 32-byte UTF-8 padding. */
export function encodeDynamicString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  const paddedLength = Math.ceil(bytes.length / 32) * 64;
  return `${encodeUint(bytes.length)}${hex.padEnd(paddedLength, '0')}`;
}

/** `selector(address)` — the only argument shape this site needs. */
export function callWithAddress(to: string, selector: string, address: string): RpcCall {
  return ethCall(to, encodeCall(selector, [encodeAddress(address)]));
}

/** `selector(address,uint256)`. */
export function callWithAddressAndUint(to: string, selector: string, address: string, value: bigint): RpcCall {
  return ethCall(to, encodeCall(selector, [encodeAddress(address), encodeUint(value)]));
}

/** `selector(uint256)`. */
export function callWithUint(to: string, selector: string, value: bigint): RpcCall {
  return ethCall(to, encodeCall(selector, [encodeUint(value)]));
}

export function encodeApprove(spender: string, amount: bigint): string {
  return encodeCall(SELECTOR.approve, [encodeAddress(spender), encodeUint(amount)]);
}

export function encodeStake(amount: bigint): string {
  return encodeCall(SELECTOR.stake, [encodeUint(amount)]);
}

export function encodeUnstake(amount: bigint): string {
  return encodeCall(SELECTOR.unstake, [encodeUint(amount)]);
}

export function encodeClaimRewards(): string {
  return encodeCall(SELECTOR.claimRewards);
}

export function encodeClaimUnstaked(requestId: bigint): string {
  return encodeCall(SELECTOR.claimUnstaked, [encodeUint(requestId)]);
}

export function encodeStakeMonad(): string {
  return encodeCall(SELECTOR.stakeMonad);
}

export function encodeRequestUnstakeMonad(amount: bigint): string {
  return encodeCall(SELECTOR.requestUnstakeMonad, [encodeUint(amount)]);
}

export function encodeClaimUnstakedMonad(requestId: bigint): string {
  return encodeCall(SELECTOR.claimUnstakedMonad, [encodeUint(requestId)]);
}

/** Encode the two dynamic strings and three uint8 words used by identity minting. */
function encodeIdentityMint(
  selector: string,
  name: string,
  bio: string,
  entityType: AbiUint,
  hue: AbiUint,
  saturation: AbiUint,
  handle?: string,
): string {
  const nameTail = encodeDynamicString(name);
  const bioTail = encodeDynamicString(bio);
  const handleTail = handle === undefined ? '' : encodeDynamicString(handle);
  const headWords = handle === undefined ? 5 : 6;
  const nameOffset = headWords * 32;
  const bioOffset = nameOffset + nameTail.length / 2;
  const handleOffset = bioOffset + bioTail.length / 2;
  const heads = [
    encodeUint(nameOffset),
    encodeUint(bioOffset),
    encodeUint8(entityType),
    encodeUint8(hue),
    encodeUint8(saturation),
  ];

  if (handle !== undefined) heads.push(encodeUint(handleOffset));
  return encodeCall(selector, [...heads, nameTail, bioTail, handleTail]);
}

export function encodeMintIdentity(
  name: string,
  bio: string,
  entityType: AbiUint,
  hue: AbiUint,
  saturation: AbiUint,
): string {
  return encodeIdentityMint(SELECTOR.mintIdentity, name, bio, entityType, hue, saturation);
}

export function encodeMintIdentityWithHandle(
  name: string,
  bio: string,
  entityType: AbiUint,
  hue: AbiUint,
  saturation: AbiUint,
  handle: string,
): string {
  return encodeIdentityMint(SELECTOR.mintIdentityWithHandle, name, bio, entityType, hue, saturation, handle);
}

export function encodeCreateWallet(tokenId: bigint): string {
  return encodeCall(SELECTOR.createWallet, [encodeUint(tokenId)]);
}

export function encodeSetHandle(tokenId: bigint, handle: string): string {
  const handleTail = encodeDynamicString(handle);
  return encodeCall(SELECTOR.setHandle, [encodeUint(tokenId), encodeUint(64), handleTail]);
}

export function encodeClaimNFTRewards(): string {
  return encodeCall(SELECTOR.claimNFTRewards);
}

export function encodeCollectStakingRewards(): string {
  return encodeCall(SELECTOR.collectStakingRewards);
}

// ─────────────────── decoding ───────────────────

function asHex(result: unknown): string | null {
  return typeof result === 'string' && /^0x[0-9a-fA-F]*$/.test(result) ? result : null;
}

export function decodeUint(result: unknown): bigint | null {
  const hex = asHex(result);
  if (!hex || hex === '0x') return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

export function decodeAddress(result: unknown): string | null {
  const hex = asHex(result);
  if (!hex || hex.length < 66) return null;
  const address = `0x${hex.slice(-40)}`;
  return /^0x0{40}$/.test(address) ? null : address;
}

export function decodeBool(result: unknown): boolean | null {
  const value = decodeUint(result);
  return value === null ? null : value !== 0n;
}

/** ABI dynamic string: [offset][length][utf-8 bytes padded to 32]. */
export function decodeString(result: unknown): string | null {
  const hex = asHex(result);
  if (!hex || hex.length < 130) return null;

  const byteLengthValue = decodeUint(`0x${hex.slice(66, 130)}`);
  if (byteLengthValue === null || byteLengthValue > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const byteLength = Number(byteLengthValue);
  if (byteLength === 0) return '';

  const body = hex.slice(130, 130 + byteLength * 2);
  if (body.length !== byteLength * 2) return null;
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = parseInt(body.slice(index * 2, index * 2 + 2), 16);
  }

  return new TextDecoder().decode(bytes);
}

// ─────────────────── formatting ───────────────────

/** Wei → decimal string, truncated (never rounded up) to `precision` places. */
export function formatUnits(value: bigint, decimals = 18, precision = 4): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;

  const wholeText = whole.toLocaleString('en-US');
  if (precision === 0 || fraction === 0n) return wholeText;

  const fractionText = fraction.toString().padStart(decimals, '0').slice(0, precision).replace(/0+$/, '');
  return fractionText ? `${wholeText}.${fractionText}` : wholeText;
}

/** Large token amounts as 1.2K / 3.4M / 5.6B / 7.8T. */
export function formatCompact(value: bigint, decimals = 18): string {
  const whole = value / 10n ** BigInt(decimals);
  const units: Array<[bigint, string]> = [
    [1_000_000_000_000n, 'T'],
    [1_000_000_000n, 'B'],
    [1_000_000n, 'M'],
    [1_000n, 'K'],
  ];

  for (const [threshold, suffix] of units) {
    if (whole >= threshold) {
      const scaled = Number((whole * 100n) / threshold) / 100;
      return `${scaled.toFixed(2)}${suffix}`;
    }
  }

  return whole.toLocaleString('en-US');
}

export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function explorerAddressUrl(address: string): string {
  return `${MONAD.explorer}/monad/address/${address}`;
}
