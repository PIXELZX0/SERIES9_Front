import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import {
  DEX_CONFIG,
  DEX_CONTRACTS,
  DEX_ORDER_SIDE,
  DEX_ORDER_STATUS,
  encodeAddLiquidity,
  encodeCancelOrder,
  encodeCreateSpotPool,
  encodeErc20Approve,
  encodePlaceOrder,
  encodeRemoveLiquidity,
  encodeSwapExactIn,
  normalizeDexAddress,
  readSpotPoolsForPair,
  simulateDexWrite,
} from './dex.ts';
import { computePairId } from './keccak.ts';
import { explorerAddressUrl, formatUnits, shortenAddress } from './chain.ts';
import { useDex, type DexOpenOrder, type DexPoolSnapshot, type DexToken } from './useDex.ts';
import { dexHref, useDexSection, type DexTab } from './useDexRoute.ts';
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

/** Mutable half of the in-flight operation, held in a ref so it is never React state. */
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
};

const EMPTY = '--';
const UINT256_LIMIT = 2n ** 256n;
const UNRESOLVED_TRANSACTION_STORAGE_KEY = 'series9:unresolved-submitted-transactions';
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const IDLE_POOL_FINDER: PoolFinderState = { status: 'idle', pairId: null, pools: [], error: null };

/** Presets mirror the registry's parts-per-million fee scale: 10_000 ppm = 1%. */
const FEE_PRESETS: Array<{ ppm: string; label: string; note: string }> = [
  { ppm: '500', label: '0.05%', note: 'stable pairs' },
  { ppm: '3000', label: '0.30%', note: 'standard' },
  { ppm: '10000', label: '1.00%', note: 'volatile' },
];

const REMOVE_PERCENTS = [25, 50, 75, 100] as const;

const EXPIRY_PRESETS: Array<{ seconds: string; label: string }> = [
  { seconds: '3600', label: '1 hour' },
  { seconds: '86400', label: '1 day' },
  { seconds: '604800', label: '7 days' },
  { seconds: '2592000', label: '30 days' },
];

const PRICE_X18_EXPONENT = 18;

function walletAddressKey(address: string): string {
  return address.toLowerCase();
}

function sameTransactionHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
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

/** Whole-number field used for the registry's uint256 tick size. */
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

/**
 * The book prices in raw quote per raw base, scaled by 1e18, so a human price
 * needs the decimal gap between the two tokens folded in before parsing.
 */
function parsePriceToX18(value: string, baseDecimals: number | null, quoteDecimals: number | null): bigint | null {
  if (baseDecimals === null || quoteDecimals === null) return null;
  const scale = PRICE_X18_EXPONENT + quoteDecimals - baseDecimals;
  if (scale < 0 || scale > 77) return null;
  return parseTokenAmount(value, scale);
}

/** Buy orders escrow quote, sell orders escrow base. */
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

function formatLevelPrice(
  priceX18: bigint | null,
  pool: DexPoolSnapshot,
): string {
  if (priceX18 === 0n) return 'Empty';
  return formatPriceX18(priceX18, pool.token0, pool.token1);
}

function InfrastructureCard({
  label,
  address,
  note,
  detail,
}: {
  label: string;
  address: string;
  note: string;
  detail?: string;
}) {
  return (
    <article className="dex-infra-card">
      <div className="dex-infra-card__topline">
        <span className="dex-infra-card__index" aria-hidden="true">/</span>
        <span>{note}</span>
      </div>
      <strong>{label}</strong>
      <code>{shortenAddress(address)}</code>
      {detail && <small>{detail}</small>}
      <a href={explorerAddressUrl(address)} target="_blank" rel="noreferrer">
        Open on explorer <span aria-hidden="true">-&gt;</span>
      </a>
    </article>
  );
}

function PoolMetric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="dex-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

const BADGE_GRADIENTS = [
  ['#c9a45d', '#76571f'],
  ['#6a7f56', '#2f3d27'],
  ['#b15b42', '#5c2417'],
  ['#8a7fb8', '#3c3460'],
  ['#4f8a8b', '#1f4041'],
  ['#c47d5d', '#6b3a24'],
] as const;

function badgeGradient(address: string): string {
  let hash = 0;
  for (let index = 2; index < address.length; index += 1) {
    hash = (hash * 31 + address.charCodeAt(index)) >>> 0;
  }
  const [from, to] = BADGE_GRADIENTS[hash % BADGE_GRADIENTS.length];
  return `linear-gradient(135deg, ${from}, ${to})`;
}

function TokenBadge({ token }: { token: DexToken | null }) {
  if (!token) return <span className="dex-token-badge dex-token-badge--empty" aria-hidden="true">?</span>;
  const initials = (token.symbol?.trim() || token.address.slice(2, 5)).slice(0, 3).toUpperCase();
  return (
    <span className="dex-token-badge" style={{ background: badgeGradient(token.address) }} aria-hidden="true">
      {initials}
    </span>
  );
}

type SwapSettingsProps = {
  open: boolean;
  slippage: string;
  onSlippageChange: (value: string) => void;
  onClose: () => void;
};

function SwapSettings({ open, slippage, onSlippageChange, onClose }: SwapSettingsProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const parsed = parseSlippageBps(slippage);

  return (
    <>
      <button type="button" className="dex-pop-backdrop" aria-label="Close swap settings" onClick={onClose} />
      <div className="dex-settings" role="dialog" aria-label="Swap settings">
        <div className="dex-settings__head">
          <h3>Swap settings</h3>
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <span className="dex-settings__label">Max slippage</span>
        <div className="dex-settings__row" role="group" aria-label="Slippage presets">
          {['0.1', '0.5', '1'].map((preset) => (
            <button
              key={preset}
              type="button"
              className={`dex-chip${slippage === preset ? ' dex-chip--active' : ''}`}
              onClick={() => onSlippageChange(preset)}
            >
              {preset}%
            </button>
          ))}
          <label className={`dex-chip dex-chip--custom${slippage !== '0.1' && slippage !== '0.5' && slippage !== '1' ? ' dex-chip--active' : ''}`}>
            <input
              ref={inputRef}
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
        <small className="dex-settings__hint">
          {parsed === null
            ? 'Enter a slippage between 0 and 50%.'
            : 'Swaps revert instead of filling below this floor.'}
        </small>
      </div>
    </>
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const normalized = query.trim().toLowerCase();
  const visible = tokens.filter((token) =>
    !normalized ||
    token.symbol?.toLowerCase().includes(normalized) ||
    token.address.toLowerCase().includes(normalized));

  return (
    <div className="dex-dialog-layer" role="presentation">
      <button type="button" className="dex-pop-backdrop" aria-label="Close token selector" onClick={onClose} />
      <div className="dex-token-dialog" role="dialog" aria-modal="true" aria-label={`Select the ${side === 'in' ? 'send' : 'receive'} token`}>
        <div className="dex-settings__head">
          <h3>{side === 'in' ? 'You send' : 'You receive'}</h3>
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <input
          className="dex-token-dialog__search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by symbol or address"
          spellCheck="false"
          autoComplete="off"
        />
        <div className="dex-token-dialog__list">
          {visible.map((token, index) => {
            const isSelected = token.address === selectedIn?.address || token.address === selectedOut?.address;
            return (
              <button
                key={token.address}
                type="button"
                className={`dex-token-option${isSelected ? ' dex-token-option--selected' : ''}`}
                onClick={() => onSelect(token)}
              >
                <TokenBadge token={token} />
                <span className="dex-token-option__meta">
                  <strong>{tokenSymbol(token)}</strong>
                  <code>{shortenAddress(token.address)}</code>
                </span>
                <span className="dex-token-option__balance">{formatTokenValue(balances[index] ?? null, token, 4)}</span>
              </button>
            );
          })}
          {visible.length === 0 && (
            <p className="dex-panel-empty">No token in the loaded pool matches “{query}”.</p>
          )}
        </div>
        {other && <small className="dex-settings__hint">The other side of the pair stays {tokenSymbol(other)}.</small>}
      </div>
    </div>
  );
}

function invertPriceX18(priceX18: bigint): bigint | null {
  return priceX18 > 0n ? 10n ** 36n / priceX18 : null;
}

function GearIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
    </svg>
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

  const [finderTokenA, setFinderTokenA] = useState('');
  const [finderTokenB, setFinderTokenB] = useState('');
  const [finder, setFinder] = useState<PoolFinderState>(IDLE_POOL_FINDER);

  const [addAmount0, setAddAmount0] = useState('');
  const [addAmount1, setAddAmount1] = useState('');
  const [liquiditySlippage, setLiquiditySlippage] = useState('1');
  const [removePercent, setRemovePercent] = useState<number>(50);

  const [orderSide, setOrderSide] = useState<OrderSide>('buy');
  const [orderPrice, setOrderPrice] = useState('');
  const [orderAmount, setOrderAmount] = useState('');
  const [orderExpiry, setOrderExpiry] = useState('86400');
  /** Wall clock kept in state so render stays pure; refreshed once a minute. */
  const [nowSeconds, setNowSeconds] = useState(0);

  const [createTokenA, setCreateTokenA] = useState('');
  const [createTokenB, setCreateTokenB] = useState('');
  const [createFeePpm, setCreateFeePpm] = useState('3000');
  const [createTickSize, setCreateTickSize] = useState('1');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tokenSelect, setTokenSelect] = useState<TokenSelectSide | null>(null);
  const [rateInverted, setRateInverted] = useState(false);

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
  const insufficientBalance = wallet.address !== null &&
    walletToken?.balance !== null &&
    walletToken !== null &&
    inputAmount !== null &&
    inputAmount > walletToken.balance;
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
  const networkState = dex.error || dex.registryWiring.status === 'degraded'
    ? 'degraded'
    : dex.loading || dex.registryWiring.status === 'unavailable'
      ? 'loading'
      : 'live';
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

  // ── liquidity ────────────────────────────────────────────────────────────────
  const liquiditySlippageBps = parseSlippageBps(liquiditySlippage);
  const amount0In = parseTokenAmount(addAmount0, pool?.token0?.decimals ?? null);
  const amount1In = parseTokenAmount(addAmount1, pool?.token1?.decimals ?? null);
  const poolRatioReady = pool?.reserves != null && pool.reserves.reserve0 > 0n && pool.reserves.reserve1 > 0n;
  const approvalRequired0 = amount0In !== null && (walletToken0?.allowance == null || amount0In > walletToken0.allowance);
  const approvalRequired1 = amount1In !== null && (walletToken1?.allowance == null || amount1In > walletToken1.allowance);
  const insufficient0 = amount0In !== null && walletToken0?.balance != null && amount0In > walletToken0.balance;
  const insufficient1 = amount1In !== null && walletToken1?.balance != null && amount1In > walletToken1.balance;
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

  // ── limit orders ─────────────────────────────────────────────────────────────
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
  const escrowShort = orderEscrowAmount !== null &&
    escrowWalletToken?.balance != null &&
    orderEscrowAmount > escrowWalletToken.balance;
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

  // ── create ───────────────────────────────────────────────────────────────────
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

  async function handleFindPools(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tokenA = normalizeDexAddress(finderTokenA);
    const tokenB = normalizeDexAddress(finderTokenB);
    if (!tokenA || !tokenB) {
      setFinder({ status: 'error', pairId: null, pools: [], error: 'Both fields need a valid 20-byte token address.' });
      return;
    }

    const pairId = computePairId(tokenA, tokenB);
    if (pairId === null) {
      setFinder({ status: 'error', pairId: null, pools: [], error: 'A pair needs two different tokens.' });
      return;
    }

    setFinder({ status: 'loading', pairId, pools: [], error: null });
    try {
      const pools = await readSpotPoolsForPair(pairId);
      if (!mountedRef.current) return;
      if (pools === null) {
        setFinder({ status: 'error', pairId, pools: [], error: 'The registry did not return a readable pool list.' });
        return;
      }
      setFinder({ status: 'done', pairId, pools, error: null });
    } catch (findError: unknown) {
      if (!mountedRef.current) return;
      setFinder({
        status: 'error',
        pairId,
        pools: [],
        error: findError instanceof Error ? findError.message : 'The registry lookup failed.',
      });
    }
  }

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

  /** Guard shared by every write entry point: one wallet action at a time, no unresolved receipt. */
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
    request: { to: string; data: string },
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

  /**
   * Dry-run the calldata with the connected wallet as `from`, then sign it. Every
   * write on this page goes through here so a revert is reported before a wallet
   * prompt instead of after a failed transaction.
   */
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

      const swapped = await sendDexTransaction(swapLabel, {
        to: pool.address,
        data: encodeSwapExactIn(tokenIn.address, inputAmount, simulatedMinimumOut, recipient),
      }, swapOperation);
      if (swapped) {
        setAmountIn('');
        setQuote(null);
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

    await simulateThenSend(
      `Remove ${removePercent}% of liquidity`,
      {
        to: pool.address,
        data: encodeRemoveLiquidity(removeShares, amount0Min > 0n ? amount0Min : 1n, amount1Min > 0n ? amount1Min : 1n, recipient),
      },
    );
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

  async function handleCancelOrder(event: MouseEvent<HTMLButtonElement>) {
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
    if (walletToken?.balance !== null && walletToken !== null && tokenIn?.decimals !== null && tokenIn !== null) {
      setAmountIn(formatUnits(walletToken.balance, tokenIn.decimals, tokenIn.decimals));
    }
  }

  /** Mirror a deposit across the live reserve ratio so the pool takes both sides whole. */
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
    if (target?.balance == null || token?.decimals == null) return;
    const formatted = formatUnits(target.balance, token.decimals, token.decimals);
    if (side === 'token0') setAddAmount0(formatted);
    else setAddAmount1(formatted);
  }

  const emptyState = activePoolAddress === null;
  const statusLabel = networkState === 'live' ? 'ONCHAIN / LIVE' : networkState === 'loading' ? 'ONCHAIN / READING' : 'ONCHAIN / DEGRADED';
  const walletBusy = busyAction !== null || wallet.connecting || wallet.switching || unresolvedTransaction !== null;
  const swapCtaReady = !wallet.address || !wallet.onMonad
    ? true
    : actionReady;
  const tradeButtonLabel = busyAction ?? (
    !wallet.address
      ? 'Connect wallet'
      : !wallet.onMonad
        ? 'Switch to Monad'
        : amountIn.trim() === '' || inputAmount === null
          ? 'Enter an amount'
          : insufficientBalance
            ? `Insufficient ${tokenSymbol(tokenIn)} balance`
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
        : escrowApprovalRequired
          ? `Approve ${tokenSymbol(escrowToken)}`
          : orderSide === 'buy'
            ? `Place bid for ${tokenSymbol(baseToken)}`
            : `Place ask for ${tokenSymbol(baseToken)}`
  );
  const createButtonLabel = busyAction ?? (
    !wallet.address ? 'Connect wallet' : !wallet.onMonad ? 'Switch to Monad' : 'Create SpotPool'
  );

  const poolGate = pool?.invalidAddress ? (
    <div className="dex-pool-gate dex-pool-gate--error">
      <strong>Address format rejected.</strong>
      <p>{pool.error}</p>
    </div>
  ) : !registryReady ? (
    <div className="dex-pool-gate dex-pool-gate--error">
      <strong>Registry wiring is not verified.</strong>
      <p>Write controls stay hidden until the configured registry, pool, Orderbook, and treasury addresses agree on-chain.</p>
    </div>
  ) : !pool?.valid ? (
    <div className="dex-pool-gate">
      <strong>{pool?.error ?? 'Reading the selected pool.'}</strong>
      <p>Write controls stay hidden until DexRegistry confirms the pool and reserves return as a valid tuple.</p>
    </div>
  ) : null;

  return (
    <section className="workspace-section workspace-section--dex" aria-labelledby="dex-page-title">
      <div className="container">
        <div className="dex-heading">
          <div>
            <p className="eyebrow"><span className="eyebrow__line eyebrow__line--ink" />SERIES9 DEX / MONAD 143</p>
            <h1 id="dex-page-title">Trade the signal<br /><em>with receipts.</em></h1>
          </div>
          <div className="dex-heading__aside">
            <p>Create a pool, seed it, and swap against it. Every write is dry-run against the live chain before your wallet is asked to sign.</p>
            <div className={`dex-onchain-status dex-onchain-status--${networkState}`} role="status">
              <span />
              <strong>{statusLabel}</strong>
              <span>{dex.registryWiring.status === 'healthy' ? 'wiring confirmed' : dex.registryWiring.status === 'degraded' ? 'wiring mismatch' : 'reads pending'}</span>
            </div>
          </div>
        </div>

        <div className="dex-toolbar">
          <span>DEX REGISTRY <code>{shortenAddress(DEX_CONTRACTS.registry)}</code></span>
          <span>MAX LP FEE <strong>{formatPpmLimit(dex.registryWiring.maxLpFeeRatePpm)}</strong></span>
          <button className="dex-refresh" type="button" onClick={dex.refresh} disabled={dex.loading}>
            Refresh reads <span aria-hidden="true">/</span>
          </button>
        </div>

        {pageError && (
          <div className="dex-error" role="alert">
            <span><strong>Read or action notice.</strong> {pageError}</span>
            <button type="button" onClick={handleClearErrors}>Clear</button>
          </div>
        )}

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

        <div className="dex-terminal-layout">
          <section className="dex-terminal" aria-labelledby="dex-terminal-title">
            <div className="dex-terminal__header">
              <div>
                <span className="panel-kicker">SPOT / ONCHAIN WRITES</span>
                <h2 id="dex-terminal-title">Trading terminal</h2>
              </div>
              <div className="dex-header-tools">
                <span className={`dex-terminal__state${poolReady ? ' dex-terminal__state--ready' : ''}`}>
                  {poolReady ? 'READY' : poolVerified ? 'NO LIQUIDITY' : pool?.valid ? 'VERIFY WIRING' : 'POOL REQUIRED'}
                </span>
                <button
                  type="button"
                  className={`dex-gear${settingsOpen ? ' dex-gear--open' : ''}`}
                  aria-label="Swap settings"
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

            <nav className="dex-tabs dex-tabs--four" aria-label="DEX pages">
              {([
                ['swap', 'Swap', 'exact input'],
                ['liquidity', 'Liquidity', 'add / remove'],
                ['orders', 'Orders', 'limit book'],
                ['create', 'Create pool', 'registry write'],
              ] as Array<[DexTab, string, string]>).map(([value, label, note]) => (
                <a
                  key={value}
                  className={`dex-tab${tab === value ? ' dex-tab--active' : ''}`}
                  href={dexHref(value)}
                  id={`dex-tab-${value}`}
                  aria-current={tab === value ? 'page' : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    setTab(value);
                  }}
                >
                  <strong>{label}</strong>
                  <small>{note}</small>
                </a>
              ))}
            </nav>

            <div className="dex-terminal__body">
              <div className="dex-pool-strip">
                <span className={`dex-pool-strip__dot${poolVerified ? ' dex-pool-strip__dot--ok' : ''}`} aria-hidden="true" />
                <code className="dex-pool-strip__address">
                  {activePoolAddress ? shortenAddress(activePoolAddress) : 'NO POOL LOADED'}
                </code>
                <span className="dex-pool-strip__note">
                  {poolVerified
                    ? `registry verified / ${formatFeePpm(pool?.feePpm ?? null)} LP fee`
                    : activePoolAddress
                      ? 'not verified'
                      : 'load a pool below to trade'}
                </span>
              </div>

              <details className="dex-finder" open={emptyState}>
                <summary>Change pool — paste an address or search the pair</summary>
                <div className="dex-finder__manual">
                  <label htmlFor="dex-pool-address">Active SpotPool</label>
                  <div className="dex-pool-loader__row">
                    <input
                      id="dex-pool-address"
                      value={poolAddressInput}
                      onChange={(event) => {
                        setPoolAddressInput(event.target.value);
                        setActionError(null);
                      }}
                      placeholder="0x... deployed SpotPool"
                      spellCheck="false"
                      autoComplete="off"
                    />
                    <button className="dex-button dex-button--outline" type="button" onClick={handleLoadPool}>
                      Load
                    </button>
                  </div>
                </div>
                <form className="dex-finder__form" onSubmit={handleFindPools}>
                  <label>
                    <span>Token A</span>
                    <input
                      value={finderTokenA}
                      onChange={(event) => setFinderTokenA(event.target.value)}
                      placeholder="0x..."
                      spellCheck="false"
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    <span>Token B</span>
                    <input
                      value={finderTokenB}
                      onChange={(event) => setFinderTokenB(event.target.value)}
                      placeholder="0x..."
                      spellCheck="false"
                      autoComplete="off"
                    />
                  </label>
                  <button className="dex-button dex-button--outline" type="submit" disabled={finder.status === 'loading'}>
                    {finder.status === 'loading' ? 'Reading registry...' : 'Search registry'}
                  </button>
                </form>
                <div className="dex-finder__results" aria-live="polite">
                  {finder.pairId && <p className="dex-finder__pair">PAIR ID <code>{`${finder.pairId.slice(0, 14)}...${finder.pairId.slice(-6)}`}</code></p>}
                  {finder.error && <p className="dex-finder__error">{finder.error}</p>}
                  {finder.status === 'done' && finder.pools.length === 0 && (
                    <p className="dex-finder__empty">The registry holds no SpotPool for this pair yet. Create one on the Create pool page.</p>
                  )}
                  {finder.pools.map((address) => (
                    <button
                      key={address}
                      className={`dex-finder__pool${normalizeDexAddress(activePoolAddress)?.toLowerCase() === address.toLowerCase() ? ' dex-finder__pool--active' : ''}`}
                      type="button"
                      onClick={() => selectPool(address)}
                    >
                      <code>{shortenAddress(address)}</code>
                      <span>Load pool <span aria-hidden="true">-&gt;</span></span>
                    </button>
                  ))}
                </div>
              </details>

              {tab === 'swap' && (
                <form
                  className="dex-tabpanel dex-swap-form"
                  id="dex-panel-swap"
                  onSubmit={handleSwap}
                >
                  {emptyState ? (
                    <div className="dex-empty">
                      <span className="dex-empty__mark">09</span>
                      <span className="panel-kicker">NO POOL LOADED</span>
                      <h3>Factories are live. The pair is yours to point at.</h3>
                      <p>The Monad deployment wires the registry, treasury, factories, orderbook, and S9-POS. Load a pool above, or create one on the Create pool page.</p>
                    </div>
                  ) : poolGate ?? (!pool?.hasLiquidity ? (
                    <div className="dex-pool-gate">
                      <strong>Pool found, waiting for liquidity.</strong>
                      <p>Both reserve fields must be nonzero before swaps price. Use the Liquidity tab to seed the first position.</p>
                      <button className="dex-button dex-button--outline dex-button--small" type="button" onClick={() => setTab('liquidity')}>
                        Go to liquidity
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className={`dex-swap-panel${insufficientBalance ? ' dex-swap-panel--error' : ''}`}>
                        <div className="dex-swap-panel__top">
                          <span>You pay</span>
                          <i>
                            <span>{wallet.address ? `Balance ${formatTokenValue(walletToken?.balance ?? null, tokenIn)}` : 'Connect for balance'}</span>
                            {walletToken?.balance != null && walletToken.balance > 0n && (
                              <button type="button" onClick={handleMaxAmount}>MAX</button>
                            )}
                          </i>
                        </div>
                        <div className="dex-swap-panel__main">
                          <input
                            id="dex-amount-in"
                            value={amountIn}
                            onChange={(event) => {
                              setAmountIn(event.target.value);
                              setActionError(null);
                            }}
                            placeholder="0.00"
                            inputMode="decimal"
                            autoComplete="off"
                            aria-label={`Amount of ${tokenSymbol(tokenIn)} to send`}
                          />
                          <button type="button" className="dex-token-pill" onClick={() => setTokenSelect('in')} aria-label={`Change the send token, currently ${tokenSymbol(tokenIn)}`}>
                            <TokenBadge token={tokenIn} />
                            <strong>{tokenSymbol(tokenIn)}</strong>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
                          </button>
                        </div>
                        <small className="dex-swap-panel__sub">
                          {inputAmount === null && amountIn.trim() !== ''
                            ? 'Use a decimal amount within the token precision.'
                            : insufficientBalance
                              ? 'Balance is short of this amount.'
                              : tokenIn
                                ? `${tokenIn.decimals ?? '?'} decimals / ERC20 approve then swapExactIn`
                                : 'Token metadata pending'}
                        </small>
                      </div>

                      <div className="dex-flip-row">
                        <button
                          type="button"
                          className="dex-flip"
                          aria-label="Reverse swap direction"
                          onClick={() => setDirection((current) => current === 'token0' ? 'token1' : 'token0')}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></svg>
                        </button>
                      </div>

                      <div className="dex-swap-panel dex-swap-panel--out">
                        <div className="dex-swap-panel__top">
                          <span>You receive</span>
                          <i>
                            {currentQuoteLoading && currentQuote === null
                              ? 'quoting...'
                              : minimumOut !== null
                                ? `min ${formatTokenValue(minimumOut, tokenOut, 6)}`
                                : ''}
                          </i>
                        </div>
                        <div className="dex-swap-panel__main">
                          <input
                            readOnly
                            value={currentQuote === null ? '' : formatUnits(currentQuote, tokenOut?.decimals ?? 18, 8)}
                            placeholder={currentQuoteLoading && currentQuote === null ? 'Reading...' : '0.00'}
                            aria-label={`Estimated ${tokenSymbol(tokenOut)} received`}
                            onFocus={(event) => event.currentTarget.blur()}
                          />
                          <button type="button" className="dex-token-pill" onClick={() => setTokenSelect('out')} aria-label={`Change the receive token, currently ${tokenSymbol(tokenOut)}`}>
                            <TokenBadge token={tokenOut} />
                            <strong>{tokenSymbol(tokenOut)}</strong>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
                          </button>
                        </div>
                        <small className="dex-swap-panel__sub">
                          {currentQuoteError ?? (currentQuote === null ? 'Enter an amount to fetch the live pool quote.' : 'Live SpotPool quote at 1e18 precision.')}
                        </small>
                      </div>

                      {swapRateValue !== EMPTY && (
                        <button type="button" className="dex-rate" onClick={() => setRateInverted((value) => !value)} aria-label="Toggle rate direction">
                          <span>1 {tokenSymbol(swapRateBase)} =</span>
                          <strong>{swapRateValue}</strong>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
                        </button>
                      )}

                      <details className="dex-swap-details">
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

                      <div className="dex-action-block">
                        <button className="dex-button dex-button--gold dex-button--full dex-cta" type="submit" disabled={walletBusy || !swapCtaReady}>
                          {tradeButtonLabel}
                        </button>
                        <p className="dex-trade-note">Every swap is dry-run against the live allowance and balance before signing. Native MON must be wrapped first; this terminal trades ERC20 pairs only.</p>
                      </div>
                    </>
                  ))}
                </form>
              )}

              {tab === 'liquidity' && (
                <div className="dex-tabpanel" id="dex-panel-liquidity">
                  {emptyState ? (
                    <div className="dex-empty">
                      <span className="dex-empty__mark">09</span>
                      <span className="panel-kicker">NO POOL LOADED</span>
                      <h3>Point at a pool before you fund it.</h3>
                      <p>Load a SpotPool above, or create one on the Create pool page and it will be selected for you automatically.</p>
                    </div>
                  ) : poolGate ?? (
                    <>
                      <div className="dex-position-card">
                        <div>
                          <span>YOUR LP SHARES</span>
                          <strong>{wallet.address ? (walletShares === null ? EMPTY : walletShares.toString()) : 'connect wallet'}</strong>
                          <small>{shareOfPoolPpm === null ? 'share of pool pending' : `${formatUnits(shareOfPoolPpm, 4, 4)}% of pool`}</small>
                        </div>
                        <div>
                          <span>POOL RESERVES</span>
                          <strong>{formatTokenValue(pool?.reserves?.reserve0 ?? null, pool?.token0 ?? null)} / {formatTokenValue(pool?.reserves?.reserve1 ?? null, pool?.token1 ?? null)}</strong>
                          <small>{tokenSymbol(pool?.token0 ?? null)} / {tokenSymbol(pool?.token1 ?? null)}</small>
                        </div>
                      </div>

                      <form className="dex-liquidity-form" onSubmit={handleAddLiquidity}>
                        <h3 className="dex-subhead">Add liquidity</h3>
                        {(['token0', 'token1'] as const).map((side) => {
                          const token = side === 'token0' ? pool?.token0 ?? null : pool?.token1 ?? null;
                          const held = side === 'token0' ? walletToken0 : walletToken1;
                          const value = side === 'token0' ? addAmount0 : addAmount1;
                          const setValue = side === 'token0' ? setAddAmount0 : setAddAmount1;
                          const parsed = side === 'token0' ? amount0In : amount1In;
                          const short = side === 'token0' ? insufficient0 : insufficient1;
                          return (
                            <label className="dex-amount-field" key={side} htmlFor={`dex-deposit-${side}`}>
                              <span>
                                <b>Deposit {tokenSymbol(token)}</b>
                                <i>Balance {wallet.address ? formatTokenValue(held?.balance ?? null, token) : 'connect wallet'}</i>
                              </span>
                              <div>
                                <input
                                  id={`dex-deposit-${side}`}
                                  value={value}
                                  onChange={(event) => {
                                    setValue(event.target.value);
                                    setActionError(null);
                                  }}
                                  placeholder="0.00"
                                  inputMode="decimal"
                                  autoComplete="off"
                                />
                                <strong>{tokenSymbol(token)}</strong>
                                <button type="button" onClick={() => handleMaxDeposit(side)} disabled={held?.balance == null}>MAX</button>
                              </div>
                              <small>
                                {value && parsed === null
                                  ? 'Use a decimal amount within the token precision.'
                                  : short
                                    ? 'Balance is short of this amount.'
                                    : poolRatioReady
                                      ? 'Deposits outside the reserve ratio are refunded by the pool.'
                                      : 'First deposit sets the opening price of the pool.'}
                              </small>
                              {poolRatioReady && (
                                <button
                                  className="dex-ratio-button"
                                  type="button"
                                  onClick={() => handleMatchRatio(side)}
                                  disabled={parsed === null}
                                >
                                  Match the other side to this amount
                                </button>
                              )}
                            </label>
                          );
                        })}

                        <div className="dex-trade-settings">
                          <label htmlFor="dex-liquidity-slippage">Tolerance</label>
                          <select id="dex-liquidity-slippage" value={liquiditySlippage} onChange={(event) => setLiquiditySlippage(event.target.value)}>
                            <option value="0.1">0.1%</option>
                            <option value="0.5">0.5%</option>
                            <option value="1">1%</option>
                            <option value="2">2%</option>
                            <option value="5">5%</option>
                          </select>
                          <span>
                            {!wallet.address
                              ? 'Connect to approve both tokens'
                              : approvalRequired0
                                ? `${tokenSymbol(pool?.token0 ?? null)} approval required`
                                : approvalRequired1
                                  ? `${tokenSymbol(pool?.token1 ?? null)} approval required`
                                  : 'Both allowances ready'}
                          </span>
                        </div>

                        <button className="dex-button dex-button--gold dex-button--full" type="submit" disabled={!addLiquidityReady || walletBusy}>
                          {addLiquidityButtonLabel} <span aria-hidden="true">-&gt;</span>
                        </button>
                      </form>

                      <form className="dex-liquidity-form dex-liquidity-form--remove" onSubmit={handleRemoveLiquidity}>
                        <h3 className="dex-subhead">Remove liquidity</h3>
                        <div className="dex-percent-row" role="group" aria-label="Share of position to withdraw">
                          {REMOVE_PERCENTS.map((percent) => (
                            <button
                              key={percent}
                              className={`dex-percent${removePercent === percent ? ' dex-percent--active' : ''}`}
                              type="button"
                              onClick={() => setRemovePercent(percent)}
                            >
                              {percent}%
                            </button>
                          ))}
                        </div>
                        <dl className="dex-redeem-preview">
                          <div><dt>Shares burned</dt><dd>{removeShares === null ? EMPTY : removeShares.toString()}</dd></div>
                          <div><dt>{tokenSymbol(pool?.token0 ?? null)} returned</dt><dd>{formatTokenValue(redeemable?.amount0 ?? null, pool?.token0 ?? null, 6)}</dd></div>
                          <div><dt>{tokenSymbol(pool?.token1 ?? null)} returned</dt><dd>{formatTokenValue(redeemable?.amount1 ?? null, pool?.token1 ?? null, 6)}</dd></div>
                        </dl>
                        <button
                          className="dex-button dex-button--outline dex-button--full"
                          type="submit"
                          disabled={removeShares === null || removeShares === 0n || walletBusy}
                        >
                          {busyAction ?? (walletShares ? `Withdraw ${removePercent}%` : 'No position to withdraw')} <span aria-hidden="true">-&gt;</span>
                        </button>
                      </form>
                    </>
                  )}
                </div>
              )}

              {tab === 'orders' && (
                <div className="dex-tabpanel" id="dex-panel-orders">
                  {emptyState ? (
                    <div className="dex-empty">
                      <span className="dex-empty__mark">09</span>
                      <span className="panel-kicker">NO POOL LOADED</span>
                      <h3>The book follows the pair.</h3>
                      <p>Orderbook levels are keyed by the pair id, so load or create a SpotPool first and its book comes with it.</p>
                    </div>
                  ) : poolGate ?? (!bookInitialized ? (
                    <div className="dex-pool-gate">
                      <strong>No book is initialised for this pair.</strong>
                      <p>DexRegistry opens the Orderbook book when it creates the pool. If this pool predates that wiring, its book cannot take orders.</p>
                    </div>
                  ) : (
                    <>
                      <form className="dex-order-form" onSubmit={handlePlaceOrder}>
                        <h3 className="dex-subhead">Limit order</h3>
                        <div className="dex-side-toggle" role="group" aria-label="Order side">
                          {(['buy', 'sell'] as const).map((side) => (
                            <button
                              key={side}
                              className={`dex-side${orderSide === side ? ` dex-side--active dex-side--${side}` : ''}`}
                              type="button"
                              onClick={() => setOrderSide(side)}
                            >
                              <strong>{side === 'buy' ? 'BUY' : 'SELL'}</strong>
                              <small>{side === 'buy' ? `pay ${tokenSymbol(quoteToken)}` : `pay ${tokenSymbol(baseToken)}`}</small>
                            </button>
                          ))}
                        </div>

                        <label className="dex-amount-field" htmlFor="dex-order-price">
                          <span><b>Limit price</b><i>{tokenSymbol(quoteToken)} per {tokenSymbol(baseToken)}</i></span>
                          <div>
                            <input
                              id="dex-order-price"
                              value={orderPrice}
                              onChange={(event) => { setOrderPrice(event.target.value); setActionError(null); }}
                              placeholder="0.00"
                              inputMode="decimal"
                              autoComplete="off"
                            />
                            <strong>{tokenSymbol(quoteToken)}</strong>
                            <button
                              type="button"
                              onClick={() => {
                                const reference = pool?.spotPriceX18 ?? pool?.reservePriceX18 ?? null;
                                if (reference === null || baseToken?.decimals == null || quoteToken?.decimals == null) return;
                                setOrderPrice(formatUnits(reference * 10n ** BigInt(baseToken.decimals) / 10n ** BigInt(quoteToken.decimals), 18, 12));
                              }}
                              disabled={(pool?.spotPriceX18 ?? pool?.reservePriceX18 ?? null) === null}
                            >
                              SPOT
                            </button>
                          </div>
                          <small>
                            {orderPrice && orderPriceX18 === null
                              ? 'Use a decimal price the token pair can represent.'
                              : `Tick ${dex.orderbook?.bookConfig?.tickSize.toString() ?? EMPTY} / prices are stored at 1e18 precision.`}
                          </small>
                        </label>

                        <label className="dex-amount-field" htmlFor="dex-order-amount">
                          <span>
                            <b>Amount</b>
                            <i>Balance {wallet.address ? formatTokenValue(walletToken0?.balance ?? null, baseToken) : 'connect wallet'}</i>
                          </span>
                          <div>
                            <input
                              id="dex-order-amount"
                              value={orderAmount}
                              onChange={(event) => { setOrderAmount(event.target.value); setActionError(null); }}
                              placeholder="0.00"
                              inputMode="decimal"
                              autoComplete="off"
                            />
                            <strong>{tokenSymbol(baseToken)}</strong>
                            <button
                              type="button"
                              onClick={() => {
                                if (walletToken0?.balance == null || baseToken?.decimals == null) return;
                                setOrderAmount(formatUnits(walletToken0.balance, baseToken.decimals, baseToken.decimals));
                              }}
                              disabled={orderSide !== 'sell' || walletToken0?.balance == null}
                            >
                              MAX
                            </button>
                          </div>
                          <small>Always denominated in {tokenSymbol(baseToken)}, the pair's base token.</small>
                        </label>

                        <div className="dex-trade-settings">
                          <label htmlFor="dex-order-expiry">Good for</label>
                          <select id="dex-order-expiry" value={orderExpiry} onChange={(event) => setOrderExpiry(event.target.value)}>
                            {EXPIRY_PRESETS.map((preset) => (
                              <option key={preset.seconds} value={preset.seconds}>{preset.label}</option>
                            ))}
                          </select>
                          <span>{escrowApprovalRequired ? `${tokenSymbol(escrowToken)} approval required` : wallet.address ? 'Orderbook allowance ready' : 'Connect to escrow the order'}</span>
                        </div>

                        <dl className="dex-redeem-preview">
                          <div><dt>Escrowed now</dt><dd>{formatTokenValue(orderEscrowAmount, escrowToken, 6)} {tokenSymbol(escrowToken)}</dd></div>
                          <div><dt>You receive if filled</dt><dd>{formatTokenValue(orderProceeds, proceedsToken, 6)} {tokenSymbol(proceedsToken)}</dd></div>
                          <div><dt>Expires</dt><dd>{orderExpiryAt === null ? EMPTY : formatExpiry(orderExpiryAt)}</dd></div>
                        </dl>

                        <button className="dex-button dex-button--gold dex-button--full" type="submit" disabled={!orderReady || walletBusy}>
                          {orderButtonLabel} <span aria-hidden="true">-&gt;</span>
                        </button>
                        <p className="dex-trade-note">
                          Orders rest on the shared <code>Orderbook</code>; they do not cross each other at placement. A SpotPool swap is what consumes them, so a resting bid fills when the pool trades through your price.
                        </p>
                      </form>

                      <section className="dex-order-list" aria-label="Your orders on this pair">
                        <h3 className="dex-subhead">Your orders</h3>
                        {!wallet.address ? (
                          <p className="dex-panel-empty">Connect a wallet to list the orders it has resting on this pair.</p>
                        ) : dex.myOrders.length === 0 ? (
                          <p className="dex-panel-empty">No orders from this wallet in the most recent order ids on this pair.</p>
                        ) : (
                          [...openOrders, ...closedOrders].map((entry) => {
                            const status = orderStatusLabel(entry, nowSeconds);
                            const cancellable = status === 'OPEN' || status === 'PARTIAL' || status === 'EXPIRED';
                            return (
                              <article className={`dex-order-row dex-order-row--${entry.order.side === 0 ? 'buy' : 'sell'}`} key={entry.id.toString()}>
                                <div className="dex-order-row__head">
                                  <strong>{entry.order.side === 0 ? 'BUY' : 'SELL'}</strong>
                                  <code>#{entry.id.toString()}</code>
                                  <span className={`dex-order-status dex-order-status--${status.toLowerCase()}`}>{status}</span>
                                </div>
                                <dl>
                                  <div><dt>Price</dt><dd>{formatPriceX18(entry.order.priceX18, baseToken, quoteToken)}</dd></div>
                                  <div><dt>Amount</dt><dd>{formatTokenValue(entry.order.amount, baseToken, 6)} {tokenSymbol(baseToken)}</dd></div>
                                  <div><dt>Filled</dt><dd>{formatTokenValue(entry.order.filled, baseToken, 6)}</dd></div>
                                  <div><dt>Expires</dt><dd>{formatExpiry(entry.order.expiry)}</dd></div>
                                </dl>
                                <button
                                  className="dex-button dex-button--outline dex-button--small"
                                  type="button"
                                  data-order-id={entry.id.toString()}
                                  onClick={handleCancelOrder}
                                  disabled={!cancellable || walletBusy}
                                >
                                  {cancellable ? 'Cancel and refund escrow' : 'Closed'}
                                </button>
                              </article>
                            );
                          })
                        )}
                      </section>
                    </>
                  ))}
                </div>
              )}

              {tab === 'create' && (
                <form
                  className="dex-tabpanel"
                  id="dex-panel-create"
                  onSubmit={handleCreatePool}
                >
                  <h3 className="dex-subhead">Create a SpotPool</h3>
                  <p className="dex-trade-note">
                    <code>DexRegistry.createSpotPool</code> is permissionless: it deploys the pool through SpotPoolFactory and opens the matching Orderbook book in the same transaction. Token order does not matter, the registry sorts the pair.
                  </p>

                  <label className="dex-field">
                    <span>Token A</span>
                    <input
                      value={createTokenA}
                      onChange={(event) => { setCreateTokenA(event.target.value); setActionError(null); }}
                      placeholder="0x... ERC20"
                      spellCheck="false"
                      autoComplete="off"
                    />
                    <small>{createTokenA && createTokenAAddress === null ? 'Not a valid 20-byte address.' : 'Any deployed ERC20 on Monad.'}</small>
                  </label>
                  <label className="dex-field">
                    <span>Token B</span>
                    <input
                      value={createTokenB}
                      onChange={(event) => { setCreateTokenB(event.target.value); setActionError(null); }}
                      placeholder="0x... ERC20"
                      spellCheck="false"
                      autoComplete="off"
                    />
                    <small>{createTokenB && createTokenBAddress === null ? 'Not a valid 20-byte address.' : 'Must differ from token A.'}</small>
                  </label>

                  <div className="dex-fee-picker" role="group" aria-label="LP fee tier">
                    {FEE_PRESETS.map((preset) => (
                      <button
                        key={preset.ppm}
                        className={`dex-fee-option${createFeePpm === preset.ppm ? ' dex-fee-option--active' : ''}`}
                        type="button"
                        onClick={() => setCreateFeePpm(preset.ppm)}
                      >
                        <strong>{preset.label}</strong>
                        <small>{preset.note}</small>
                      </button>
                    ))}
                  </div>

                  <div className="dex-field-row">
                    <label className="dex-field">
                      <span>LP fee (ppm)</span>
                      <input
                        value={createFeePpm}
                        onChange={(event) => { setCreateFeePpm(event.target.value); setActionError(null); }}
                        inputMode="numeric"
                        autoComplete="off"
                      />
                      <small>
                        {createFee === null
                          ? 'Whole ppm value only.'
                          : !createFeeWithinLimit
                            ? `Above the registry ceiling of ${formatPpmLimit(dex.registryWiring.maxLpFeeRatePpm)}.`
                            : `${formatFeePpm(createFee)} per swap, fixed at creation.`}
                      </small>
                    </label>
                    <label className="dex-field">
                      <span>Orderbook tick size</span>
                      <input
                        value={createTickSize}
                        onChange={(event) => { setCreateTickSize(event.target.value); setActionError(null); }}
                        inputMode="numeric"
                        autoComplete="off"
                      />
                      <small>{createTick === null || createTick === 0n ? 'Must be a whole number above zero.' : 'Minimum price increment on the shared book.'}</small>
                    </label>
                  </div>

                  <div className="dex-create-summary">
                    <span>DERIVED PAIR ID</span>
                    <code>{createPairId ? `${createPairId.slice(0, 18)}...${createPairId.slice(-8)}` : EMPTY}</code>
                    <small>keccak256 of the sorted token pair, the same key DexRegistry stores.</small>
                  </div>

                  <button className="dex-button dex-button--gold dex-button--full" type="submit" disabled={!createReady || walletBusy}>
                    {createButtonLabel} <span aria-hidden="true">-&gt;</span>
                  </button>
                  <p className="dex-trade-note">The pool is simulated against the live registry first, so a duplicate pair, a fee above the ceiling, or a zero tick is reported before your wallet opens.</p>
                </form>
              )}
            </div>

            {unresolvedTransaction && (
              <div className="dex-unresolved" role="alert">
                <span>Receipt status is uncertain for <code>{formatHash(unresolvedTransaction.hash)}</code>. Verify it in your wallet or explorer before continuing.</span>
                <button className="dex-button dex-button--small" type="button" onClick={handleAcknowledgeUnresolvedTransaction}>I verified it</button>
              </div>
            )}
          </section>

          <aside className="dex-rail" aria-label="DEX live readings">
            {pool?.valid ? (
              <section className="dex-telemetry-panel" aria-labelledby="dex-pool-readings-title">
                <div className="dex-panel-heading">
                  <div><span className="panel-kicker">POOL TELEMETRY</span><h2 id="dex-pool-readings-title">Live pool</h2></div>
                  <code>{shortenAddress(pool.address)}</code>
                </div>
                <div className="dex-metric-grid">
                  <PoolMetric label="RESERVE 0" value={formatTokenValue(pool.reserves?.reserve0 ?? null, pool.token0)} note={tokenSymbol(pool.token0)} />
                  <PoolMetric label="RESERVE 1" value={formatTokenValue(pool.reserves?.reserve1 ?? null, pool.token1)} note={tokenSymbol(pool.token1)} />
                  <PoolMetric label="SPOT PRICE" value={formatPriceX18(pool.spotPriceX18 ?? pool.reservePriceX18, pool.token0, pool.token1)} note="token1 per token0" />
                  <PoolMetric label="LP FEE" value={formatFeePpm(pool.feePpm)} note="fixed at pool creation" />
                  <PoolMetric label="TOTAL SHARES" value={pool.totalShares === null ? EMPTY : pool.totalShares.toString()} note="pool LP supply" />
                  <PoolMetric label="PAIR ID" value={pool.pairId ? `${pool.pairId.slice(0, 10)}...` : EMPTY} note="bytes32" />
                </div>
                <div className="dex-pool-reading-note">
                  <span className={`dex-reading-dot${pool.hasLiquidity ? ' dex-reading-dot--good' : ''}`} />
                  {pool.hasLiquidity ? 'Reserves are nonzero. Quote reads are enabled.' : 'Pool is deployed but not seeded.'}
                </div>
              </section>
            ) : (
              <section className="dex-telemetry-panel dex-telemetry-panel--quiet">
                <span className="panel-kicker">POOL TELEMETRY</span>
                <h2>Nothing invented here.</h2>
                <p>Live cards appear only after a real SpotPool, token metadata, pair ID, and reserve tuple are read from Monad.</p>
              </section>
            )}

            <section className="dex-orderbook-panel" aria-labelledby="dex-orderbook-title">
              <div className="dex-panel-heading">
                <div><span className="panel-kicker">ORDERBOOK / SAME PAIR</span><h2 id="dex-orderbook-title">Best levels</h2></div>
                <span className="dex-panel-stamp">{dex.orderbook?.bookConfig ? 'READ' : 'WAITING'}</span>
              </div>
              {pool?.valid && dex.orderbook ? (
                <>
                  <div className="dex-book-levels">
                    <div><span>BEST BID</span><strong>{formatLevelPrice(dex.orderbook.bestBid?.priceX18 ?? null, pool)}</strong><small>{formatTokenValue(dex.orderbook.bestBid?.totalBase ?? null, pool.token0)} {tokenSymbol(pool.token0)}</small></div>
                    <div><span>BEST ASK</span><strong>{formatLevelPrice(dex.orderbook.bestAsk?.priceX18 ?? null, pool)}</strong><small>{formatTokenValue(dex.orderbook.bestAsk?.totalBase ?? null, pool.token0)} {tokenSymbol(pool.token0)}</small></div>
                  </div>
                  <div className="dex-book-config">
                    <span>BOOK CONFIG</span>
                    <strong>{dex.orderbook.bookConfig?.initialized ? 'INITIALIZED' : dex.orderbook.bookConfig ? 'EMPTY' : 'UNAVAILABLE'}</strong>
                    <small>{dex.orderbook.bookConfig?.tickSize === undefined ? 'Pair config not decoded.' : `Tick ${dex.orderbook.bookConfig.tickSize.toString()}`}</small>
                  </div>
                </>
              ) : (
                <p className="dex-panel-empty">Orderbook levels wait for a verified pool pair ID.</p>
              )}
            </section>
          </aside>
        </div>

        <section className="dex-infrastructure" aria-labelledby="dex-infrastructure-title">
          <div className="dex-section-heading">
            <div><span className="eyebrow"><span className="eyebrow__line eyebrow__line--ink" />DEPLOYED WIRING</span><h2 id="dex-infrastructure-title">The machine<br /><em>behind the market.</em></h2></div>
            <p>Every address below is the supplied Monad mainnet deployment. Registry reads are compared against these anchors; mismatches stay visible.</p>
          </div>
          <div className="dex-infra-grid">
            <InfrastructureCard label="DexRegistry" address={DEX_CONTRACTS.registry} note="01 / REGISTRY" detail={dex.registryWiring.status === 'healthy' ? 'wiring confirmed' : 'read status visible above'} />
            <InfrastructureCard label="ProtocolTreasury" address={DEX_CONTRACTS.protocolTreasury} note="02 / TREASURY" detail="protocol fee sink" />
            <InfrastructureCard label="Orderbook" address={DEX_CONTRACTS.orderbook} note="03 / BOOK" detail={dex.registryWiring.infraRegistry.orderbook ? `registry ${shortenAddress(dex.registryWiring.infraRegistry.orderbook)}` : 'registry read pending'} />
            <InfrastructureCard label="SpotPoolFactory" address={DEX_CONTRACTS.spotPoolFactory} note="04 / SPOT" detail="pool deployment" />
            <InfrastructureCard label="PerpPoolFactory" address={DEX_CONTRACTS.perpPoolFactory} note="05 / PERP" detail="perpetual deployment" />
            <InfrastructureCard
              label="DexPositionManager"
              address={DEX_CONTRACTS.positionManager}
              note="06 / S9-POS"
              detail={dex.positionManager.symbol ? `${dex.positionManager.symbol} / next #${dex.positionManager.nextTokenId?.toString() ?? EMPTY}` : 'position NFT metadata pending'}
            />
          </div>
          <div className="dex-s9pos-note">
            <span>S9-POS</span>
            <p><strong>DexPositionManager is an ERC-721 position wrapper.</strong> It custodies LP shares and is not the SpotPool swap target. Swaps and deposits approve the selected token to the selected SpotPool only.</p>
          </div>
        </section>
      </div>
    </section>
  );
}

export default DexPage;
