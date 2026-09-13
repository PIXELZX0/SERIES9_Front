import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  DEX_CONFIG,
  DEX_CONTRACTS,
  DEX_ORDER_SIDE,
  DEX_ORDER_STATUS,
  DEX_SELECTOR,
  encodeAddLiquidity,
  encodeCancelOrder,
  encodeCreateSpotPool,
  encodeDexNoArgs,
  encodeErc20Approve,
  encodeErc20BalanceOf,
  encodePlaceOrder,
  encodeRemoveLiquidity,
  encodeSwapExactIn,
  encodeWithdraw,
  dexCall,
  decodeDexReserves,
  decodeDexUint,
  monWrapShortfall,
  normalizeDexAddress,
  readSpotPoolsForPair,
  simulateDexWrite,
  spendableBalance,
  wrappableMon,
} from './dex.ts';
import { computePairId, sortTokenPair } from './keccak.ts';
import {
  CONTRACTS,
  TOKENS,
  SELECTOR,
  decodeString,
  ethCall,
  formatUnits,
  normalizeTokenImageUri,
  rpcBatch,
  shortenAddress,
} from './chain.ts';
import { useDex, type DexOpenOrder, type DexPoolSnapshot, type DexToken } from './useDex.ts';
import { dexHref, useDexSection, type DexTab } from './useDexRoute.ts';
import { usePoolPositions, type PoolOverview, type PoolPosition } from './usePoolPositions.ts';
import type { WalletState } from './useWallet.ts';

type NotificationKind = 'success' | 'error';

type DexPageProps = {
  wallet: WalletState;
  onNotify: (message: string, kind?: NotificationKind) => void;
  onActionState: (label: string | null) => void;
};

type DexUnresolvedTransaction = {
  hash: string;
  label: string;
  walletAddress: string;
};

type DexUnresolvedTransactions = Record<string, DexUnresolvedTransaction>;

type DexOperation = {
  token: number;
  label: string;
  walletAddress: string | null;
  walletKey: string | null;
};

type DexOperationProgress = {
  hash: string | null;
  unresolved: boolean;
};

type OrderSide = 'buy' | 'sell';

type PoolFinderState = {
  status: 'idle' | 'loading' | 'done' | 'error';
  pairId: string | null;
  pools: string[];
  error: string | null;
  tokenA: string | null;
  tokenB: string | null;
};

type PriceHistoryState = {
  poolKey: string | null;
  samples: bigint[];
};

const EMPTY = '--';
const UINT256_LIMIT = 2n ** 256n;
const UNRESOLVED_TRANSACTION_STORAGE_KEY = 'series9:unresolved-submitted-transactions';
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const IDLE_POOL_FINDER: PoolFinderState = { status: 'idle', pairId: null, pools: [], error: null, tokenA: null, tokenB: null };

const TABS: Array<[DexTab, string]> = [
  ['swap', 'Swap'],
  ['liquidity', 'Liquidity'],
  ['orders', 'Limit'],
  ['create', 'Create'],
];

const FEE_PRESETS: Array<{ ppm: string; label: string; note: string }> = [
  { ppm: '500', label: '0.05%', note: 'stable pairs' },
  { ppm: '3000', label: '0.30%', note: 'standard' },
  { ppm: '10000', label: '1.00%', note: 'volatile' },
];

/** Curated tokens offered in the create-tab address dropdown (pool tokens are appended at runtime). */
type CatalogToken = DexToken & { note?: string };

const CREATE_TOKEN_CATALOG: CatalogToken[] = [
  { address: CONTRACTS.ser9, symbol: 'SER9', decimals: 18 },
  { address: TOKENS.wmon, symbol: 'MON', decimals: 18, note: 'wrapped' },
  { address: TOKENS.usdc, symbol: 'USDC', decimals: 6 },
];

const RECENT_CUSTOM_TOKENS_KEY = 'series9:dex-recent-create-tokens';
const RECENT_CUSTOM_TOKENS_LIMIT = 5;

function readRecentCustomTokens(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_CUSTOM_TOKENS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function rememberCustomToken(address: string): void {
  try {
    const next = [address, ...readRecentCustomTokens().filter((item) => item.toLowerCase() !== address.toLowerCase())]
      .slice(0, RECENT_CUSTOM_TOKENS_LIMIT);
    window.localStorage.setItem(RECENT_CUSTOM_TOKENS_KEY, JSON.stringify(next));
  } catch {
    // Private mode / full quota: recents just don't persist next visit.
  }
}

/** Locally hosted logos used when a token's on-chain `image()` metadata is missing. */
const KNOWN_TOKEN_IMAGES: Record<string, string> = {
  [CONTRACTS.ser9.toLowerCase()]: `${import.meta.env.BASE_URL}token-logos/ser9.svg`,
  [TOKENS.wmon.toLowerCase()]: `${import.meta.env.BASE_URL}token-logos/mon.svg`,
};

const REMOVE_PERCENTS = [25, 50, 75, 100] as const;

const EXPIRY_PRESETS: Array<{ seconds: string; label: string }> = [
  { seconds: '3600', label: '1H' },
  { seconds: '86400', label: '1D' },
  { seconds: '604800', label: '7D' },
  { seconds: '2592000', label: '30D' },
];

const TOLERANCE_PRESETS = ['0.1', '0.5', '1', '2', '5'] as const;

const PRICE_X18_EXPONENT = 18;
const MAX_PRICE_SAMPLES = 48;
const PRICE_CHART_WIDTH = 640;
const PRICE_CHART_HEIGHT = 280;
const PRICE_CHART_PADDING = { top: 22, right: 18, bottom: 20, left: 18 } as const;
const PRICE_CHART_RATIO_SCALE = 1_000_000n;

function walletAddressKey(address: string): string {
  return address.toLowerCase();
}

function sameTransactionHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** `Balance 12.5 WMON + 3.1 MON` when MON can top the spend up. */
function balanceHint(token: DexToken | null, balance: bigint | null | undefined, native: bigint | null): string {
  const wrappable = wrappableMon(token, native);
  const held = `Balance ${formatTokenValue(balance ?? null, token)}`;
  return wrappable > 0n ? `${held} + ${formatUnits(wrappable, 18, 4)} MON` : held;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getDexUnresolvedStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isStoredDexUnresolvedTransaction(value: unknown, key: string): value is DexUnresolvedTransaction {
  if (!isRecord(value)) return false;

  const { hash, label, walletAddress } = value;
  return typeof hash === 'string' &&
    TRANSACTION_HASH_PATTERN.test(hash) &&
    !/^0+$/.test(hash.slice(2)) &&
    typeof label === 'string' &&
    label.trim().length > 0 &&
    typeof walletAddress === 'string' &&
    ADDRESS_PATTERN.test(walletAddress) &&
    walletAddressKey(walletAddress) === key;
}

function readStoredDexUnresolvedTransactions(storage: Storage): DexUnresolvedTransactions | null {
  let serialized: string | null;
  try {
    serialized = storage.getItem(UNRESOLVED_TRANSACTION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (serialized === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const transactions: DexUnresolvedTransactions = {};
  for (const [storedKey, value] of Object.entries(parsed)) {
    const key = walletAddressKey(storedKey);
    if (!ADDRESS_PATTERN.test(storedKey) || !isStoredDexUnresolvedTransaction(value, key)) continue;
    transactions[key] = {
      hash: value.hash,
      label: value.label,
      walletAddress: value.walletAddress,
    };
  }
  return transactions;
}

function readDexUnresolvedTransactions(): DexUnresolvedTransactions {
  const storage = getDexUnresolvedStorage();
  if (!storage) return {};
  return readStoredDexUnresolvedTransactions(storage) ?? {};
}

function reloadDexUnresolvedTransactions(): DexUnresolvedTransactions | null {
  const storage = getDexUnresolvedStorage();
  if (!storage) return null;
  return readStoredDexUnresolvedTransactions(storage);
}

function persistDexUnresolvedTransaction(transaction: DexUnresolvedTransaction): void {
  const storage = getDexUnresolvedStorage();
  if (!storage) return;

  const transactions = readDexUnresolvedTransactions();
  transactions[walletAddressKey(transaction.walletAddress)] = transaction;
  try {
    storage.setItem(UNRESOLVED_TRANSACTION_STORAGE_KEY, JSON.stringify(transactions));
  } catch {
    // Storage can be disabled or unavailable in a private browsing context.
  }
}

function clearDexUnresolvedTransaction(walletAddress: string, expectedHash: string): boolean {
  const storage = getDexUnresolvedStorage();
  if (!storage) return true;

  const transactions = readStoredDexUnresolvedTransactions(storage);
  if (transactions === null) return false;

  const key = walletAddressKey(walletAddress);
  const transaction = transactions[key];
  if (!transaction) return true;
  if (!sameTransactionHash(transaction.hash, expectedHash)) return false;

  delete transactions[key];
  try {
    if (Object.keys(transactions).length === 0) {
      storage.removeItem(UNRESOLVED_TRANSACTION_STORAGE_KEY);
    } else {
      storage.setItem(UNRESOLVED_TRANSACTION_STORAGE_KEY, JSON.stringify(transactions));
    }
  } catch {
    return false;
  }

  const remainingTransactions = readStoredDexUnresolvedTransactions(storage);
  return remainingTransactions !== null && remainingTransactions[key] === undefined;
}

function tokenSymbol(token: DexToken | null): string {
  return token?.symbol?.trim() || (token ? shortenAddress(token.address) : 'Token');
}

function formatTokenValue(value: bigint | null, token: DexToken | null, precision = 5): string {
  if (value === null || token?.decimals === null || token === null) return EMPTY;
  return formatUnits(value, token.decimals, precision);
}

function formatPriceX18(
  priceX18: bigint | null,
  token0: DexToken | null,
  token1: DexToken | null,
): string {
  if (priceX18 === null || token0?.decimals === null || token1?.decimals === null || token0 === null || token1 === null) {
    return EMPTY;
  }

  const normalizedPrice = priceX18 * 10n ** BigInt(token0.decimals) / 10n ** BigInt(token1.decimals);
  return `${formatUnits(normalizedPrice, 18, 6)} ${tokenSymbol(token1)}`;
}

function formatFeePpm(value: bigint | null): string {
  return value === null ? EMPTY : `${formatUnits(value, 4, 4)}%`;
}

function formatPpmLimit(value: bigint | null): string {
  return value === null ? EMPTY : `${formatUnits(value, 4, 3)}% max`;
}

function formatUsd(value: number | null): string {
  if (value === null) return EMPTY;
  if (value > 0 && value < 0.01) return '<US$0.01';
  return `US$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** TVL in USD when one side of the pool is USDC — a constant-product pool always splits value 50/50, so double the USDC side. Null when neither token is USDC. */
function reservesTvlUsd(
  token0: DexToken | null,
  token1: DexToken | null,
  reserves: { reserve0: bigint; reserve1: bigint } | null,
): number | null {
  if (!reserves || !token0 || !token1) return null;
  const usdcSide = token0.symbol === 'USDC'
    ? { token: token0, reserve: reserves.reserve0 }
    : token1.symbol === 'USDC'
      ? { token: token1, reserve: reserves.reserve1 }
      : null;
  if (!usdcSide || usdcSide.token.decimals === null) return null;
  return (Number(usdcSide.reserve) / 10 ** usdcSide.token.decimals) * 2;
}

function poolTvlUsd(pool: DexPoolSnapshot | null): number | null {
  if (!pool) return null;
  return reservesTvlUsd(pool.token0, pool.token1, pool.reserves);
}

/** Resolves a pasted/typed address to catalog metadata (symbol/decimals) when known, else a bare address token. */
function lookupCatalogToken(address: string): DexToken {
  const known = CREATE_TOKEN_CATALOG.find((token) => token.address.toLowerCase() === address.toLowerCase());
  return known ?? { address, symbol: null, decimals: null };
}

function formatAgo(timestamp: number | null): string {
  if (timestamp === null) return EMPTY;
  const diffMs = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return '방금 전';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}분 전`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}시간 전`;
  return `${Math.floor(diffMs / day)}일 전`;
}

/** Displays SER9 first when it's part of the pair, matching how the rest of the DEX labels pairs. */
function orderForDisplay(token0: DexToken, token1: DexToken): [DexToken, DexToken] {
  if (token1.symbol === 'SER9' && token0.symbol !== 'SER9') return [token1, token0];
  return [token0, token1];
}

function parseTokenAmount(value: string, decimals: number | null): bigint | null {
  if (decimals === null) return null;
  const trimmed = value.trim();
  const normalized = trimmed.includes(',')
    ? /^\d{1,3}(?:,\d{3})*(?:\.\d*)?$/.test(trimmed) ? trimmed.replace(/,/g, '') : ''
    : trimmed;
  if (!/^\d*(?:\.\d*)?$/.test(normalized) || normalized === '' || normalized === '.') return null;

  const [whole = '0', fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) return null;

  try {
    const amount = BigInt(whole || '0') * 10n ** BigInt(decimals) +
      BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
    return amount > 0n && amount < UINT256_LIMIT ? amount : null;
  } catch {
    return null;
  }
}

function parseSlippageBps(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(basisPoints) && basisPoints >= 0 && basisPoints <= 5_000 ? basisPoints : null;
}

function parseWholeUint(value: string): bigint | null {
  const normalized = value.trim().replace(/,/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  try {
    const parsed = BigInt(normalized);
    return parsed < UINT256_LIMIT ? parsed : null;
  } catch {
    return null;
  }
}

function parsePriceToX18(value: string, baseDecimals: number | null, quoteDecimals: number | null): bigint | null {
  if (baseDecimals === null || quoteDecimals === null) return null;
  const scale = PRICE_X18_EXPONENT + quoteDecimals - baseDecimals;
  if (scale < 0 || scale > 77) return null;
  return parseTokenAmount(value, scale);
}

function orderEscrow(side: OrderSide, priceX18: bigint, amount: bigint): bigint {
  return side === 'buy' ? priceX18 * amount / 10n ** 18n : amount;
}

function formatExpiry(expiry: bigint): string {
  const milliseconds = Number(expiry) * 1000;
  if (!Number.isFinite(milliseconds)) return EMPTY;
  return new Date(milliseconds).toLocaleString();
}

function orderStatusLabel(entry: DexOpenOrder, nowSeconds: number): string {
  const { order } = entry;
  if (order.status === DEX_ORDER_STATUS.cancelled) return 'CANCELLED';
  if (order.status === DEX_ORDER_STATUS.filled) return 'FILLED';
  if (order.amount > 0n && order.filled >= order.amount) return 'FILLED';
  if (nowSeconds > 0 && order.expiry <= BigInt(nowSeconds)) return 'EXPIRED';
  return order.filled > 0n ? 'PARTIAL' : 'OPEN';
}

function applySlippageFloor(amount: bigint, basisPoints: number): bigint {
  return amount * BigInt(10_000 - basisPoints) / 10_000n;
}

function formatHash(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function firstDexUnresolvedTransaction(transactions: DexUnresolvedTransactions): DexUnresolvedTransaction | null {
  for (const key of Object.keys(transactions).sort()) {
    const transaction = transactions[key];
    if (transaction) return transaction;
  }
  return null;
}

function formatLevelPrice(priceX18: bigint | null, pool: DexPoolSnapshot): string {
  if (priceX18 === 0n) return 'Empty';
  return formatPriceX18(priceX18, pool.token0, pool.token1);
}

function invertPriceX18(priceX18: bigint): bigint | null {
  return priceX18 > 0n ? 10n ** 36n / priceX18 : null;
}

const BADGE_GRADIENTS = [
  ['#ecd69b', '#8a6a2f'],
  ['#e6e2d6', '#6f6c62'],
  ['#d9bc74', '#4a3813'],
  ['#f0ead8', '#8f887a'],
  ['#c8c2ae', '#55503f'],
  ['#e0c684', '#5c4718'],
] as const;

function badgeGradient(address: string): string {
  let hash = 0;
  for (let index = 2; index < address.length; index += 1) {
    hash = (hash * 31 + address.charCodeAt(index)) >>> 0;
  }
  const [from, to] = BADGE_GRADIENTS[hash % BADGE_GRADIENTS.length];
  return `linear-gradient(135deg, ${from}, ${to})`;
}

const tokenImageCache = new Map<string, string | null>();
const tokenImagePending = new Map<string, Promise<string | null>>();

/**
 * Resolve a token logo: the ERC-20's own `image()` metadata first, then a
 * locally hosted known logo, otherwise null so callers fall back to initials.
 */
function requestTokenImage(addressKey: string): Promise<string | null> {
  const cached = tokenImageCache.get(addressKey);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = tokenImagePending.get(addressKey);
  if (pending) return pending;

  const request = rpcBatch([ethCall(addressKey, SELECTOR.image)])
    .then((results) => normalizeTokenImageUri(decodeString(results[0])) ?? '')
    .catch(() => '')
    .then((uri) => {
      const resolved = uri || KNOWN_TOKEN_IMAGES[addressKey] || null;
      tokenImageCache.set(addressKey, resolved);
      tokenImagePending.delete(addressKey);
      return resolved;
    });
  tokenImagePending.set(addressKey, request);
  return request;
}

function useTokenImage(address: string | null): string | null {
  const key = address?.toLowerCase() ?? null;
  const [image, setImage] = useState<string | null>(
    () => (key ? tokenImageCache.get(key) ?? KNOWN_TOKEN_IMAGES[key] ?? null : null));
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void requestTokenImage(key).then((resolved) => {
      if (!cancelled && resolved !== null) setImage(resolved);
    });
    return () => { cancelled = true; };
  }, [key]);
  return image;
}

function TokenBadge({ token }: { token: DexToken | null }) {
  const remoteImage = useTokenImage(token?.address ?? null);
  // The last source that failed to load; a newly resolved image simply differs.
  const [failedSource, setFailedSource] = useState<string | null>(null);

  if (!token) {
    return (
      <span className="dx-badge dx-badge--empty" aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /></svg>
      </span>
    );
  }
  const initials = (token.symbol?.trim() || token.address.slice(2, 5)).slice(0, 3).toUpperCase();
  const image = remoteImage !== null && remoteImage !== failedSource ? remoteImage : null;
  return (
    <span
      className="dx-badge"
      style={image === null ? { background: badgeGradient(token.address) } : undefined}
      aria-hidden="true"
    >
      {image ? <img src={image} alt="" onError={() => setFailedSource(image)} /> : initials}
    </span>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="16" y1="16" x2="21" y2="21" />
    </svg>
  );
}

function DropletIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2s7 8.05 7 13a7 7 0 1 1-14 0c0-4.95 7-13 7-13Z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function ChevronDownIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function FlipArrowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="4" x2="12" y2="20" />
      <polyline points="18 14 12 20 6 14" />
    </svg>
  );
}

function RepeatIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

type TokenPanelProps = {
  label: string;
  value: string;
  onValueChange?: (value: string) => void;
  inputLabel: string;
  placeholder?: string;
  readOnly?: boolean;
  loading?: boolean;
  token: DexToken | null;
  meta?: string;
  metaActionLabel?: string;
  onMetaAction?: () => void;
  metaActionDisabled?: boolean;
  onTokenClick?: () => void;
  sub?: ReactNode;
  error?: boolean;
};

function TokenPanel({
  label,
  value,
  onValueChange,
  inputLabel,
  placeholder = '0.0',
  readOnly = false,
  loading = false,
  token,
  meta,
  metaActionLabel,
  onMetaAction,
  metaActionDisabled,
  onTokenClick,
  sub,
  error = false,
}: TokenPanelProps) {
  return (
    <div className={`dx-panel${error ? ' dx-panel--error' : ''}`}>
      <div className="dx-panel__top">
        <span>{label}</span>
        {(meta !== undefined || metaActionLabel !== undefined) && (
          <i className="dx-panel__meta">
            {meta}
            {metaActionLabel && (
              <button type="button" onClick={onMetaAction} disabled={metaActionDisabled}>
                {metaActionLabel}
              </button>
            )}
          </i>
        )}
      </div>
      <div className="dx-panel__main">
        <input
          value={loading && readOnly ? '' : value}
          onChange={onValueChange ? (event) => onValueChange(event.target.value) : undefined}
          onFocus={readOnly ? (event) => event.currentTarget.blur() : undefined}
          placeholder={loading && readOnly ? 'Fetching…' : placeholder}
          readOnly={readOnly}
          inputMode={readOnly ? undefined : 'decimal'}
          autoComplete="off"
          spellCheck="false"
          aria-label={inputLabel}
        />
        {onTokenClick && (
          <button type="button" className="dx-token-pill" onClick={onTokenClick} aria-label={`Change token, currently ${tokenSymbol(token)}`}>
            <TokenBadge token={token} />
            <strong>{tokenSymbol(token)}</strong>
            <ChevronDownIcon />
          </button>
        )}
      </div>
      {sub && <small className="dx-panel__sub">{sub}</small>}
    </div>
  );
}

type AmountFieldProps = {
  id: string;
  title: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  symbol: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  note: string;
};

function AmountField({ id, title, hint, value, onChange, symbol, actionLabel, onAction, actionDisabled, note }: AmountFieldProps) {
  return (
    <label className="dx-field" htmlFor={id}>
      <span className="dx-field__top">
        <b>{title}</b>
        <i>{hint}</i>
      </span>
      <div className="dx-field__row">
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          autoComplete="off"
          spellCheck="false"
        />
        <strong>{symbol}</strong>
        {actionLabel && onAction && (
          <button type="button" onClick={onAction} disabled={actionDisabled}>{actionLabel}</button>
        )}
      </div>
      <small>{note}</small>
    </label>
  );
}

type SwapSettingsProps = {
  open: boolean;
  slippage: string;
  onSlippageChange: (value: string) => void;
  onClose: () => void;
};

function SwapSettings({ open, slippage, onSlippageChange, onClose }: SwapSettingsProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const valid = parseSlippageBps(slippage) !== null;

  return (
    <>
      <button type="button" className="dx-backdrop" aria-label="Close swap settings" onClick={onClose} />
      <div className="dx-settings" role="dialog" aria-label="Swap settings">
        <div className="dx-settings__head">
          <span>Max slippage</span>
          <code>{valid ? `${slippage}%` : '—'}</code>
        </div>
        <div className="dx-chip-row" role="group" aria-label="Slippage presets">
          {['0.1', '0.5', '1'].map((preset) => (
            <button
              key={preset}
              type="button"
              className={`dx-chip${slippage === preset ? ' dx-chip--active' : ''}`}
              onClick={() => onSlippageChange(preset)}
            >
              {preset}%
            </button>
          ))}
          <label className={`dx-chip dx-chip--custom${slippage !== '0.1' && slippage !== '0.5' && slippage !== '1' ? ' dx-chip--active' : ''}`}>
            <input
              value={slippage}
              onChange={(event) => onSlippageChange(event.target.value)}
              placeholder="Custom"
              inputMode="decimal"
              autoComplete="off"
              aria-label="Custom slippage percent"
            />
            %
          </label>
        </div>
        <small className="dx-settings__hint">
          {valid
            ? 'Swaps revert instead of filling below this floor.'
            : 'Enter a slippage between 0 and 50%.'}
        </small>
      </div>
    </>
  );
}

type ModalProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
};

function Modal({ title, onClose, children }: ModalProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dx-modal-layer" role="presentation">
      <button type="button" className="dx-backdrop" aria-label={`Close ${title}`} onClick={onClose} />
      <div className="dx-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dx-modal__head">
          <h3>{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

type TokenSelectSide = 'in' | 'out';

type TokenSelectDialogProps = {
  side: TokenSelectSide;
  tokens: DexToken[];
  balances: Array<bigint | null>;
  selectedIn: DexToken | null;
  selectedOut: DexToken | null;
  onSelect: (token: DexToken) => void;
  onClose: () => void;
};

function TokenSelectDialog({ side, tokens, balances, selectedIn, selectedOut, onSelect, onClose }: TokenSelectDialogProps) {
  const [query, setQuery] = useState('');
  const other = side === 'in' ? selectedOut : selectedIn;

  const normalized = query.trim().toLowerCase();
  const visible = tokens.filter((token) =>
    !normalized ||
    token.symbol?.toLowerCase().includes(normalized) ||
    token.address.toLowerCase().includes(normalized));

  return (
    <Modal title={side === 'in' ? 'You pay' : 'You receive'} onClose={onClose}>
      <input
        className="dx-modal-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by symbol or address"
        spellCheck="false"
        autoComplete="off"
      />
      <div className="dx-token-list">
        {visible.map((token, index) => {
          const isSelected = token.address === selectedIn?.address || token.address === selectedOut?.address;
          return (
            <button
              key={token.address}
              type="button"
              className={`dx-token-option${isSelected ? ' dx-token-option--selected' : ''}`}
              onClick={() => onSelect(token)}
            >
              <TokenBadge token={token} />
              <span className="dx-token-option__meta">
                <strong>{tokenSymbol(token)}</strong>
                <code>{shortenAddress(token.address)}</code>
              </span>
              <span className="dx-token-option__balance">{formatTokenValue(balances[index] ?? null, token, 4)}</span>
            </button>
          );
        })}
        {visible.length === 0 && <p className="dx-empty-line">No token in the loaded pool matches “{query}”.</p>}
      </div>
      {other && <small className="dx-modal-hint">The other side of the pair stays {tokenSymbol(other)}.</small>}
    </Modal>
  );
}

/** Balances for the small fixed create-tab token catalog, one batched read at a time. */
function useCreateTokenBalances(wallet: string | null, tokens: CatalogToken[]): Map<string, bigint | null> {
  const [balances, setBalances] = useState<Map<string, bigint | null>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const walletAddress = normalizeDexAddress(wallet);

    (walletAddress
      ? rpcBatch(tokens.map((token) => dexCall(token.address, encodeErc20BalanceOf(walletAddress))), controller.signal)
        .then((results) => {
          const next = new Map<string, bigint | null>();
          tokens.forEach((token, index) => next.set(token.address.toLowerCase(), decodeDexUint(results[index])));
          return next;
        })
        .catch(() => new Map<string, bigint | null>())
      : Promise.resolve(new Map<string, bigint | null>())
    ).then((next) => { if (!cancelled) setBalances(next); });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [wallet, tokens]);

  return balances;
}

type CreateAddressFieldProps = {
  value: string;
  tokens: CatalogToken[];
  balances: Map<string, bigint | null>;
  excludeAddress: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
};

function CreateAddressField({ value, tokens, balances, excludeAddress, open, onOpenChange, onChange }: CreateAddressFieldProps) {
  const [recents, setRecents] = useState<string[]>(() => readRecentCustomTokens());
  const normalized = value.trim().toLowerCase();
  const excluded = excludeAddress?.toLowerCase() ?? '';
  const catalog = tokens.filter((token) => token.address.toLowerCase() !== excluded);
  const owned = catalog.filter((token) => (balances.get(token.address.toLowerCase()) ?? 0n) > 0n);
  const ownedAddresses = new Set(owned.map((token) => token.address.toLowerCase()));
  const visible = catalog.filter((token) =>
    (normalized || !ownedAddresses.has(token.address.toLowerCase())) &&
    (!normalized ||
      token.symbol?.toLowerCase().includes(normalized) ||
      token.address.toLowerCase().includes(normalized)));
  const recentAddresses = recents.filter((address) =>
    address.toLowerCase() !== excluded && !catalog.some((token) => token.address.toLowerCase() === address.toLowerCase()));

  function close(nextValue?: string) {
    const candidate = (nextValue ?? value).trim();
    const isCustom = normalizeDexAddress(candidate) !== null && !catalog.some((token) => token.address.toLowerCase() === candidate.toLowerCase());
    if (isCustom) {
      rememberCustomToken(candidate);
      setRecents(readRecentCustomTokens());
    }
    onOpenChange(false);
  }

  return (
    <div
      className="dx-pickfield"
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          close();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onOpenChange(false);
      }}
    >
      <div className="dx-field__row">
        <input
          value={value}
          onChange={(event) => { onChange(event.target.value); if (!open) onOpenChange(true); }}
          onFocus={() => { if (!open) onOpenChange(true); }}
          placeholder="0x…"
          spellCheck="false"
          autoComplete="off"
        />
        <span className={`dx-pickfield__chevron${open ? ' dx-pickfield__chevron--open' : ''}`} aria-hidden="true">
          <ChevronDownIcon size={13} />
        </span>
      </div>
      {open && (
        <div className="dx-pickmenu" role="listbox" aria-label="Token list">
          {!normalized && catalog.length > 0 && (
            <div className="dx-pickmenu__quick">
              {catalog.map((token) => (
                <button
                  key={token.address}
                  type="button"
                  title={tokenSymbol(token)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { onChange(token.address); close(token.address); }}
                >
                  <TokenBadge token={token} />
                </button>
              ))}
            </div>
          )}

          {!normalized && owned.length > 0 && (
            <>
              <p className="dx-pickmenu__section">내 토큰</p>
              {owned.map((token) => (
                <button
                  key={`owned-${token.address}`}
                  type="button"
                  role="option"
                  aria-selected={value.toLowerCase() === token.address.toLowerCase()}
                  className="dx-pickmenu__option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { onChange(token.address); close(token.address); }}
                >
                  <TokenBadge token={token} />
                  <strong>{tokenSymbol(token)}</strong>
                  <code>{shortenAddress(token.address)}</code>
                  <span className="dx-pickmenu__balance">{formatTokenValue(balances.get(token.address.toLowerCase()) ?? null, token, 4)}</span>
                </button>
              ))}
            </>
          )}

          {!normalized && recentAddresses.length > 0 && (
            <>
              <p className="dx-pickmenu__section">최근 검색</p>
              {recentAddresses.map((address) => (
                <button
                  key={`recent-${address}`}
                  type="button"
                  role="option"
                  aria-selected={value.toLowerCase() === address.toLowerCase()}
                  className="dx-pickmenu__option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { onChange(address); close(address); }}
                >
                  <TokenBadge token={null} />
                  <code>{shortenAddress(address)}</code>
                </button>
              ))}
            </>
          )}

          {visible.map((token) => (
            <button
              key={token.address}
              type="button"
              role="option"
              aria-selected={value.toLowerCase() === token.address.toLowerCase()}
              className="dx-pickmenu__option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { onChange(token.address); close(token.address); }}
            >
              <TokenBadge token={token} />
              <strong>{tokenSymbol(token)}</strong>
              {token.note && <em className="dx-pickmenu__note">{token.note}</em>}
              <code>{shortenAddress(token.address)}</code>
            </button>
          ))}
          <p className="dx-pickmenu__hint">
            {visible.length === 0
              ? 'No match — paste any deployed ERC20 address.'
              : 'Or paste any deployed ERC20 address.'}
          </p>
        </div>
      )}
    </div>
  );
}

type PoolFinderDialogProps = {
  addressInput: string;
  onAddressInput: (value: string) => void;
  onLoadPool: () => void;
  finderTokenA: string;
  finderTokenB: string;
  onFinderTokenA: (value: string) => void;
  onFinderTokenB: (value: string) => void;
  finder: PoolFinderState;
  onFindPools: (event: FormEvent<HTMLFormElement>) => void;
  activePoolAddress: string | null;
  onSelectPool: (address: string) => void;
  onClose: () => void;
};

function PoolFinderDialog({
  addressInput,
  onAddressInput,
  onLoadPool,
  finderTokenA,
  finderTokenB,
  onFinderTokenA,
  onFinderTokenB,
  finder,
  onFindPools,
  activePoolAddress,
  onSelectPool,
  onClose,
}: PoolFinderDialogProps) {
  return (
    <Modal title="Load a SpotPool" onClose={onClose}>
      <label className="dx-finder-address">
        <span>Paste a pool address</span>
        <div>
          <input
            value={addressInput}
            onChange={(event) => onAddressInput(event.target.value)}
            placeholder="0x… deployed SpotPool"
            spellCheck="false"
            autoComplete="off"
          />
          <button type="button" className="dx-button dx-button--ghost" onClick={onLoadPool}>Load</button>
        </div>
      </label>

      <div className="dx-finder-divider"><span>or search the registry by pair</span></div>

      <form className="dx-finder-form" onSubmit={onFindPools}>
        <input
          value={finderTokenA}
          onChange={(event) => onFinderTokenA(event.target.value)}
          placeholder="Token A · 0x…"
          spellCheck="false"
          autoComplete="off"
          aria-label="Token A address"
        />
        <input
          value={finderTokenB}
          onChange={(event) => onFinderTokenB(event.target.value)}
          placeholder="Token B · 0x…"
          spellCheck="false"
          autoComplete="off"
          aria-label="Token B address"
        />
        <button className="dx-button dx-button--ghost" type="submit" disabled={finder.status === 'loading'}>
          {finder.status === 'loading' ? 'Reading…' : 'Search'}
        </button>
      </form>

      <div className="dx-finder-results" aria-live="polite">
        {finder.pairId && (
          <p className="dx-finder-pair">PAIR ID <code>{`${finder.pairId.slice(0, 12)}…${finder.pairId.slice(-6)}`}</code></p>
        )}
        {finder.error && <p className="dx-finder-error">{finder.error}</p>}
        {finder.status === 'done' && finder.pools.length === 0 && (
          <p className="dx-empty-line">The registry holds no SpotPool for this pair yet.</p>
        )}
        {finder.pools.map((address) => (
          <button
            key={address}
            className={`dx-finder-pool${normalizeDexAddress(activePoolAddress)?.toLowerCase() === address.toLowerCase() ? ' dx-finder-pool--active' : ''}`}
            type="button"
            onClick={() => onSelectPool(address)}
          >
            <code>{shortenAddress(address)}</code>
            <span>Load <ChevronDownIcon size={10} /></span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** One row in the "pick a pool" list: pair badges + on-chain TVL, fetched lazily per address. */
function PoolPickRow({
  address,
  token0,
  token1,
  onSelect,
}: {
  address: string;
  token0: DexToken;
  token1: DexToken;
  onSelect: () => void;
}) {
  const [tvlUsd, setTvlUsd] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    rpcBatch([dexCall(address, encodeDexNoArgs(DEX_SELECTOR.getReserves))], controller.signal)
      .then(([result]) => {
        if (cancelled) return;
        setTvlUsd(reservesTvlUsd(token0, token1, decodeDexReserves(result)));
      })
      .catch(() => { if (!cancelled) setTvlUsd(null); });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [address, token0, token1]);

  const [display0, display1] = orderForDisplay(token0, token1);

  return (
    <button type="button" className="dx-pool-row dx-pool-row--pick" role="row" onClick={onSelect}>
      <span className="dx-pool-row__pair" role="cell">
        <span className="dx-pool-row__badges">
          <TokenBadge token={display0} />
          <TokenBadge token={display1} />
        </span>
        <span>
          <strong>{tokenSymbol(display0)} / {tokenSymbol(display1)}</strong>
          <small>{shortenAddress(address)}</small>
        </span>
      </span>
      <span role="cell">{tvlUsd === undefined ? '읽는 중…' : formatUsd(tvlUsd)}</span>
    </button>
  );
}

function MetricCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="dx-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function PoolWizardBreadcrumb({ current, onBack }: { current: string; onBack: () => void }) {
  return (
    <nav className="dx-breadcrumb" aria-label="Breadcrumb">
      <button type="button" onClick={onBack}>내 포지션</button>
      <span aria-hidden="true">›</span>
      <span aria-current="page">{current}</span>
    </nav>
  );
}

const POOL_CREATE_STEP_LABELS: [string, string] = ['토큰 페어 및 수수료 선택', '초기 유동성 예치'];
const POSITION_ADD_STEP_LABELS: [string, string] = ['풀 선택', '가격 범위 및 예치 수량 설정'];

function PoolWizardSteps({ step, labels = POOL_CREATE_STEP_LABELS }: { step: 1 | 2; labels?: [string, string] }) {
  return (
    <ol className="dx-wizard-steps">
      <li className={`dx-wizard-steps__item${step === 1 ? ' dx-wizard-steps__item--active' : ' dx-wizard-steps__item--done'}`}>
        <span>1</span>
        <div>
          <b>1단계</b>
          <strong>{labels[0]}</strong>
        </div>
      </li>
      <li className={`dx-wizard-steps__item${step === 2 ? ' dx-wizard-steps__item--active' : ''}`}>
        <span>2</span>
        <div>
          <b>2단계</b>
          <strong>{labels[1]}</strong>
        </div>
      </li>
    </ol>
  );
}

type PoolFilter = 'all' | 'in-range' | 'out-of-range';

type PoolOverviewProps = {
  connected: boolean;
  overview: PoolOverview;
  filter: PoolFilter;
  onFilterChange: (value: PoolFilter) => void;
  search: string;
  onSearchChange: (value: string) => void;
  onCreatePosition: () => void;
  onCreatePool: () => void;
  onManagePool: (address: string) => void;
};

function PoolOverviewSection({
  connected,
  overview,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  onCreatePosition,
  onCreatePool,
  onManagePool,
}: PoolOverviewProps) {
  const query = search.trim().toLowerCase();
  const filtered = filter === 'out-of-range'
    ? [] // full-range-only AMM: every open position is always "in range"
    : overview.positions.filter((position) => {
      if (!query) return true;
      const [display0, display1] = orderForDisplay(position.token0, position.token1);
      const symbols = `${tokenSymbol(display0)} ${tokenSymbol(display1)}`.toLowerCase();
      return symbols.includes(query) || position.poolAddress.toLowerCase().includes(query);
    });

  const emptyMessage = !connected
    ? '지갑을 연결하면 보유한 포지션을 확인할 수 있어요.'
    : overview.loading && overview.positions.length === 0
      ? '온체인에서 포지션을 읽는 중…'
      : overview.error
        ? overview.error
        : overview.positions.length === 0
          ? '아직 공급한 유동성이 없어요.'
          : filter === 'out-of-range'
            ? '이 풀들은 항상 전체 구간(0 → ∞)이라 범위 밖 포지션이 없어요.'
            : '조건에 맞는 포지션이 없어요.';

  return (
    <div className="dx-pool-overview">
      <div className="dx-pool-overview__head">
        <div>
          <h2>유동성을 공급하고<br />수수료를 획득하세요</h2>
          <p>최대 유동성 프로토콜에 기여하고 보상을 받으세요</p>
        </div>
        <div className="dx-pool-overview__actions">
          <button type="button" className="dx-button dx-button--solid" onClick={onCreatePosition}>
            <DropletIcon /> 포지션 생성
          </button>
          <button type="button" className="dx-button dx-button--ghost" onClick={onCreatePool}>
            <PlusIcon /> 풀 생성
          </button>
          <button type="button" className="dx-button dx-button--ghost" disabled title="곧 지원 예정">
            <PlusIcon /> 토큰 출시
          </button>
        </div>
      </div>

      <div className="dx-pool-stats">
        <div className="dx-pool-stat">
          <span>총 유동성</span>
          <strong>{formatUsd(overview.totalValueUsd)}</strong>
        </div>
        <div className="dx-pool-stat">
          <div className="dx-pool-stat__label">
            <span>총 수수료</span>
            <button type="button" className="dx-pool-stat__claim" disabled>수령</button>
          </div>
          <strong>{formatUsd(overview.totalFeeUsd)}</strong>
        </div>
        <div className="dx-pool-stat">
          <div className="dx-pool-stat__label">
            <span>총 보상</span>
            <button type="button" className="dx-pool-stat__claim" disabled>수령</button>
          </div>
          <strong>{formatUsd(0)}</strong>
        </div>
      </div>

      <h3 className="dx-pool-overview__subhead">내 포지션</h3>

      <div className="dx-pool-toolbar">
        <div className="dx-chip-row">
          {(['all', 'in-range', 'out-of-range'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`dx-chip${filter === value ? ' dx-chip--active' : ''}`}
              onClick={() => onFilterChange(value)}
            >
              {value === 'all' ? '전체' : value === 'in-range' ? '범위 내' : '범위 밖'}
            </button>
          ))}
        </div>
        <label className="dx-pool-search">
          <SearchIcon />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="풀 검색"
            spellCheck="false"
            autoComplete="off"
          />
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="dx-empty-line">{emptyMessage}</p>
      ) : (
        <div className="dx-pool-table" role="table" aria-label="내 포지션">
          <div className="dx-pool-row dx-pool-row--head" role="row">
            <span role="columnheader">풀</span>
            <span role="columnheader">포지션</span>
            <span role="columnheader">분포</span>
            <span role="columnheader">가치</span>
            <span role="columnheader">수수료</span>
            <span role="columnheader">APR</span>
            <span role="columnheader">생성일</span>
          </div>
          {filtered.map((position) => (
            <PoolPositionRow key={position.poolAddress} position={position} onManage={() => onManagePool(position.poolAddress)} />
          ))}
        </div>
      )}
    </div>
  );
}

function PoolPositionRow({ position, onManage }: { position: PoolPosition; onManage: () => void }) {
  const [display0, display1] = orderForDisplay(position.token0, position.token1);
  const flipped = display0 !== position.token0;
  const leftPct = flipped
    ? position.distribution0Pct === null ? 50 : 100 - position.distribution0Pct
    : position.distribution0Pct ?? 50;

  return (
    <button type="button" className="dx-pool-row" role="row" onClick={onManage}>
      <span className="dx-pool-row__pair" role="cell">
        <span className="dx-pool-row__badges">
          <TokenBadge token={display0} />
          <TokenBadge token={display1} />
        </span>
        <span>
          <strong>{tokenSymbol(display0)} / {tokenSymbol(display1)}</strong>
          <small>{formatFeePpm(position.feePpm)}</small>
        </span>
      </span>
      <span className="dx-pool-row__range" role="cell">
        <span>0 → ∞ {tokenSymbol(display1)}</span>
        <small className="dx-pool-row__status"><i /> 범위 내</small>
      </span>
      <span className="dx-pool-row__distribution" role="cell">
        <span className="dx-pool-row__bar"><span style={{ width: `${leftPct}%` }} /></span>
        <small>{Math.round(leftPct)}% {tokenSymbol(display0)} · {Math.round(100 - leftPct)}% {tokenSymbol(display1)}</small>
      </span>
      <span role="cell">{formatUsd(position.valueUsd)}</span>
      <span role="cell">{formatUsd(position.feeEstimateUsd)}</span>
      <span role="cell">{position.aprEstimatePct === null ? EMPTY : `${position.aprEstimatePct.toFixed(2)}%`}</span>
      <span role="cell">{formatAgo(position.firstSeenAt)}</span>
    </button>
  );
}

function priceChartRatio(value: bigint, min: bigint, max: bigint): number {
  if (max <= min) return 0.5;

  const range = max - min;
  const offset = value <= min ? 0n : value >= max ? range : value - min;
  const scaledOffset = offset * PRICE_CHART_RATIO_SCALE / range;
  // The ratio is bounded to one million before converting, never the raw price.
  return Number.parseInt(scaledOffset.toString(), 10) / 1_000_000;
}

function LivePriceChart({
  prices,
  currentPrice,
  token0,
  token1,
}: {
  prices: bigint[];
  currentPrice: bigint | null;
  token0: DexToken | null;
  token1: DexToken | null;
}) {
  const chartPrices = prices.length > 0 ? prices : currentPrice === null ? [] : [currentPrice];
  const latestPrice = chartPrices[chartPrices.length - 1] ?? null;
  const token0Name = tokenSymbol(token0);
  const token1Name = tokenSymbol(token1);

  let minPrice = chartPrices[0] ?? 0n;
  let maxPrice = minPrice;
  for (const price of chartPrices) {
    if (price < minPrice) minPrice = price;
    if (price > maxPrice) maxPrice = price;
  }

  const innerWidth = PRICE_CHART_WIDTH - PRICE_CHART_PADDING.left - PRICE_CHART_PADDING.right;
  const innerHeight = PRICE_CHART_HEIGHT - PRICE_CHART_PADDING.top - PRICE_CHART_PADDING.bottom;
  const plottedPrices = chartPrices.length === 1 ? [chartPrices[0], chartPrices[0]] : chartPrices;
  const points = plottedPrices.map((price, index) => {
    const xRatio = plottedPrices.length <= 1 ? 0.5 : index / (plottedPrices.length - 1);
    const yRatio = priceChartRatio(price, minPrice, maxPrice);
    return {
      x: PRICE_CHART_PADDING.left + xRatio * innerWidth,
      y: PRICE_CHART_PADDING.top + (1 - yRatio) * innerHeight,
    };
  });
  const pointString = points.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const latestPoint = points[points.length - 1] ?? null;
  const latestLabel = formatPriceX18(latestPrice, token0, token1);
  const minLabel = formatPriceX18(chartPrices.length > 0 ? minPrice : null, token0, token1);
  const maxLabel = formatPriceX18(chartPrices.length > 0 ? maxPrice : null, token0, token1);
  const sampleLabel = chartPrices.length === 1 ? '1 sample' : `${chartPrices.length} samples`;

  return (
    <section className="dx-price-chart" aria-labelledby="dx-price-chart-heading">
      <div className="dx-price-chart__head">
        <div>
          <span className="dx-price-chart__eyebrow">LIVE PRICE</span>
          <h2 id="dx-price-chart-heading">{token1Name} per {token0Name}</h2>
        </div>
        <div className="dx-price-chart__latest">
          <strong>{latestLabel}</strong>
          <span>{chartPrices.length > 0 ? sampleLabel : 'Waiting for sample'}</span>
        </div>
      </div>

      <div className="dx-price-chart__plot">
        {chartPrices.length === 0 ? (
          <p className="dx-price-chart__empty">Waiting for a live price sample.</p>
        ) : (
          <svg
            className="dx-price-chart__svg"
            viewBox={`0 0 ${PRICE_CHART_WIDTH} ${PRICE_CHART_HEIGHT}`}
            role="img"
            aria-labelledby="dx-price-chart-title"
            aria-describedby="dx-price-chart-description"
          >
            <title id="dx-price-chart-title">Live {token1Name} per {token0Name} price chart</title>
            <desc id="dx-price-chart-description">
              {`${chartPrices.length} live samples from ${minLabel} to ${maxLabel}. Latest price is ${latestLabel}.`}
            </desc>
            <g aria-hidden="true">
              {[0, 0.5, 1].map((ratio) => {
                const y = PRICE_CHART_PADDING.top + ratio * innerHeight;
                return <line key={ratio} x1={PRICE_CHART_PADDING.left} x2={PRICE_CHART_WIDTH - PRICE_CHART_PADDING.right} y1={y} y2={y} />;
              })}
              <polyline points={pointString} />
              {latestPoint && <circle cx={latestPoint.x} cy={latestPoint.y} r="4" />}
            </g>
          </svg>
        )}
      </div>

      <div className="dx-price-chart__range" aria-label="Chart price range">
        <span><small>LOW</small>{minLabel}</span>
        <span><small>HIGH</small>{maxLabel}</span>
      </div>
    </section>
  );
}

function DexPage({ wallet, onNotify, onActionState }: DexPageProps) {
  const [poolAddressInput, setPoolAddressInput] = useState(DEX_CONFIG.spotPoolAddress ?? '');
  const [activePoolAddress, setActivePoolAddress] = useState<string | null>(DEX_CONFIG.spotPoolAddress);
  const [tab, setTab] = useDexSection();
  const [direction, setDirection] = useState<'token0' | 'token1'>('token0');
  const [amountIn, setAmountIn] = useState('');
  const [slippage, setSlippage] = useState('0.5');
  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoteKey, setQuoteKey] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissedDexError, setDismissedDexError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [unresolvedTransactions, setUnresolvedTransactions] = useState<DexUnresolvedTransactions>(readDexUnresolvedTransactions);
  const [currentOperationWalletKey, setCurrentOperationWalletKey] = useState<string | null>(null);

  const [finderOpen, setFinderOpen] = useState(false);
  const [finderTokenA, setFinderTokenA] = useState('');
  const [finderTokenB, setFinderTokenB] = useState('');
  const [finder, setFinder] = useState<PoolFinderState>(IDLE_POOL_FINDER);
  const [addPicker, setAddPicker] = useState<'a' | 'b' | null>(null);

  const [liquidityView, setLiquidityView] = useState<'overview' | 'add' | 'manage'>('overview');
  const [positionFilter, setPositionFilter] = useState<'all' | 'in-range' | 'out-of-range'>('all');
  const [positionSearch, setPositionSearch] = useState('');
  const poolOverview = usePoolPositions(wallet.address, CREATE_TOKEN_CATALOG);
  const createTokenBalances = useCreateTokenBalances(wallet.address, CREATE_TOKEN_CATALOG);

  const [addAmount0, setAddAmount0] = useState('');
  const [addAmount1, setAddAmount1] = useState('');
  const [liquidityTolerance, setLiquidityTolerance] = useState('1');
  const [removePercent, setRemovePercent] = useState<number>(50);

  const [orderSide, setOrderSide] = useState<OrderSide>('buy');
  const [orderPrice, setOrderPrice] = useState('');
  const [orderAmount, setOrderAmount] = useState('');
  const [orderExpiry, setOrderExpiry] = useState('86400');
  const [nowSeconds, setNowSeconds] = useState(0);
  const [priceHistory, setPriceHistory] = useState<PriceHistoryState>({ poolKey: null, samples: [] });

  const [createTokenA, setCreateTokenA] = useState('');
  const [createTokenB, setCreateTokenB] = useState('');
  const [createFeePpm, setCreateFeePpm] = useState('3000');
  const [createTickSize, setCreateTickSize] = useState('1');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tokenSelect, setTokenSelect] = useState<TokenSelectSide | null>(null);
  const [rateInverted, setRateInverted] = useState(false);
  const [createPicker, setCreatePicker] = useState<'a' | 'b' | null>(null);
  const [justCreatedPool, setJustCreatedPool] = useState(false);

  const writeInFlightRef = useRef(false);
  const writeLockWalletRef = useRef<string | null>(null);
  const operationSequenceRef = useRef(0);
  const currentOperationRef = useRef<DexOperation | null>(null);
  const operationProgressRef = useRef<DexOperationProgress>({ hash: null, unresolved: false });
  const mountedRef = useRef(true);

  const dex = useDex(activePoolAddress, wallet.address);
  const { readSpotQuote } = dex;
  const pool = dex.pool;
  const registryReady = dex.registryWiring.status === 'healthy';
  const poolVerified = pool?.valid === true && registryReady;
  const poolReady = poolVerified && pool !== null && pool.hasLiquidity;
  const tokenIn = pool && direction === 'token0' ? pool.token0 : pool?.token1 ?? null;
  const tokenOut = pool && direction === 'token0' ? pool.token1 : pool?.token0 ?? null;
  const walletToken = direction === 'token0' ? dex.walletTokens?.token0 ?? null : dex.walletTokens?.token1 ?? null;
  const walletToken0 = dex.walletTokens?.token0 ?? null;
  const walletToken1 = dex.walletTokens?.token1 ?? null;
  const walletShares = dex.walletTokens?.shares ?? null;
  const inputAmount = parseTokenAmount(amountIn, tokenIn?.decimals ?? null);
  const quotePoolKey = pool?.reserves === null || pool?.reserves === undefined
    ? ''
    : `${pool.reserves.reserve0.toString()}:${pool.reserves.reserve1.toString()}:${pool.feePpm?.toString() ?? ''}`;
  const quoteRequestKey = `${activePoolAddress ?? ''}:${direction}:${tokenIn?.address ?? ''}:${amountIn}:${inputAmount?.toString() ?? ''}:${quotePoolKey}`;
  const quoteIsCurrent = quoteRequestKey === (quoteKey ?? '');
  const currentQuote = poolReady && quoteIsCurrent ? quote : null;
  const currentQuoteError = poolReady && quoteIsCurrent ? quoteError : null;
  const currentQuoteLoading = poolReady && inputAmount !== null && (quoteIsCurrent ? quoteLoading : true);
  const slippageBps = parseSlippageBps(slippage);
  const minimumOut = currentQuote !== null && slippageBps !== null
    ? applySlippageFloor(currentQuote, slippageBps)
    : null;
  const spotForRate = pool?.spotPriceX18 ?? pool?.reservePriceX18 ?? null;
  const selectedPoolKey = normalizeDexAddress(activePoolAddress);
  const loadedPoolKey = normalizeDexAddress(pool?.address);
  const chartPoolReady = selectedPoolKey !== null && loadedPoolKey === selectedPoolKey;
  const chartSamples = chartPoolReady && priceHistory.poolKey === selectedPoolKey
    ? priceHistory.samples
    : [];
  const priceToken1Per0 = formatPriceX18(spotForRate, pool?.token0 ?? null, pool?.token1 ?? null);
  const priceToken0Per1 = formatPriceX18(
    spotForRate === null ? null : invertPriceX18(spotForRate),
    pool?.token1 ?? null,
    pool?.token0 ?? null,
  );
  const naturalRate = direction === 'token0' ? priceToken1Per0 : priceToken0Per1;
  const inverseRate = direction === 'token0' ? priceToken0Per1 : priceToken1Per0;
  const swapRateValue = rateInverted ? inverseRate : naturalRate;
  const swapRateBase = rateInverted
    ? (direction === 'token0' ? tokenOut : tokenIn)
    : tokenIn;
  const onchainAllowance = walletToken?.allowance ?? null;
  const approvalRequired = inputAmount !== null && (onchainAllowance === null || inputAmount > onchainAllowance);
  // A short WMON balance is not a dead end: MON wraps into it 1:1, so every
  // spend path treats wrappable MON as part of the balance.
  const nativeBalance = dex.walletTokens?.native ?? null;
  const swapWrap = monWrapShortfall(tokenIn, walletToken?.balance, inputAmount, nativeBalance);
  const insufficientBalance = wallet.address !== null &&
    walletToken?.balance != null &&
    inputAmount !== null &&
    inputAmount > walletToken.balance &&
    swapWrap === null;
  const walletReadReady = wallet.address === null || (
    walletToken !== null &&
    walletToken.balance !== null &&
    walletToken.allowance !== null
  );
  const actionReady = poolReady &&
    inputAmount !== null &&
    currentQuote !== null &&
    currentQuote > 0n &&
    minimumOut !== null &&
    slippageBps !== null &&
    walletReadReady &&
    !insufficientBalance;
  const visibleDexError = dex.error !== null && dex.error !== dismissedDexError ? dex.error : null;
  const pageError = actionError ?? visibleDexError ?? currentQuoteError;
  const currentWalletKey = wallet.address ? walletAddressKey(wallet.address) : null;
  const operationWalletTransaction = currentOperationWalletKey === null
    ? null
    : unresolvedTransactions[currentOperationWalletKey] ?? null;
  const firstStoredTransaction = firstDexUnresolvedTransaction(unresolvedTransactions);
  const unresolvedTransaction = currentWalletKey !== null
    ? unresolvedTransactions[currentWalletKey] ?? operationWalletTransaction ?? firstStoredTransaction
    : operationWalletTransaction ?? firstStoredTransaction;

  const liquiditySlippageBps = parseSlippageBps(liquidityTolerance);
  const amount0In = parseTokenAmount(addAmount0, pool?.token0?.decimals ?? null);
  const amount1In = parseTokenAmount(addAmount1, pool?.token1?.decimals ?? null);
  const poolRatioReady = pool?.reserves != null && pool.reserves.reserve0 > 0n && pool.reserves.reserve1 > 0n;
  const approvalRequired0 = amount0In !== null && (walletToken0?.allowance == null || amount0In > walletToken0.allowance);
  const approvalRequired1 = amount1In !== null && (walletToken1?.allowance == null || amount1In > walletToken1.allowance);
  const wrap0 = monWrapShortfall(pool?.token0 ?? null, walletToken0?.balance, amount0In, nativeBalance);
  const wrap1 = monWrapShortfall(pool?.token1 ?? null, walletToken1?.balance, amount1In, nativeBalance);
  const insufficient0 = amount0In !== null && walletToken0?.balance != null && amount0In > walletToken0.balance && wrap0 === null;
  const insufficient1 = amount1In !== null && walletToken1?.balance != null && amount1In > walletToken1.balance && wrap1 === null;
  const addLiquidityReady = poolVerified &&
    amount0In !== null &&
    amount1In !== null &&
    liquiditySlippageBps !== null &&
    !insufficient0 &&
    !insufficient1;
  const removeShares = walletShares === null || walletShares === 0n
    ? null
    : walletShares * BigInt(removePercent) / 100n;
  const shareOfPoolPpm = walletShares !== null && pool?.totalShares != null && pool.totalShares > 0n
    ? walletShares * 1_000_000n / pool.totalShares
    : null;
  const redeemable = useMemo(() => {
    if (removeShares === null || removeShares === 0n) return null;
    if (pool?.reserves == null || pool.totalShares == null || pool.totalShares === 0n) return null;
    return {
      amount0: pool.reserves.reserve0 * removeShares / pool.totalShares,
      amount1: pool.reserves.reserve1 * removeShares / pool.totalShares,
    };
  }, [pool?.reserves, pool?.totalShares, removeShares]);

  const baseToken = pool?.token0 ?? null;
  const quoteToken = pool?.token1 ?? null;
  const orderPriceX18 = parsePriceToX18(orderPrice, baseToken?.decimals ?? null, quoteToken?.decimals ?? null);
  const orderAmountRaw = parseTokenAmount(orderAmount, baseToken?.decimals ?? null);
  const orderEscrowAmount = orderPriceX18 !== null && orderAmountRaw !== null
    ? orderEscrow(orderSide, orderPriceX18, orderAmountRaw)
    : null;
  const escrowToken = orderSide === 'buy' ? quoteToken : baseToken;
  const orderQuoteValue = orderPriceX18 !== null && orderAmountRaw !== null
    ? orderPriceX18 * orderAmountRaw / 10n ** 18n
    : null;
  const proceedsToken = orderSide === 'buy' ? baseToken : quoteToken;
  const orderProceeds = orderSide === 'buy' ? orderAmountRaw : orderQuoteValue;
  const escrowWalletToken = orderSide === 'buy' ? walletToken1 : walletToken0;
  const escrowApprovalRequired = orderEscrowAmount !== null &&
    (escrowWalletToken?.orderbookAllowance == null || orderEscrowAmount > escrowWalletToken.orderbookAllowance);
  const escrowWrap = monWrapShortfall(escrowToken, escrowWalletToken?.balance, orderEscrowAmount, nativeBalance);
  const escrowShort = orderEscrowAmount !== null &&
    escrowWalletToken?.balance != null &&
    orderEscrowAmount > escrowWalletToken.balance &&
    escrowWrap === null;
  const bookInitialized = dex.orderbook?.bookConfig?.initialized === true;
  const orderReady = poolVerified &&
    bookInitialized &&
    orderPriceX18 !== null &&
    orderPriceX18 > 0n &&
    orderAmountRaw !== null &&
    orderEscrowAmount !== null &&
    orderEscrowAmount > 0n &&
    !escrowShort &&
    nowSeconds > 0;
  const expirySeconds = parseWholeUint(orderExpiry);
  const orderExpiryAt = nowSeconds > 0 && expirySeconds !== null ? BigInt(nowSeconds) + expirySeconds : null;
  const openOrders = dex.myOrders.filter((entry) => ['OPEN', 'PARTIAL'].includes(orderStatusLabel(entry, nowSeconds)));
  const closedOrders = dex.myOrders.filter((entry) => !openOrders.includes(entry));

  const createTokenCatalog = useMemo<CatalogToken[]>(() => {
    const byKey = new Map<string, CatalogToken>();
    const add = (token: CatalogToken | null) => {
      if (token) byKey.set(token.address.toLowerCase(), token);
    };
    CREATE_TOKEN_CATALOG.forEach(add);
    add(pool?.token0 ?? null);
    add(pool?.token1 ?? null);
    return [...byKey.values()];
  }, [pool?.token0, pool?.token1]);

  const createTokenAAddress = normalizeDexAddress(createTokenA);
  const createTokenBAddress = normalizeDexAddress(createTokenB);
  const createPairId = createTokenAAddress && createTokenBAddress
    ? computePairId(createTokenAAddress, createTokenBAddress)
    : null;
  const createFee = parseWholeUint(createFeePpm);
  const createTick = parseWholeUint(createTickSize);
  const createFeeWithinLimit = createFee !== null &&
    (dex.registryWiring.maxLpFeeRatePpm === null || createFee <= dex.registryWiring.maxLpFeeRatePpm);
  const createReady = registryReady &&
    createPairId !== null &&
    createFee !== null &&
    createFeeWithinLimit &&
    createTick !== null &&
    createTick > 0n;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const tick = () => setNowSeconds(Math.floor(Date.now() / 1000));
    tick();
    const timerId = globalThis.setInterval(tick, 60_000);
    return () => globalThis.clearInterval(timerId);
  }, []);

  useEffect(() => {
    const selectedPoolKey = normalizeDexAddress(activePoolAddress);
    const loadedPoolKey = normalizeDexAddress(pool?.address);
    if (selectedPoolKey === null || loadedPoolKey !== selectedPoolKey || pool?.valid !== true || !pool.hasLiquidity) {
      const resetTimer = globalThis.setTimeout(() => {
        setPriceHistory((previous) => {
          if (previous.poolKey === selectedPoolKey && previous.samples.length === 0) return previous;
          return { poolKey: selectedPoolKey, samples: [] };
        });
      }, 0);
      return () => globalThis.clearTimeout(resetTimer);
    }

    const price = pool.spotPriceX18 ?? pool.reservePriceX18;
    if (price === null) return;
    const sampleTimer = globalThis.setTimeout(() => {
      setPriceHistory((previous) => {
        const previousSamples = previous.poolKey === selectedPoolKey ? previous.samples : [];
        return {
          poolKey: selectedPoolKey,
          samples: [...previousSamples, price].slice(-MAX_PRICE_SAMPLES),
        };
      });
    }, 0);
    return () => globalThis.clearTimeout(sampleTimer);
  }, [activePoolAddress, pool]);

  useEffect(() => {
    if (!poolReady || tokenIn === null || tokenOut === null || inputAmount === null) {
      return;
    }

    const controller = new AbortController();
    void readSpotQuote(tokenIn.address, inputAmount, controller.signal)
      .then((nextQuote) => {
        if (controller.signal.aborted) return;
        setQuoteKey(quoteRequestKey);
        if (nextQuote === null) {
          setQuote(null);
          setQuoteError('The pool did not return a quote for this amount.');
        } else {
          setQuote(nextQuote);
          setQuoteError(null);
        }
        setQuoteLoading(false);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setQuoteKey(quoteRequestKey);
          setQuote(null);
          setQuoteError(error instanceof Error ? error.message : 'Could not update the spot quote.');
          setQuoteLoading(false);
        }
      });

    return () => controller.abort();
  }, [inputAmount, poolReady, quoteRequestKey, readSpotQuote, tokenIn, tokenOut]);

  function notifyError(message: string) {
    setActionError(message);
    onNotify(message, 'error');
  }

  function isCurrentOperation(operation: DexOperation): boolean {
    return currentOperationRef.current?.token === operation.token;
  }

  function updateActionState(operation: DexOperation, label: string | null) {
    if (isCurrentOperation(operation)) onActionState(label);
  }

  function updateBusyAction(operation: DexOperation, label: string | null) {
    if (mountedRef.current && isCurrentOperation(operation)) setBusyAction(label);
  }

  function beginOperation(label: string): DexOperation {
    const operation: DexOperation = {
      token: operationSequenceRef.current + 1,
      label,
      walletAddress: wallet.address,
      walletKey: wallet.address ? walletAddressKey(wallet.address) : null,
    };
    operationProgressRef.current = { hash: null, unresolved: false };
    operationSequenceRef.current = operation.token;
    currentOperationRef.current = operation;
    setCurrentOperationWalletKey(operation.walletKey);
    writeInFlightRef.current = true;
    writeLockWalletRef.current = operation.walletKey;
    return operation;
  }

  function finishOperation(operation: DexOperation) {
    if (!isCurrentOperation(operation) || operationProgressRef.current.unresolved) return;
    if (mountedRef.current) setBusyAction(null);
    onActionState(null);
    writeInFlightRef.current = false;
    writeLockWalletRef.current = null;
    currentOperationRef.current = null;
    setCurrentOperationWalletKey(null);
  }

  function selectPool(nextAddress: string) {
    setPoolAddressInput(nextAddress);
    setActivePoolAddress(normalizeDexAddress(nextAddress) ?? nextAddress);
    setActionError(null);
    setQuote(null);
    setAmountIn('');
    setAddAmount0('');
    setAddAmount1('');
  }

  function handleLoadPool() {
    setActionError(null);
    setQuote(null);
    setAmountIn('');
    const nextAddress = poolAddressInput.trim();
    setActivePoolAddress(nextAddress || null);
    if (nextAddress && !normalizeDexAddress(nextAddress)) {
      setActionError('Enter a valid 20-byte SpotPool address.');
    }
  }

  function handleClearErrors() {
    setActionError(null);
    setQuoteError(null);
    if (dex.error !== null) setDismissedDexError(dex.error);
  }

  function handleFindPools(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runFinderLookup();
  }

  async function runFinderLookup() {
    const tokenA = normalizeDexAddress(finderTokenA);
    const tokenB = normalizeDexAddress(finderTokenB);
    if (!tokenA || !tokenB) {
      setFinder({ status: 'error', pairId: null, pools: [], error: 'Both fields need a valid 20-byte token address.', tokenA, tokenB });
      return;
    }

    const pairId = computePairId(tokenA, tokenB);
    if (pairId === null) {
      setFinder({ status: 'error', pairId: null, pools: [], error: 'A pair needs two different tokens.', tokenA, tokenB });
      return;
    }

    setFinder({ status: 'loading', pairId, pools: [], error: null, tokenA, tokenB });
    try {
      const pools = await readSpotPoolsForPair(pairId);
      if (!mountedRef.current) return;
      if (pools === null) {
        setFinder({ status: 'error', pairId, pools: [], error: 'The registry did not return a readable pool list.', tokenA, tokenB });
        return;
      }
      setFinder({ status: 'done', pairId, pools, error: null, tokenA, tokenB });
    } catch (findError: unknown) {
      if (!mountedRef.current) return;
      setFinder({
        status: 'error',
        pairId,
        pools: [],
        error: findError instanceof Error ? findError.message : 'The registry lookup failed.',
        tokenA,
        tokenB,
      });
    }
  }

  useEffect(() => {
    if (liquidityView !== 'add') return;
    const tokenA = normalizeDexAddress(finderTokenA);
    const tokenB = normalizeDexAddress(finderTokenB);
    if (!tokenA || !tokenB || tokenA === tokenB) return;
    void runFinderLookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liquidityView, finderTokenA, finderTokenB]);

  async function ensureMonadWallet(): Promise<boolean> {
    if (!wallet.address) {
      const result = await wallet.connect();
      if (result.error) {
        notifyError(result.error);
      } else {
        onNotify('Wallet connected. Run the DEX action again when the wallet is ready.');
      }
      return false;
    }

    if (!wallet.onMonad) {
      try {
        await wallet.switchToMonad();
        onNotify('Monad is ready. Run the DEX action again to sign.');
      } catch (switchError) {
        notifyError(switchError instanceof Error ? switchError.message : 'Switch your wallet to Monad before trading.');
      }
      return false;
    }

    return true;
  }

  function canStartWrite(): boolean {
    if (unresolvedTransaction !== null) {
      notifyError(`Transaction ${formatHash(unresolvedTransaction.hash)} is unresolved. Verify it before sending another DEX action.`);
      return false;
    }
    if (writeInFlightRef.current || currentOperationRef.current !== null) {
      notifyError('Another DEX wallet action is already in progress.');
      return false;
    }
    return true;
  }

  async function sendDexTransaction(
    label: string,
    request: { to: string; data: string; value?: bigint },
    existingOperation?: DexOperation,
  ): Promise<boolean> {
    if (unresolvedTransaction !== null) {
      notifyError(`Transaction ${formatHash(unresolvedTransaction.hash)} is unresolved. Verify it before sending another DEX action.`);
      return false;
    }
    if (existingOperation === undefined && (writeInFlightRef.current || currentOperationRef.current !== null)) {
      notifyError('Another DEX wallet action is already in progress.');
      return false;
    }

    const operation = existingOperation ?? beginOperation(label);
    if (!isCurrentOperation(operation)) return false;

    const submittedWalletAddress = operation.walletAddress;
    const submittedWalletKey = operation.walletKey;
    if (existingOperation === undefined) {
      updateBusyAction(operation, `${label} / waiting for wallet`);
      updateActionState(operation, `${label} / waiting for wallet`);
    }
    setActionError(null);
    try {
      const submittedHash = await wallet.sendTransaction(request);
      if (!isCurrentOperation(operation)) return false;
      operationProgressRef.current.hash = submittedHash;
      if (submittedWalletAddress !== null && submittedWalletKey !== null) {
        const nextUnresolvedTransaction = {
          hash: submittedHash,
          label,
          walletAddress: submittedWalletAddress,
        };
        persistDexUnresolvedTransaction(nextUnresolvedTransaction);
        operationProgressRef.current.unresolved = true;
        if (mountedRef.current) {
          setUnresolvedTransactions((transactions) => {
            if (!isCurrentOperation(operation) || !mountedRef.current) return transactions;
            return {
              ...transactions,
              [submittedWalletKey]: nextUnresolvedTransaction,
            };
          });
        }
      }
      updateBusyAction(operation, `${label} / pending`);
      updateActionState(operation, `${label} / pending`);
      onNotify(`${label} submitted ${formatHash(submittedHash)}. Waiting for Monad confirmation.`);
      await wallet.waitForTransaction(submittedHash);
      if (!isCurrentOperation(operation)) return false;

      if (submittedWalletAddress !== null && submittedWalletKey !== null) {
        if (!clearDexUnresolvedTransaction(submittedWalletAddress, submittedHash)) {
          const reloadedTransactions = reloadDexUnresolvedTransactions();
          if (mountedRef.current && reloadedTransactions !== null) setUnresolvedTransactions(reloadedTransactions);
          return false;
        }
        if (mountedRef.current) {
          setUnresolvedTransactions((transactions) => {
            if (!isCurrentOperation(operation)) return transactions;
            const currentTransaction = transactions[submittedWalletKey];
            if (!currentTransaction || !sameTransactionHash(currentTransaction.hash, submittedHash)) return transactions;
            const nextTransactions = { ...transactions };
            delete nextTransactions[submittedWalletKey];
            return nextTransactions;
          });
        }
        operationProgressRef.current.unresolved = false;
      }
      onNotify(`${label} confirmed. DEX readings will refresh.`);
      if (mountedRef.current) dex.refresh();
      return true;
    } catch (error: unknown) {
      if (!isCurrentOperation(operation)) return false;
      const message = error instanceof Error ? error.message : `${label} failed.`;
      const submittedHash = operationProgressRef.current.hash;
      if (submittedHash !== null && submittedWalletAddress !== null && message !== 'Transaction was mined but reverted on Monad.') {
        operationProgressRef.current.unresolved = true;
        const unresolvedRecord = {
          hash: submittedHash,
          label,
          walletAddress: submittedWalletAddress,
        };
        persistDexUnresolvedTransaction(unresolvedRecord);
        if (submittedWalletKey !== null && mountedRef.current) {
          setUnresolvedTransactions((transactions) => {
            if (!isCurrentOperation(operation)) return transactions;
            const currentTransaction = transactions[submittedWalletKey];
            if (currentTransaction && !sameTransactionHash(currentTransaction.hash, submittedHash)) return transactions;
            return { ...transactions, [submittedWalletKey]: unresolvedRecord };
          });
        }
        updateBusyAction(operation, `${label} / receipt verification required`);
        updateActionState(operation, `${label} / receipt verification required`);
        notifyError(`${label} submitted ${formatHash(submittedHash)}, but its receipt could not be verified. Verify it before retrying.`);
      } else if (submittedHash !== null && submittedWalletAddress !== null) {
        if (!clearDexUnresolvedTransaction(submittedWalletAddress, submittedHash)) {
          const reloadedTransactions = reloadDexUnresolvedTransactions();
          if (mountedRef.current && reloadedTransactions !== null) setUnresolvedTransactions(reloadedTransactions);
          return false;
        }
        if (submittedWalletKey !== null && mountedRef.current) {
          setUnresolvedTransactions((transactions) => {
            if (!isCurrentOperation(operation)) return transactions;
            const currentTransaction = transactions[submittedWalletKey];
            if (!currentTransaction || !sameTransactionHash(currentTransaction.hash, submittedHash)) return transactions;
            const nextTransactions = { ...transactions };
            delete nextTransactions[submittedWalletKey];
            return nextTransactions;
          });
        }
        operationProgressRef.current.unresolved = false;
        notifyError(message);
      } else {
        notifyError(message);
      }
      return false;
    } finally {
      if (isCurrentOperation(operation) && !operationProgressRef.current.unresolved) finishOperation(operation);
    }
  }

  async function simulateThenSend(
    label: string,
    request: { to: string; data: string },
    onSimulated?: (returnData: string) => void,
  ): Promise<boolean> {
    if (!canStartWrite()) return false;
    if (!(await ensureMonadWallet())) return false;
    const sender = wallet.address;
    if (!sender) return false;

    const operation = beginOperation(label);
    setActionError(null);
    updateBusyAction(operation, `${label} / simulating`);
    updateActionState(operation, `${label} / simulating live execution`);

    const simulation = await simulateDexWrite(sender, request.to, request.data);
    if (!isCurrentOperation(operation)) return false;
    if (!simulation.ok) {
      notifyError(`${label} would revert. ${simulation.error ?? 'The pre-flight simulation failed.'}`);
      finishOperation(operation);
      return false;
    }
    if (simulation.returnData !== null) onSimulated?.(simulation.returnData);

    return sendDexTransaction(label, request, operation);
  }

  /**
   * Top a WMON balance up from native MON. Sent as its own transaction and its
   * own step, like an approval: the wallet has to sign it before the action it
   * funds can be signed.
   */
  async function wrapMon(token: DexToken, shortfall: bigint): Promise<void> {
    const wrapped = await sendDexTransaction('Wrap MON', {
      to: token.address,
      data: encodeDexNoArgs(DEX_SELECTOR.deposit),
      value: shortfall,
    });
    if (wrapped) {
      onNotify(`Wrapped ${formatUnits(shortfall, 18, 4)} MON into ${tokenSymbol(token)}. Run the action again to continue.`);
    }
  }

  function isWmonToken(token: DexToken | null): token is DexToken {
    return token !== null && token.address.toLowerCase() === TOKENS.wmon.toLowerCase();
  }

  async function readTokenBalance(tokenAddress: string, owner: string): Promise<bigint | null> {
    const [result] = await rpcBatch([dexCall(tokenAddress, encodeErc20BalanceOf(owner))]);
    return decodeDexUint(result);
  }

  /**
   * Mirror of `wrapMon`: unwrap WMON back to native MON so a swap or a
   * liquidity withdrawal that lands in WMON is felt by the trader as MON,
   * same as the wrap step makes native MON spendable on the way in.
   */
  async function unwrapMon(token: DexToken, amount: bigint): Promise<void> {
    if (amount <= 0n) return;
    const unwrapped = await sendDexTransaction('Unwrap MON', {
      to: token.address,
      data: encodeWithdraw(amount),
    });
    if (unwrapped) {
      onNotify(`Unwrapped ${formatUnits(amount, 18, 4)} MON back to native MON.`);
    }
  }

  async function handleSwap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canStartWrite()) return;
    if (!poolReady || pool === null || tokenIn === null || tokenOut === null) {
      notifyError('Load a verified SpotPool with nonzero reserves before trading.');
      return;
    }
    if (inputAmount === null || currentQuote === null || currentQuote === 0n || minimumOut === null || slippageBps === null) {
      notifyError('Enter a valid amount and wait for a fresh spot quote.');
      return;
    }
    if (insufficientBalance) {
      notifyError(`The connected wallet does not have enough ${tokenSymbol(tokenIn)}.`);
      return;
    }
    if (!(await ensureMonadWallet())) return;
    const recipient = wallet.address;
    if (!recipient) return;

    if (swapWrap !== null) {
      await wrapMon(tokenIn, swapWrap);
      return;
    }

    if (approvalRequired) {
      const approved = await sendDexTransaction(`Approve ${tokenSymbol(tokenIn)}`, {
        to: tokenIn.address,
        data: encodeErc20Approve(pool.address, inputAmount),
      });
      if (approved) {
        onNotify(`Approval confirmed for ${formatUnits(inputAmount, tokenIn.decimals ?? 18, 4)} ${tokenSymbol(tokenIn)}.`);
      }
      return;
    }

    const swapLabel = `Swap ${tokenSymbol(tokenIn)} for ${tokenSymbol(tokenOut)}`;
    const swapOperation = beginOperation(swapLabel);
    setActionError(null);
    updateBusyAction(swapOperation, `${swapLabel} / simulating`);
    updateActionState(swapOperation, `${swapLabel} / simulating live execution`);
    try {
      let simulatedOutput: bigint | null;
      try {
        simulatedOutput = await dex.simulateSwapExactIn(tokenIn.address, inputAmount, 1n, recipient);
      } catch {
        throw new Error('Final swap simulation failed. Check the live allowance, token balance, and pool state before signing.');
      }
      if (simulatedOutput === null) {
        throw new Error('Final swap simulation failed. Check the live allowance, token balance, and pool state before signing.');
      }
      if (simulatedOutput === 0n) {
        throw new Error('Final swap simulation returned zero output. No swap was signed.');
      }

      const simulatedMinimumOut = applySlippageFloor(simulatedOutput, slippageBps);
      if (simulatedMinimumOut === 0n) {
        throw new Error('Final swap output is too small for the selected slippage. No zero-minimum swap will be signed.');
      }

      const outputIsWmon = isWmonToken(tokenOut);
      const wmonBalanceBefore = outputIsWmon ? await readTokenBalance(tokenOut.address, recipient) : null;

      const swapped = await sendDexTransaction(swapLabel, {
        to: pool.address,
        data: encodeSwapExactIn(tokenIn.address, inputAmount, simulatedMinimumOut, recipient),
      }, swapOperation);
      if (swapped) {
        setAmountIn('');
        setQuote(null);
        if (outputIsWmon && wmonBalanceBefore !== null) {
          const wmonBalanceAfter = await readTokenBalance(tokenOut.address, recipient);
          const received = wmonBalanceAfter !== null && wmonBalanceAfter > wmonBalanceBefore
            ? wmonBalanceAfter - wmonBalanceBefore
            : null;
          if (received !== null) await unwrapMon(tokenOut, received);
        }
      }
    } catch (swapError: unknown) {
      if (!isCurrentOperation(swapOperation)) return;
      notifyError(swapError instanceof Error ? swapError.message : 'Final swap simulation failed.');
      finishOperation(swapOperation);
    }
  }

  async function handleAddLiquidity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canStartWrite()) return;
    if (!poolVerified || pool === null || pool.token0 === null || pool.token1 === null) {
      notifyError('Load a registry-verified SpotPool before adding liquidity.');
      return;
    }
    if (amount0In === null || amount1In === null || liquiditySlippageBps === null) {
      notifyError('Enter both deposit amounts within the token precision.');
      return;
    }
    if (insufficient0 || insufficient1) {
      notifyError('The connected wallet does not hold enough of one of the pair tokens.');
      return;
    }
    if (!(await ensureMonadWallet())) return;
    const recipient = wallet.address;
    if (!recipient) return;

    if (wrap0 !== null) {
      await wrapMon(pool.token0, wrap0);
      return;
    }
    if (wrap1 !== null) {
      await wrapMon(pool.token1, wrap1);
      return;
    }

    if (approvalRequired0) {
      const approved = await sendDexTransaction(`Approve ${tokenSymbol(pool.token0)}`, {
        to: pool.token0.address,
        data: encodeErc20Approve(pool.address, amount0In),
      });
      if (approved) onNotify(`${tokenSymbol(pool.token0)} approved. Approve the second token next.`);
      return;
    }
    if (approvalRequired1) {
      const approved = await sendDexTransaction(`Approve ${tokenSymbol(pool.token1)}`, {
        to: pool.token1.address,
        data: encodeErc20Approve(pool.address, amount1In),
      });
      if (approved) onNotify(`${tokenSymbol(pool.token1)} approved. Deposit is ready to sign.`);
      return;
    }

    const amount0Min = applySlippageFloor(amount0In, liquiditySlippageBps);
    const amount1Min = applySlippageFloor(amount1In, liquiditySlippageBps);
    if (amount0Min === 0n || amount1Min === 0n) {
      notifyError('The slippage floor rounds one side to zero. Increase the deposit or tighten the tolerance.');
      return;
    }

    const added = await simulateThenSend(
      `Add liquidity to ${shortenAddress(pool.address)}`,
      { to: pool.address, data: encodeAddLiquidity(amount0In, amount1In, amount0Min, amount1Min, recipient) },
    );
    if (added) {
      setAddAmount0('');
      setAddAmount1('');
    }
  }

  async function handleRemoveLiquidity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canStartWrite()) return;
    if (!poolVerified || pool === null) {
      notifyError('Load a registry-verified SpotPool before withdrawing.');
      return;
    }
    if (removeShares === null || removeShares === 0n) {
      notifyError('This wallet holds no LP shares in the loaded pool.');
      return;
    }
    if (!(await ensureMonadWallet())) return;
    const recipient = wallet.address;
    if (!recipient) return;

    const bps = liquiditySlippageBps ?? 100;
    const amount0Min = redeemable ? applySlippageFloor(redeemable.amount0, bps) : 1n;
    const amount1Min = redeemable ? applySlippageFloor(redeemable.amount1, bps) : 1n;

    const wmonSide = isWmonToken(pool.token0) ? pool.token0 : isWmonToken(pool.token1) ? pool.token1 : null;
    const wmonBalanceBefore = wmonSide ? await readTokenBalance(wmonSide.address, recipient) : null;

    const removed = await simulateThenSend(
      `Remove ${removePercent}% of liquidity`,
      {
        to: pool.address,
        data: encodeRemoveLiquidity(removeShares, amount0Min > 0n ? amount0Min : 1n, amount1Min > 0n ? amount1Min : 1n, recipient),
      },
    );
    if (removed && wmonSide && wmonBalanceBefore !== null) {
      const wmonBalanceAfter = await readTokenBalance(wmonSide.address, recipient);
      const received = wmonBalanceAfter !== null && wmonBalanceAfter > wmonBalanceBefore
        ? wmonBalanceAfter - wmonBalanceBefore
        : null;
      if (received !== null) await unwrapMon(wmonSide, received);
    }
  }

  async function handlePlaceOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canStartWrite()) return;
    if (!poolVerified || pool === null || pool.pairId === null) {
      notifyError('Load a registry-verified SpotPool before placing an order.');
      return;
    }
    if (!bookInitialized) {
      notifyError('The Orderbook has no initialised book for this pair.');
      return;
    }
    if (orderPriceX18 === null || orderPriceX18 === 0n || orderAmountRaw === null || orderEscrowAmount === null || orderEscrowAmount === 0n) {
      notifyError('Enter a limit price and an amount within the token precision.');
      return;
    }
    if (escrowShort || escrowToken === null) {
      notifyError(`The connected wallet does not hold enough ${tokenSymbol(escrowToken)} to escrow this order.`);
      return;
    }
    if (!(await ensureMonadWallet())) return;

    if (escrowWrap !== null) {
      await wrapMon(escrowToken, escrowWrap);
      return;
    }

    if (escrowApprovalRequired) {
      const approved = await sendDexTransaction(`Approve ${tokenSymbol(escrowToken)} for the Orderbook`, {
        to: escrowToken.address,
        data: encodeErc20Approve(DEX_CONTRACTS.orderbook, orderEscrowAmount),
      });
      if (approved) onNotify(`${tokenSymbol(escrowToken)} approved for the Orderbook. Sign the order next.`);
      return;
    }

    if (orderExpiryAt === null) {
      notifyError('Pick how long the order should stay on the book.');
      return;
    }

    const placed = await simulateThenSend(
      `Place ${orderSide} order`,
      {
        to: DEX_CONTRACTS.orderbook,
        data: encodePlaceOrder(
          pool.pairId,
          orderSide === 'buy' ? DEX_ORDER_SIDE.buy : DEX_ORDER_SIDE.sell,
          orderPriceX18,
          orderAmountRaw,
          orderExpiryAt,
        ),
      },
    );
    if (placed) {
      setOrderAmount('');
      onNotify(`${orderSide === 'buy' ? 'Bid' : 'Ask'} resting on the book. It fills when a swap crosses it.`);
    }
  }

  async function handleCancelOrder(event: ReactMouseEvent<HTMLButtonElement>) {
    const raw = event.currentTarget.dataset.orderId ?? '';
    const orderId = parseWholeUint(raw);
    if (orderId === null || orderId === 0n) return;
    if (!canStartWrite()) return;
    if (!(await ensureMonadWallet())) return;
    await simulateThenSend(`Cancel order #${orderId.toString()}`, {
      to: DEX_CONTRACTS.orderbook,
      data: encodeCancelOrder(orderId),
    });
  }

  async function handleCreatePool(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canStartWrite()) return;
    if (!registryReady) {
      notifyError('Pool creation stays locked until the registry wiring reads as healthy.');
      return;
    }
    if (createTokenAAddress === null || createTokenBAddress === null) {
      notifyError('Both token fields need a valid 20-byte address.');
      return;
    }
    if (createPairId === null) {
      notifyError('A pair needs two different tokens.');
      return;
    }
    if (createFee === null || !createFeeWithinLimit) {
      notifyError(`The LP fee must be a whole ppm value at or below ${formatPpmLimit(dex.registryWiring.maxLpFeeRatePpm)}.`);
      return;
    }
    if (createTick === null || createTick === 0n) {
      notifyError('The tick size must be a whole number greater than zero.');
      return;
    }

    let createdPoolAddress: string | null = null;
    const created = await simulateThenSend(
      'Create SpotPool',
      {
        to: DEX_CONTRACTS.registry,
        data: encodeCreateSpotPool(createTokenAAddress, createTokenBAddress, createFee, createTick),
      },
      (returnData) => {
        const candidate = `0x${returnData.slice(-40)}`;
        createdPoolAddress = normalizeDexAddress(candidate);
      },
    );

    if (created) {
      if (createdPoolAddress) {
        selectPool(createdPoolAddress);
        setLiquidityView('manage');
        setJustCreatedPool(true);
        setTab('liquidity');
        onNotify(`Pool ${shortenAddress(createdPoolAddress)} created. Seed it with liquidity to enable swaps.`);
      } else {
        onNotify('Pool created. Look it up with the pair finder to load it.');
      }
      setFinderTokenA(createTokenAAddress);
      setFinderTokenB(createTokenBAddress);
    }
  }

  function handleAcknowledgeUnresolvedTransaction() {
    if (unresolvedTransaction === null) return;

    const acknowledgedKey = walletAddressKey(unresolvedTransaction.walletAddress);
    const currentOperation = currentOperationRef.current;
    const acknowledgesCurrentOperation = currentOperation !== null &&
      currentOperation.walletKey === acknowledgedKey &&
      operationProgressRef.current.hash !== null &&
      sameTransactionHash(operationProgressRef.current.hash, unresolvedTransaction.hash);

    if (!clearDexUnresolvedTransaction(unresolvedTransaction.walletAddress, unresolvedTransaction.hash)) {
      const reloadedTransactions = reloadDexUnresolvedTransactions();
      if (mountedRef.current && reloadedTransactions !== null) setUnresolvedTransactions(reloadedTransactions);
      return;
    }

    if (acknowledgesCurrentOperation) {
      if (mountedRef.current) setBusyAction(null);
      onActionState(null);
      currentOperationRef.current = null;
      setCurrentOperationWalletKey(null);
      writeInFlightRef.current = false;
      writeLockWalletRef.current = null;
    }
    setUnresolvedTransactions((transactions) => {
      const currentTransaction = transactions[acknowledgedKey];
      if (!currentTransaction || !sameTransactionHash(currentTransaction.hash, unresolvedTransaction.hash)) return transactions;
      const nextTransactions = { ...transactions };
      delete nextTransactions[acknowledgedKey];
      return nextTransactions;
    });
    dex.refresh();
  }

  function handleMaxAmount() {
    const spendable = spendableBalance(tokenIn, walletToken?.balance, nativeBalance);
    if (spendable === null || tokenIn === null || tokenIn.decimals === null) return;
    setAmountIn(formatTokenValue(spendable, tokenIn));
  }

  function handleMatchRatio(side: 'token0' | 'token1') {
    if (!poolRatioReady || pool?.reserves == null || pool.token0 == null || pool.token1 == null) return;
    const { reserve0, reserve1 } = pool.reserves;

    if (side === 'token0') {
      if (amount0In === null || pool.token1.decimals === null) return;
      setAddAmount1(formatUnits(amount0In * reserve1 / reserve0, pool.token1.decimals, pool.token1.decimals));
      return;
    }
    if (amount1In === null || pool.token0.decimals === null) return;
    setAddAmount0(formatUnits(amount1In * reserve0 / reserve1, pool.token0.decimals, pool.token0.decimals));
  }

  function handleMaxDeposit(side: 'token0' | 'token1') {
    const target = side === 'token0' ? walletToken0 : walletToken1;
    const token = side === 'token0' ? pool?.token0 ?? null : pool?.token1 ?? null;
    const spendable = spendableBalance(token, target?.balance, nativeBalance);
    if (spendable === null || token?.decimals == null) return;
    const formatted = formatTokenValue(spendable, token);
    if (side === 'token0') setAddAmount0(formatted);
    else setAddAmount1(formatted);
  }

  const emptyState = activePoolAddress === null;
  const walletBusy = busyAction !== null || wallet.connecting || wallet.switching || unresolvedTransaction !== null;
  const swapCtaReady = !wallet.address || !wallet.onMonad ? true : actionReady;
  const tradeButtonLabel = busyAction ?? (
    !wallet.address
      ? 'Connect wallet'
      : !wallet.onMonad
        ? 'Switch to Monad'
        : amountIn.trim() === '' || inputAmount === null
          ? 'Enter an amount'
          : insufficientBalance
            ? `Insufficient ${tokenSymbol(tokenIn)} balance`
            : swapWrap !== null
              ? 'Wrap MON'
              : approvalRequired
                ? `Approve ${tokenSymbol(tokenIn)}`
                : currentQuoteLoading && currentQuote === null
                  ? 'Fetching quote'
                  : `Swap ${tokenSymbol(tokenIn)} for ${tokenSymbol(tokenOut)}`
  );
  const addLiquidityButtonLabel = busyAction ?? (
    !wallet.address
      ? 'Connect wallet'
      : !wallet.onMonad
        ? 'Switch to Monad'
        : wrap0 !== null || wrap1 !== null
          ? 'Wrap MON'
          : approvalRequired0
            ? `Approve ${tokenSymbol(pool?.token0 ?? null)}`
            : approvalRequired1
              ? `Approve ${tokenSymbol(pool?.token1 ?? null)}`
              : pool?.hasLiquidity
                ? 'Add liquidity'
                : 'Seed the first position'
  );
  const orderButtonLabel = busyAction ?? (
    !wallet.address
      ? 'Connect wallet'
      : !wallet.onMonad
        ? 'Switch to Monad'
        : escrowWrap !== null
          ? 'Wrap MON'
          : escrowApprovalRequired
            ? `Approve ${tokenSymbol(escrowToken)}`
            : orderSide === 'buy'
              ? `Place bid for ${tokenSymbol(baseToken)}`
              : `Place ask for ${tokenSymbol(baseToken)}`
  );
  const createButtonLabel = busyAction ?? (
    !wallet.address ? 'Connect wallet' : !wallet.onMonad ? 'Switch to Monad' : 'Create SpotPool'
  );

  const gateCopy = emptyState
    ? {
        title: 'No pool loaded',
        body: 'Paste a SpotPool address or search the registry by token pair to start trading.',
        action: 'Select a pool' as const,
      }
    : pool?.invalidAddress
      ? {
          title: 'Address rejected',
          body: pool.error ?? 'The supplied address is not a well-formed SpotPool address.',
          action: 'Select a pool' as const,
        }
      : !registryReady
        ? {
            title: 'Registry wiring unverified',
            body: 'Writes stay hidden until the configured registry, pool, Orderbook, and treasury addresses agree on-chain.',
            action: 'Retry reads' as const,
          }
        : !pool?.valid
          ? {
              title: 'Reading the selected pool',
              body: pool?.error ?? 'Write controls stay hidden until DexRegistry confirms this pool.',
              action: 'Select a pool' as const,
            }
          : null;

  function renderGate() {
    if (gateCopy === null) return null;
    return (
      <div className="dx-gate">
        <span className="dx-gate__glyph" aria-hidden="true">✦</span>
        <h3>{gateCopy.title}</h3>
        <p>{gateCopy.body}</p>
        <div className="dx-gate__actions">
          <button className="dx-button dx-button--solid" type="button" onClick={() => setFinderOpen(true)}>
            Select a pool
          </button>
          {!emptyState && !pool?.valid && (
            <button className="dx-button dx-button--ghost" type="button" onClick={dex.refresh} disabled={dex.loading}>
              Retry reads
            </button>
          )}
        </div>
      </div>
    );
  }

  const noLiquidityGate = poolVerified && pool !== null && !pool.hasLiquidity && (
    <div className="dx-gate">
      <span className="dx-gate__glyph" aria-hidden="true">◇</span>
      <h3>Pool found, awaiting liquidity</h3>
      <p>Both reserves must be nonzero before swaps can price. Seed the first position to open trading.</p>
      <div className="dx-gate__actions">
        <button className="dx-button dx-button--solid" type="button" onClick={() => { setLiquidityView('manage'); setJustCreatedPool(false); setTab('liquidity'); }}>
          Add liquidity
        </button>
      </div>
    </div>
  );

  const swapSubIn = inputAmount === null && amountIn.trim() !== ''
    ? 'Use a decimal amount within the token precision.'
    : insufficientBalance
      ? 'Balance is short of this amount.'
      : swapWrap !== null
        ? `Wraps ${formatUnits(swapWrap, 18, 4)} MON into ${tokenSymbol(tokenIn)} first.`
        : tokenIn
          ? `${wallet.address ? 'Approved' : 'Connect to approve'} · ERC20`
          : 'Token metadata pending';

  const swapSubOut = currentQuoteError ?? (
    currentQuote === null
      ? 'Enter an amount for the live pool quote.'
      : `Min received ${formatTokenValue(minimumOut, tokenOut, 6)} after ${slippage}% slippage`
  );

  return (
    <section className="workspace-section workspace-section--dex" aria-labelledby="dex-page-title">
      <h1 id="dex-page-title" className="dx-visually-hidden">SERIES9 DEX</h1>
      <div className="dx-shell">
        {pageError && (
          <div className="dx-alert" role="alert">
            <span>{pageError}</span>
            <button type="button" onClick={handleClearErrors}>Dismiss</button>
          </div>
        )}

        <section className="dx-card" aria-label="DEX terminal">
          <div className="dx-card__head">
            <nav className="dx-tabs" aria-label="DEX pages">
              {TABS.map(([value, label]) => (
                <a
                  key={value}
                  className={`dx-tab${tab === value ? ' dx-tab--active' : ''}`}
                  href={dexHref(value)}
                  aria-current={tab === value ? 'page' : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    if (value === 'liquidity') setLiquidityView('overview');
                    if (value === 'liquidity' || value === 'create') setJustCreatedPool(false);
                    setTab(value);
                  }}
                >
                  {label}
                </a>
              ))}
            </nav>
            <div className="dx-head-tools">
              <button
                type="button"
                className="dx-icon-button"
                aria-label="Find or change pool"
                title="Find or change pool"
                onClick={() => setFinderOpen(true)}
              >
                <SearchIcon />
              </button>
              <button
                type="button"
                className="dx-icon-button"
                aria-label="Refresh chain reads"
                title="Refresh chain reads"
                onClick={dex.refresh}
                disabled={dex.loading}
              >
                <RefreshIcon />
              </button>
              <button
                type="button"
                className={`dx-icon-button${settingsOpen ? ' dx-icon-button--open' : ''}`}
                aria-label="Swap settings"
                title="Swap settings"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((open) => !open)}
              >
                <GearIcon />
              </button>
              <SwapSettings
                open={settingsOpen}
                slippage={slippage}
                onSlippageChange={(value) => { setSlippage(value); setActionError(null); }}
                onClose={() => setSettingsOpen(false)}
              />
            </div>
          </div>

          <div className="dx-card__body">
            {tab === 'swap' && (
              emptyState || !pool?.valid || !registryReady
                ? renderGate()
                  : !pool.hasLiquidity
                   ? noLiquidityGate
                   : (
                    <div className="dx-swap-layout">
                      <LivePriceChart
                        prices={chartSamples}
                        currentPrice={chartPoolReady ? spotForRate : null}
                        token0={pool.token0}
                        token1={pool.token1}
                      />
                      <form className="dx-form" onSubmit={handleSwap}>
                        <TokenPanel
                          label="You pay"
                          inputLabel={`Amount of ${tokenSymbol(tokenIn)} to send`}
                          value={amountIn}
                          onValueChange={(value) => { setAmountIn(value); setActionError(null); }}
                          token={tokenIn}
                          meta={wallet.address ? balanceHint(tokenIn, walletToken?.balance, nativeBalance) : 'Connect for balance'}
                          metaActionLabel={(spendableBalance(tokenIn, walletToken?.balance, nativeBalance) ?? 0n) > 0n ? 'MAX' : undefined}
                          onMetaAction={handleMaxAmount}
                          onTokenClick={() => setTokenSelect('in')}
                          sub={swapSubIn}
                          error={insufficientBalance || (amountIn.trim() !== '' && inputAmount === null)}
                        />

                        <div className="dx-flip-row">
                          <button
                            type="button"
                            className="dx-flip"
                            aria-label="Reverse swap direction"
                            onClick={() => setDirection((current) => current === 'token0' ? 'token1' : 'token0')}
                          >
                            <FlipArrowIcon />
                          </button>
                        </div>

                        <TokenPanel
                          label="You receive"
                          inputLabel={`Estimated ${tokenSymbol(tokenOut)} received`}
                          value={currentQuote === null ? '' : formatUnits(currentQuote, tokenOut?.decimals ?? 18, 8)}
                          readOnly
                          loading={currentQuoteLoading && currentQuote === null}
                          token={tokenOut}
                          meta={minimumOut !== null ? `Min ${formatTokenValue(minimumOut, tokenOut, 6)}` : undefined}
                          onTokenClick={() => setTokenSelect('out')}
                          sub={swapSubOut}
                        />

                        {swapRateValue !== EMPTY && (
                          <button type="button" className="dx-rate" onClick={() => setRateInverted((value) => !value)} aria-label="Toggle rate direction">
                            <span>1 {tokenSymbol(swapRateBase)} =</span>
                            <strong>{swapRateValue}</strong>
                            <RepeatIcon />
                          </button>
                        )}

                        <details className="dx-details">
                          <summary>
                            Swap details
                            <span>{slippage}% max slippage</span>
                          </summary>
                          <dl>
                            <div><dt>Minimum received</dt><dd>{formatTokenValue(minimumOut, tokenOut, 6)} {tokenSymbol(tokenOut)}</dd></div>
                            <div><dt>Liquidity fee</dt><dd>{formatFeePpm(pool?.feePpm ?? null)}</dd></div>
                            <div><dt>Max slippage</dt><dd>{slippage}%</dd></div>
                            <div><dt>Route</dt><dd><code>{shortenAddress(pool.address)}</code></dd></div>
                            <div><dt>Network</dt><dd>Monad chain 143</dd></div>
                          </dl>
                        </details>

                        <button className="dx-cta" type="submit" disabled={walletBusy || !swapCtaReady}>
                          {tradeButtonLabel}
                        </button>
                        <p className="dx-note">
                          Swaps are dry-run against live allowance and balance before signing. Native MON must be wrapped first — this market trades ERC20 pairs only.
                        </p>
                      </form>
                    </div>
                  )
            )}

            {tab === 'liquidity' && liquidityView === 'overview' && (
              <PoolOverviewSection
                connected={Boolean(wallet.address)}
                overview={poolOverview}
                filter={positionFilter}
                onFilterChange={setPositionFilter}
                search={positionSearch}
                onSearchChange={setPositionSearch}
                onCreatePosition={() => { setFinder(IDLE_POOL_FINDER); setFinderTokenA(''); setFinderTokenB(''); setLiquidityView('add'); }}
                onCreatePool={() => { setJustCreatedPool(false); setTab('create'); }}
                onManagePool={(address) => { selectPool(address); setLiquidityView('manage'); setJustCreatedPool(false); }}
              />
            )}

            {tab === 'liquidity' && liquidityView === 'add' && (
              <>
                <PoolWizardBreadcrumb current="포지션 생성" onBack={() => setLiquidityView('overview')} />
                <PoolWizardSteps step={1} labels={POSITION_ADD_STEP_LABELS} />

                <div className="dx-pool-overview__head">
                  <h2>풀 선택</h2>
                  <div className="dx-pool-overview__actions">
                    <button type="button" className="dx-button dx-button--ghost" onClick={() => { setJustCreatedPool(false); setTab('create'); }}>
                      <PlusIcon /> 풀 생성
                    </button>
                  </div>
                </div>

                <div className="dx-field-grid">
                  <label className="dx-field dx-field--address">
                    <span className="dx-field__top"><b>첫 번째 토큰</b></span>
                    <CreateAddressField
                      value={finderTokenA}
                      tokens={createTokenCatalog}
                      balances={createTokenBalances}
                      excludeAddress={normalizeDexAddress(finderTokenB)}
                      open={addPicker === 'a'}
                      onOpenChange={(next) => setAddPicker(next ? 'a' : null)}
                      onChange={setFinderTokenA}
                    />
                  </label>
                  <label className="dx-field dx-field--address">
                    <span className="dx-field__top"><b>두 번째 토큰</b></span>
                    <CreateAddressField
                      value={finderTokenB}
                      tokens={createTokenCatalog}
                      balances={createTokenBalances}
                      excludeAddress={normalizeDexAddress(finderTokenA)}
                      open={addPicker === 'b'}
                      onOpenChange={(next) => setAddPicker(next ? 'b' : null)}
                      onChange={setFinderTokenB}
                    />
                  </label>
                </div>

                {finder.error && <p className="dx-finder-error">{finder.error}</p>}
                {finder.status === 'loading' && <p className="dx-empty-line">레지스트리를 읽는 중…</p>}

                {finder.status === 'done' && finder.tokenA && finder.tokenB && (
                  finder.pools.length === 0 ? (
                    <p className="dx-empty-line">이 페어의 SpotPool이 아직 없어요. 직접 풀을 생성해보세요.</p>
                  ) : (
                    <div className="dx-pool-table" role="table" aria-label="풀 선택">
                      <div className="dx-pool-row dx-pool-row--pick dx-pool-row--head" role="row">
                        <span role="columnheader">풀</span>
                        <span role="columnheader">TVL</span>
                      </div>
                      {finder.pools.map((address) => {
                        const sorted = sortTokenPair(finder.tokenA!, finder.tokenB!);
                        if (!sorted) return null;
                        return (
                          <PoolPickRow
                            key={address}
                            address={address}
                            token0={lookupCatalogToken(sorted[0])}
                            token1={lookupCatalogToken(sorted[1])}
                            onSelect={() => { selectPool(address); setLiquidityView('manage'); }}
                          />
                        );
                      })}
                    </div>
                  )
                )}

                <div className="dx-finder-divider"><span>or paste a pool address</span></div>
                <label className="dx-finder-address">
                  <span>Paste a pool address</span>
                  <div>
                    <input
                      value={poolAddressInput}
                      onChange={(event) => { setPoolAddressInput(event.target.value); setActionError(null); }}
                      placeholder="0x… deployed SpotPool"
                      spellCheck="false"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="dx-button dx-button--ghost"
                      onClick={() => {
                        handleLoadPool();
                        if (normalizeDexAddress(poolAddressInput.trim())) setLiquidityView('manage');
                      }}
                    >
                      Load
                    </button>
                  </div>
                </label>
              </>
            )}

            {tab === 'liquidity' && liquidityView === 'manage' && (
              emptyState || !pool?.valid || !registryReady
                ? (
                  <>
                    {justCreatedPool && <PoolWizardSteps step={2} />}
                    <button type="button" className="dx-back-link" onClick={() => { setLiquidityView('overview'); setJustCreatedPool(false); }}>← 풀 목록으로</button>
                    {renderGate()}
                  </>
                )
                : (
                  <>
                    {justCreatedPool && <PoolWizardSteps step={2} />}
                    <button type="button" className="dx-back-link" onClick={() => { setLiquidityView('overview'); setJustCreatedPool(false); }}>← 풀 목록으로</button>
                    <div className="dx-manage__sidebar">
                      <div className="dx-manage__pair">
                        <span className="dx-manage__badges"><TokenBadge token={pool.token0} /><TokenBadge token={pool.token1} /></span>
                        <div>
                          <strong>{tokenSymbol(pool.token0)} / {tokenSymbol(pool.token1)}</strong>
                          <small>SpotPool · {formatFeePpm(pool.feePpm)}</small>
                        </div>
                      </div>
                      <dl className="dx-manage__stats">
                        <div><dt>현재 가격</dt><dd>{formatPriceX18(pool.spotPriceX18 ?? pool.reservePriceX18, pool.token0, pool.token1)}</dd></div>
                        <div><dt>TVL</dt><dd>{poolTvlUsd(pool) === null ? `${formatTokenValue(pool.reserves?.reserve0 ?? null, pool.token0)} / ${formatTokenValue(pool.reserves?.reserve1 ?? null, pool.token1)}` : formatUsd(poolTvlUsd(pool))}</dd></div>
                        <div><dt>24시간 거래량</dt><dd>{EMPTY}</dd></div>
                        <div><dt>24시간 수수료</dt><dd>{EMPTY}</dd></div>
                        <div><dt>1일 APR</dt><dd>{EMPTY}</dd></div>
                      </dl>
                    </div>
                    <div className="dx-range-head">
                      <h3>가격 범위 설정</h3>
                      <div className="dx-chip-row" role="tablist">
                        <button type="button" className="dx-chip dx-chip--active" role="tab" aria-selected="true">전체 범위</button>
                        <button type="button" className="dx-chip" role="tab" aria-selected="false" disabled title="이 풀은 항상 전체 구간(full range)만 지원합니다.">
                          사용자 지정 범위
                        </button>
                      </div>
                    </div>
                    <p className="dx-note">전체 범위 유동성 공급은 모든 가격대에서 지속적으로 시장에 참여합니다. 이 풀은 구간을 나눠 공급하는 concentrated range를 지원하지 않아 항상 전체 범위로 예치돼요.</p>
                    <LivePriceChart
                      prices={chartSamples}
                      currentPrice={chartPoolReady ? spotForRate : null}
                      token0={pool.token0}
                      token1={pool.token1}
                    />
                    <div className="dx-position">
                      <div>
                        <span>Your LP shares</span>
                        <strong>{wallet.address ? (walletShares === null ? EMPTY : walletShares.toString()) : 'connect wallet'}</strong>
                        <small>{shareOfPoolPpm === null ? 'share of pool pending' : `${formatUnits(shareOfPoolPpm, 4, 4)}% of pool`}</small>
                      </div>
                      <div>
                        <span>Pool reserves</span>
                        <strong>
                          {formatTokenValue(pool?.reserves?.reserve0 ?? null, pool?.token0 ?? null)} / {formatTokenValue(pool?.reserves?.reserve1 ?? null, pool?.token1 ?? null)}
                        </strong>
                        <small>{tokenSymbol(pool?.token0 ?? null)} / {tokenSymbol(pool?.token1 ?? null)}</small>
                      </div>
                    </div>

                    <form className="dx-form" onSubmit={handleAddLiquidity}>
                      {(['token0', 'token1'] as const).map((side) => {
                        const token = side === 'token0' ? pool?.token0 ?? null : pool?.token1 ?? null;
                        const held = side === 'token0' ? walletToken0 : walletToken1;
                        const value = side === 'token0' ? addAmount0 : addAmount1;
                        const setValue = side === 'token0' ? setAddAmount0 : setAddAmount1;
                        const parsed = side === 'token0' ? amount0In : amount1In;
                        const short = side === 'token0' ? insufficient0 : insufficient1;
                        const wrap = side === 'token0' ? wrap0 : wrap1;
                        return (
                          <AmountField
                            key={side}
                            id={`dx-deposit-${side}`}
                            title={`Deposit ${tokenSymbol(token)}`}
                            hint={wallet.address ? balanceHint(token, held?.balance, nativeBalance) : 'Connect wallet'}
                            value={value}
                            onChange={(next) => { setValue(next); setActionError(null); }}
                            symbol={tokenSymbol(token)}
                            actionLabel="MAX"
                            onAction={() => handleMaxDeposit(side)}
                            actionDisabled={held?.balance == null}
                            note={
                              value.trim() !== '' && parsed === null
                                ? 'Use a decimal amount within the token precision.'
                                : short
                                  ? 'Balance is short of this amount.'
                                  : wrap !== null
                                    ? `Wraps ${formatUnits(wrap, 18, 4)} MON into ${tokenSymbol(token)} first.`
                                    : poolRatioReady
                                      ? 'Deposits outside the reserve ratio are refunded by the pool.'
                                      : 'First deposit sets the opening price of the pool.'
                            }
                          />
                        );
                      })}
                      {poolRatioReady && (
                        <div className="dx-link-row">
                          <button type="button" onClick={() => handleMatchRatio('token1')} disabled={amount0In === null}>
                            Match token1 ↔ token0
                          </button>
                          <button type="button" onClick={() => handleMatchRatio('token0')} disabled={amount1In === null}>
                            Match token0 ↔ token1
                          </button>
                        </div>
                      )}

                      <div className="dx-setting-row">
                        <span>Tolerance</span>
                        <div className="dx-chip-row">
                          {TOLERANCE_PRESETS.map((preset) => (
                            <button
                              key={preset}
                              type="button"
                              className={`dx-chip${liquidityTolerance === preset ? ' dx-chip--active' : ''}`}
                              onClick={() => setLiquidityTolerance(preset)}
                            >
                              {preset}%
                            </button>
                          ))}
                        </div>
                        <small>
                          {!wallet.address
                            ? 'Connect to approve both tokens'
                            : approvalRequired0
                              ? `${tokenSymbol(pool?.token0 ?? null)} approval required`
                              : approvalRequired1
                                ? `${tokenSymbol(pool?.token1 ?? null)} approval required`
                                : 'Both allowances ready'}
                        </small>
                      </div>

                      <button className="dx-cta" type="submit" disabled={!addLiquidityReady || walletBusy}>
                        {addLiquidityButtonLabel}
                      </button>
                    </form>

                    <hr className="dx-divider" />

                    <form className="dx-form" onSubmit={handleRemoveLiquidity}>
                      <div className="dx-subhead">
                        <h3>Remove liquidity</h3>
                        <span>{walletShares ? `position ${walletShares.toString()} shares` : 'no position'}</span>
                      </div>
                      <div className="dx-chip-row" role="group" aria-label="Share of position to withdraw">
                        {REMOVE_PERCENTS.map((percent) => (
                          <button
                            key={percent}
                            className={`dx-chip${removePercent === percent ? ' dx-chip--active' : ''}`}
                            type="button"
                            onClick={() => setRemovePercent(percent)}
                          >
                            {percent}%
                          </button>
                        ))}
                      </div>
                      <dl className="dx-summary">
                        <div><dt>Shares burned</dt><dd>{removeShares === null ? EMPTY : removeShares.toString()}</dd></div>
                        <div><dt>{tokenSymbol(pool?.token0 ?? null)} returned</dt><dd>{formatTokenValue(redeemable?.amount0 ?? null, pool?.token0 ?? null, 6)}</dd></div>
                        <div><dt>{tokenSymbol(pool?.token1 ?? null)} returned</dt><dd>{formatTokenValue(redeemable?.amount1 ?? null, pool?.token1 ?? null, 6)}</dd></div>
                      </dl>
                      <button
                        className="dx-cta dx-cta--ghost"
                        type="submit"
                        disabled={removeShares === null || removeShares === 0n || walletBusy}
                      >
                        {busyAction ?? (walletShares ? `Withdraw ${removePercent}%` : 'No position to withdraw')}
                      </button>
                    </form>
                  </>
                )
            )}

            {tab === 'orders' && (
              emptyState || !pool?.valid || !registryReady
                ? renderGate()
                : !bookInitialized
                  ? (
                    <div className="dx-gate">
                      <span className="dx-gate__glyph" aria-hidden="true">✦</span>
                      <h3>No book initialised</h3>
                      <p>DexRegistry opens the Orderbook when it creates the pool. If this pool predates that wiring, its book cannot take orders.</p>
                    </div>
                  )
                  : (
                    <>
                      <form className="dx-form" onSubmit={handlePlaceOrder}>
                        <div className="dx-side-toggle" role="group" aria-label="Order side">
                          {(['buy', 'sell'] as const).map((side) => (
                            <button
                              key={side}
                              className={`dx-side${orderSide === side ? ` dx-side--active dx-side--${side}` : ''}`}
                              type="button"
                              onClick={() => setOrderSide(side)}
                            >
                              <strong>{side === 'buy' ? 'Buy' : 'Sell'}</strong>
                              <small>{side === 'buy' ? `pay ${tokenSymbol(quoteToken)}` : `pay ${tokenSymbol(baseToken)}`}</small>
                            </button>
                          ))}
                        </div>

                        <AmountField
                          id="dx-order-price"
                          title="Limit price"
                          hint={`${tokenSymbol(quoteToken)} per ${tokenSymbol(baseToken)}`}
                          value={orderPrice}
                          onChange={(next) => { setOrderPrice(next); setActionError(null); }}
                          symbol={tokenSymbol(quoteToken)}
                          actionLabel="SPOT"
                          actionDisabled={(pool?.spotPriceX18 ?? pool?.reservePriceX18 ?? null) === null}
                          onAction={() => {
                            const reference = pool?.spotPriceX18 ?? pool?.reservePriceX18 ?? null;
                            if (reference === null || baseToken?.decimals == null || quoteToken?.decimals == null) return;
                            setOrderPrice(formatUnits(reference * 10n ** BigInt(baseToken.decimals) / 10n ** BigInt(quoteToken.decimals), 18, 12));
                          }}
                          note={
                            orderPrice && orderPriceX18 === null
                              ? 'Use a decimal price the token pair can represent.'
                              : `Tick ${dex.orderbook?.bookConfig?.tickSize.toString() ?? EMPTY} · prices stored at 1e18 precision.`
                          }
                        />

                        <AmountField
                          id="dx-order-amount"
                          title="Amount"
                          hint={wallet.address ? balanceHint(baseToken, walletToken0?.balance, nativeBalance) : 'Connect wallet'}
                          value={orderAmount}
                          onChange={(next) => { setOrderAmount(next); setActionError(null); }}
                          symbol={tokenSymbol(baseToken)}
                          actionLabel="MAX"
                          actionDisabled={orderSide !== 'sell' || walletToken0?.balance == null}
                          onAction={() => {
                            const spendable = spendableBalance(baseToken, walletToken0?.balance, nativeBalance);
                            if (spendable === null || baseToken?.decimals == null) return;
                            setOrderAmount(formatTokenValue(spendable, baseToken));
                          }}
                          note={`Always denominated in ${tokenSymbol(baseToken)}, the pair's base token.`}
                        />

                        <div className="dx-setting-row">
                          <span>Good for</span>
                          <div className="dx-chip-row">
                            {EXPIRY_PRESETS.map((preset) => (
                              <button
                                key={preset.seconds}
                                type="button"
                                className={`dx-chip${orderExpiry === preset.seconds ? ' dx-chip--active' : ''}`}
                                onClick={() => setOrderExpiry(preset.seconds)}
                              >
                                {preset.label}
                              </button>
                            ))}
                          </div>
                          <small>
                            {escrowApprovalRequired
                              ? `${tokenSymbol(escrowToken)} approval required`
                              : wallet.address
                                ? 'Orderbook allowance ready'
                                : 'Connect to escrow the order'}
                          </small>
                        </div>

                        <dl className="dx-summary">
                          <div><dt>Escrowed now</dt><dd>{formatTokenValue(orderEscrowAmount, escrowToken, 6)} {tokenSymbol(escrowToken)}</dd></div>
                          <div><dt>You receive if filled</dt><dd>{formatTokenValue(orderProceeds, proceedsToken, 6)} {tokenSymbol(proceedsToken)}</dd></div>
                          <div><dt>Expires</dt><dd>{orderExpiryAt === null ? EMPTY : formatExpiry(orderExpiryAt)}</dd></div>
                        </dl>

                        <button className="dx-cta" type="submit" disabled={!orderReady || walletBusy}>
                          {orderButtonLabel}
                        </button>
                        <p className="dx-note">
                          Orders rest on the shared Orderbook and are consumed by SpotPool swaps — a bid fills when the pool trades through your price.
                        </p>
                      </form>

                      <hr className="dx-divider" />

                      <section className="dx-orders" aria-label="Your orders on this pair">
                        <div className="dx-subhead">
                          <h3>Your orders</h3>
                          <span>{openOrders.length} resting</span>
                        </div>
                        {!wallet.address ? (
                          <p className="dx-empty-line">Connect a wallet to list its resting orders.</p>
                        ) : dex.myOrders.length === 0 ? (
                          <p className="dx-empty-line">No orders from this wallet on this pair yet.</p>
                        ) : (
                          [...openOrders, ...closedOrders].map((entry) => {
                            const status = orderStatusLabel(entry, nowSeconds);
                            const cancellable = status === 'OPEN' || status === 'PARTIAL' || status === 'EXPIRED';
                            return (
                              <article className={`dx-order${entry.order.side === 0 ? ' dx-order--buy' : ' dx-order--sell'}`} key={entry.id.toString()}>
                                <div className="dx-order__head">
                                  <strong>{entry.order.side === 0 ? 'BUY' : 'SELL'}</strong>
                                  <code>#{entry.id.toString()}</code>
                                  <span className={`dx-order-status dx-order-status--${status.toLowerCase()}`}>{status}</span>
                                </div>
                                <dl>
                                  <div><dt>Price</dt><dd>{formatPriceX18(entry.order.priceX18, baseToken, quoteToken)}</dd></div>
                                  <div><dt>Amount</dt><dd>{formatTokenValue(entry.order.amount, baseToken, 6)} {tokenSymbol(baseToken)}</dd></div>
                                  <div><dt>Filled</dt><dd>{formatTokenValue(entry.order.filled, baseToken, 6)}</dd></div>
                                  <div><dt>Expires</dt><dd>{formatExpiry(entry.order.expiry)}</dd></div>
                                </dl>
                                <button
                                  className="dx-button dx-button--ghost dx-button--small"
                                  type="button"
                                  data-order-id={entry.id.toString()}
                                  onClick={handleCancelOrder}
                                  disabled={!cancellable || walletBusy}
                                >
                                  {cancellable ? 'Cancel & refund' : 'Closed'}
                                </button>
                              </article>
                            );
                          })
                        )}
                      </section>
                    </>
                  )
            )}

            {tab === 'create' && (
              <>
                <PoolWizardBreadcrumb current="풀 생성" onBack={() => { setLiquidityView('overview'); setTab('liquidity'); }} />
                <PoolWizardSteps step={1} />
                <form className="dx-form" onSubmit={handleCreatePool}>
                <div className="dx-field-grid">
                  <label className="dx-field dx-field--address">
                    <span className="dx-field__top"><b>Token A</b><i>ERC20 on Monad</i></span>
                    <CreateAddressField
                      value={createTokenA}
                      tokens={createTokenCatalog}
                      balances={createTokenBalances}
                      excludeAddress={createTokenBAddress}
                      open={createPicker === 'a'}
                      onOpenChange={(next) => setCreatePicker(next ? 'a' : null)}
                      onChange={(value) => { setCreateTokenA(value); setActionError(null); }}
                    />
                    <small>{createTokenA && createTokenAAddress === null ? 'Not a valid 20-byte address.' : 'Any deployed ERC20.'}</small>
                  </label>
                  <label className="dx-field dx-field--address">
                    <span className="dx-field__top"><b>Token B</b><i>must differ from A</i></span>
                    <CreateAddressField
                      value={createTokenB}
                      tokens={createTokenCatalog}
                      balances={createTokenBalances}
                      excludeAddress={createTokenAAddress}
                      open={createPicker === 'b'}
                      onOpenChange={(next) => setCreatePicker(next ? 'b' : null)}
                      onChange={(value) => { setCreateTokenB(value); setActionError(null); }}
                    />
                    <small>{createTokenB && createTokenBAddress === null ? 'Not a valid 20-byte address.' : 'Any deployed ERC20.'}</small>
                  </label>
                </div>

                <div className="dx-field__top"><b>수수료 등급</b><i>유동성 공급으로 얻는 금액입니다.</i></div>
                <div className="dx-fee-picker" role="group" aria-label="LP fee tier">
                  {FEE_PRESETS.map((preset) => (
                    <button
                      key={preset.ppm}
                      className={`dx-fee${createFeePpm === preset.ppm ? ' dx-fee--active' : ''}`}
                      type="button"
                      onClick={() => setCreateFeePpm(preset.ppm)}
                    >
                      <strong>{preset.label}</strong>
                      <small>{preset.note}</small>
                    </button>
                  ))}
                </div>

                <details className="dx-details">
                  <summary>고급 설정 <span>수수료 ppm · 북 틱 사이즈</span></summary>
                  <div className="dx-field-grid">
                    <label className="dx-field">
                      <span className="dx-field__top"><b>LP fee (ppm)</b></span>
                      <div className="dx-field__row">
                        <input
                          value={createFeePpm}
                          onChange={(event) => { setCreateFeePpm(event.target.value); setActionError(null); }}
                          inputMode="numeric"
                          autoComplete="off"
                        />
                      </div>
                      <small>
                        {createFee === null
                          ? 'Whole ppm value only.'
                          : !createFeeWithinLimit
                            ? `Above the registry ceiling of ${formatPpmLimit(dex.registryWiring.maxLpFeeRatePpm)}.`
                            : `${formatFeePpm(createFee)} per swap, fixed at creation.`}
                      </small>
                    </label>
                    <label className="dx-field">
                      <span className="dx-field__top"><b>Book tick size</b></span>
                      <div className="dx-field__row">
                        <input
                          value={createTickSize}
                          onChange={(event) => { setCreateTickSize(event.target.value); setActionError(null); }}
                          inputMode="numeric"
                          autoComplete="off"
                        />
                      </div>
                      <small>{createTick === null || createTick === 0n ? 'Whole number above zero.' : 'Minimum price increment on the shared book.'}</small>
                    </label>
                  </div>
                </details>

                <div className="dx-pairbox">
                  <span>DERIVED PAIR ID</span>
                  <code>{createPairId ? `${createPairId.slice(0, 16)}…${createPairId.slice(-8)}` : EMPTY}</code>
                  <small>keccak256 of the sorted token pair — the key DexRegistry stores.</small>
                </div>

                <button className="dx-cta" type="submit" disabled={!createReady || walletBusy}>
                  {createButtonLabel}
                </button>
                <p className="dx-note">
                  Creation is simulated against the live registry first — duplicate pairs, fees above the ceiling, or zero ticks are reported before your wallet opens.
                </p>
                </form>
              </>
            )}
          </div>

          {unresolvedTransaction && (
            <div className="dx-unresolved" role="alert">
              <span>
                Receipt uncertain for <code>{formatHash(unresolvedTransaction.hash)}</code>. Verify it in your wallet or explorer before continuing.
              </span>
              <button type="button" onClick={handleAcknowledgeUnresolvedTransaction}>I verified it</button>
            </div>
          )}
        </section>

        {pool?.valid && registryReady && (
          <section className="dx-stats" aria-label="Live pool readings">
            <MetricCard label="RESERVE 0" value={formatTokenValue(pool.reserves?.reserve0 ?? null, pool.token0)} note={tokenSymbol(pool.token0)} />
            <MetricCard label="RESERVE 1" value={formatTokenValue(pool.reserves?.reserve1 ?? null, pool.token1)} note={tokenSymbol(pool.token1)} />
            <MetricCard label="SPOT PRICE" value={formatPriceX18(pool.spotPriceX18 ?? pool.reservePriceX18, pool.token0, pool.token1)} note="token1 per token0" />
            <MetricCard label="LP FEE" value={formatFeePpm(pool.feePpm)} note="fixed at creation" />
            <MetricCard label="TOTAL SHARES" value={pool.totalShares === null ? EMPTY : pool.totalShares.toString()} note="LP supply" />
            <MetricCard label="BEST BID" value={formatLevelPrice(dex.orderbook?.bestBid?.priceX18 ?? null, pool)} note={`${formatTokenValue(dex.orderbook?.bestBid?.totalBase ?? null, pool.token0)} ${tokenSymbol(pool.token0)}`} />
            <MetricCard label="BEST ASK" value={formatLevelPrice(dex.orderbook?.bestAsk?.priceX18 ?? null, pool)} note={`${formatTokenValue(dex.orderbook?.bestAsk?.totalBase ?? null, pool.token0)} ${tokenSymbol(pool.token0)}`} />
            <MetricCard label="BOOK" value={dex.orderbook?.bookConfig?.initialized ? 'INITIALIZED' : dex.orderbook?.bookConfig ? 'EMPTY' : 'UNAVAILABLE'} note={dex.orderbook?.bookConfig?.tickSize === undefined ? 'config undecoded' : `tick ${dex.orderbook?.bookConfig?.tickSize.toString() ?? EMPTY}`} />
          </section>
        )}

      </div>

      {tokenSelect !== null && pool?.valid && pool.token0 !== null && pool.token1 !== null && (
        <TokenSelectDialog
          side={tokenSelect}
          tokens={[pool.token0, pool.token1]}
          balances={[walletToken0?.balance ?? null, walletToken1?.balance ?? null]}
          selectedIn={tokenIn}
          selectedOut={tokenOut}
          onSelect={(selected) => {
            const lower = selected.address.toLowerCase();
            if (pool.token0 && lower === pool.token0.address.toLowerCase()) setDirection('token0');
            else if (pool.token1 && lower === pool.token1.address.toLowerCase()) setDirection('token1');
            setTokenSelect(null);
          }}
          onClose={() => setTokenSelect(null)}
        />
      )}

      {finderOpen && (
        <PoolFinderDialog
          addressInput={poolAddressInput}
          onAddressInput={(value) => { setPoolAddressInput(value); setActionError(null); }}
          onLoadPool={() => {
            handleLoadPool();
            if (normalizeDexAddress(poolAddressInput.trim())) setFinderOpen(false);
          }}
          finderTokenA={finderTokenA}
          finderTokenB={finderTokenB}
          onFinderTokenA={setFinderTokenA}
          onFinderTokenB={setFinderTokenB}
          finder={finder}
          onFindPools={handleFindPools}
          activePoolAddress={activePoolAddress}
          onSelectPool={(address) => {
            selectPool(address);
            if (tab === 'liquidity') setLiquidityView('manage');
            setFinderOpen(false);
          }}
          onClose={() => setFinderOpen(false)}
        />
      )}
    </section>
  );
}

export default DexPage;
