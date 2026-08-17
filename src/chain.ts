/**
 * Minimal Monad mainnet JSON-RPC client.
 *
 * No viem/wagmi: this site only makes static-selector `eth_call` reads with
 * uint256 / address / bool / string returns, so hand-rolled encoding is a
 * smaller footprint than a full ABI toolkit.
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
  ownerTokenId: '0x27329fea',
  walletOf: '0xe0fa88e1',
  handleOf: '0x49491987',
  ownerOf: '0x6352211e',
  hasIdentity: '0x237f1a21',
  isVerified: '0x37b6d96b',
  reputationScoreOf: '0xa6e7237d',
  totalReputationScore: '0xb266266d',
  humanMintFee: '0xcfdf36f8',
  aiMintFee: '0x9d236668',
  stakedBalance: '0x60217267',
  rewardPerTokenStored: '0xdf136d65',
  pendingNFTRewards: '0x4ff9f5fa',
  nftRewardPerToken: '0xd37df755',
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

/** `selector(address)` — the only argument shape this site needs. */
export function callWithAddress(to: string, selector: string, address: string): RpcCall {
  return ethCall(to, selector + address.toLowerCase().replace('0x', '').padStart(64, '0'));
}

/** `selector(uint256)`. */
export function callWithUint(to: string, selector: string, value: bigint): RpcCall {
  return ethCall(to, selector + value.toString(16).padStart(64, '0'));
}

// ─────────────────── decoding ───────────────────

function asHex(result: unknown): string | null {
  return typeof result === 'string' && result.startsWith('0x') ? result : null;
}

export function decodeUint(result: unknown): bigint | null {
  const hex = asHex(result);
  if (!hex || hex === '0x') return null;
  return BigInt(hex);
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

  const byteLength = Number(BigInt(`0x${hex.slice(66, 130)}`));
  if (byteLength === 0) return '';

  const body = hex.slice(130, 130 + byteLength * 2);
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
