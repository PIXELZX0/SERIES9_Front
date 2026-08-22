import { useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent } from 'react';
import {
  CONTRACTS,
  MONAD,
  encodeApprove,
  encodeCollectStakingRewards,
  encodeClaimNFTRewards,
  encodeClaimRewards,
  encodeClaimUnstaked,
  encodeClaimUnstakedMonad,
  encodeCreateWallet,
  encodeMintIdentity,
  encodeMintIdentityWithHandle,
  encodeRequestUnstakeMonad,
  encodeSetReputationScore,
  encodeSetHandle,
  encodeStake,
  encodeStakeMonad,
  encodeUnstake,
  encodeUpdateProfile,
  encodeVerify,
  explorerAddressUrl,
  formatCompact,
  formatUnits,
  shortenAddress,
} from './chain.ts';
import { useWallet } from './useWallet.ts';
import { useAccount, useProtocol, type AccountStats, type ProtocolStats } from './useProtocol.ts';
import DexPage from './DexPage.tsx';

type IconName = 'arrow' | 'bolt' | 'card' | 'check' | 'copy' | 'cubes' | 'diamond' | 'lock' | 'menu' | 'orbit' | 'wallet';
type SectionId = 'overview' | 'identity' | 'staking' | 'tokenomics' | 'dex' | 'moderator' | 'pulse';
type SiteRoute = '/' | '/identity' | '/staking' | '/tokenomics' | '/dex' | '/moderator';
type Page = 'home' | 'identity' | 'staking' | 'tokenomics' | 'dex' | 'moderator';
type TokenKind = 'SER9' | 'MON';
type StakingAsset = TokenKind;
type ToastKind = 'success' | 'error';
type UnresolvedSubmittedTransaction = {
  hash: string;
  label: string;
  walletAddress: string;
};
type UnresolvedSubmittedTransactions = Record<string, UnresolvedSubmittedTransaction>;

const UNRESOLVED_TRANSACTION_STORAGE_KEY = 'series9:unresolved-submitted-transactions';
const WALLET_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

type Feature = {
  id: 'identity' | 'staking' | 'wallet';
  number: string;
  eyebrow: string;
  title: string;
  description: string;
  statLabel: string;
  statValue: string;
  statToken?: TokenKind;
  icon: IconName;
  theme: 'light' | 'sand' | 'dark';
  details: Array<{ text: string; token?: TokenKind }>;
};

type Activity = {
  type: string;
  detail: string;
  amount: string;
  time: string;
  token?: TokenKind;
  timeToken?: TokenKind;
  icon: IconName;
};

/** Placeholder for a value the chain has not returned (yet, or at all). */
const PENDING = '—';
const MON_NATIVE_GAS_RESERVE = 250_000_000_000_000_000n; // 0.25 MON fallback
const MON_NATIVE_GAS_CUSHION = 10_000_000_000_000_000n; // 0.01 MON
const MON_NATIVE_GAS_ESTIMATE_VALUE = 1n;

function bufferedMonGasReserve(fee: bigint): bigint {
  return fee + fee / 2n + MON_NATIVE_GAS_CUSHION;
}

function tokenAmount(value: bigint | null, decimals: number, precision = 2): string {
  return value === null ? PENDING : formatUnits(value, decimals, precision);
}

function compactAmount(value: bigint | null, decimals: number): string {
  return value === null ? PENDING : formatCompact(value, decimals);
}

function safeSubtract(left: bigint | null, right: bigint | null): bigint | null {
  if (left === null || right === null) return null;
  return left >= right ? left - right : 0n;
}

function percentageFromValues(part: bigint | null, total: bigint | null): string {
  if (part === null || total === null || total === 0n) return PENDING;

  const basisPoints = (part * 10_000n) / total;
  const whole = basisPoints / 100n;
  const fraction = (basisPoints % 100n).toString().padStart(2, '0');
  return fraction === '00' ? `${whole.toLocaleString('en-US')}%` : `${whole.toLocaleString('en-US')}.${fraction}%`;
}

function progressFromValues(part: bigint | null, total: bigint | null): number | null {
  if (part === null || total === null || total === 0n) return null;
  return Math.min(100, Number((part * 10_000n) / total) / 100);
}

function gweiFromWei(value: bigint | null): string {
  if (value === null) return PENDING;
  return `${formatUnits(value, 9, 2)} gwei`;
}

function parseUnitsInput(value: string, decimals: number): bigint | null {
  const normalized = value.trim().replace(/,/g, '');
  if (!/^\d*(?:\.\d*)?$/.test(normalized) || normalized === '' || normalized === '.') return null;

  const [whole = '0', fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) return null;

  try {
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  } catch {
    return null;
  }
}

function formatStakingInput(value: string): string {
  const normalized = value.replace(/,/g, '');
  if (!/^\d*(?:\.\d*)?$/.test(normalized)) return value;

  const [whole = '', fraction] = normalized.split('.');
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? groupedWhole : `${groupedWhole}.${fraction}`;
}

function formatInputUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  const rawValue = fraction === 0n
    ? whole.toString()
    : `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
  return formatStakingInput(rawValue);
}

function getFormattedCaretPosition(value: string, formattedValue: string, selectionStart: number | null): number {
  const charactersBeforeCursor = value.slice(0, selectionStart ?? value.length).replace(/,/g, '').length;
  if (charactersBeforeCursor === 0) return 0;

  let charactersCounted = 0;
  for (let index = 0; index < formattedValue.length; index += 1) {
    if (formattedValue[index] !== ',') charactersCounted += 1;
    if (charactersCounted >= charactersBeforeCursor) return index + 1;
  }

  return formattedValue.length;
}

const LOCAL_TOKEN_LOGOS: Record<TokenKind, string> = {
  SER9: `${import.meta.env.BASE_URL}token-logos/ser9.svg`,
  MON: `${import.meta.env.BASE_URL}token-logos/mon.svg`,
};

function normalizeTokenImageUri(value: string | null | undefined): string | null {
  const uri = value?.trim();
  if (!uri) return null;
  if (/^https?:\/\//i.test(uri) || /^data:image\//i.test(uri)) return uri;
  if (/^(?:\/|\.\.?\/)/.test(uri)) return uri;
  if (!/^ipfs:\/\//i.test(uri)) return null;

  const path = uri.replace(/^ipfs:\/\//i, '').replace(/^ipfs\//i, '');
  return path ? `https://ipfs.io/ipfs/${path}` : null;
}

function IdentityNftArtwork({
  imageUri,
  alt,
  className = '',
  decorative = false,
}: {
  imageUri: string | null | undefined;
  alt: string;
  className?: string;
  decorative?: boolean;
}) {
  const source = normalizeTokenImageUri(imageUri);
  const [failedImageSources, setFailedImageSources] = useState<string[]>([]);
  const imageSource = source !== null && !failedImageSources.includes(source) ? source : null;
  const rootClassName = `identity-artwork${className ? ` ${className}` : ''}${imageSource ? ' identity-artwork--image' : ' identity-artwork--fallback'}`;

  return (
    <div className={rootClassName} aria-hidden={decorative || undefined}>
      {imageSource ? (
        <img
          src={imageSource}
          alt={decorative ? '' : alt}
          onError={() => setFailedImageSources((failed) => failed.includes(imageSource) ? failed : [...failed, imageSource])}
        />
      ) : (
        <span
          className="identity-artwork__fallback"
          role={decorative ? undefined : 'img'}
          aria-label={decorative ? undefined : alt}
          aria-hidden={decorative || undefined}
        >
          <span className="monogram-ring monogram-ring--back" aria-hidden="true" />
          <span className="monogram-ring monogram-ring--front" aria-hidden="true" />
          <span className="monogram-nine" aria-hidden="true">9</span>
        </span>
      )}
    </div>
  );
}

function TokenLogo({
  token,
  imageUri,
  size = 'small',
  standalone = false,
}: {
  token: TokenKind;
  imageUri?: string | null;
  size?: 'small' | 'medium';
  standalone?: boolean;
}) {
  const dynamicImageSource = token === 'SER9' ? normalizeTokenImageUri(imageUri) : null;
  const localImageSource = normalizeTokenImageUri(LOCAL_TOKEN_LOGOS[token]);
  const [failedImageSources, setFailedImageSources] = useState<string[]>([]);
  const imageSource = [dynamicImageSource, localImageSource].find(
    (source): source is string => source !== null && !failedImageSources.includes(source),
  );
  const label = token === 'MON' ? 'MON native token' : 'SER9 token';

  return (
    <span
      className={`token-logo token-logo--${size}`}
      role={standalone ? 'img' : undefined}
      aria-label={standalone ? label : undefined}
      aria-hidden={standalone ? undefined : true}
    >
      {imageSource ? (
        <img
          src={imageSource}
          alt=""
          aria-hidden="true"
          onError={() => setFailedImageSources((failed) => failed.includes(imageSource) ? failed : [...failed, imageSource])}
        />
      ) : (
        <span className="token-logo__fallback" aria-hidden="true">{token === 'MON' ? 'M' : '9'}</span>
      )}
    </span>
  );
}

function parseRequestId(value: string, latest: bigint | null): bigint | null {
  const normalized = value.trim();
  if (normalized === '') return latest;
  if (!/^\d+$/.test(normalized)) return null;
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

function parseUnsignedInteger(value: string): bigint | null {
  const normalized = value.trim().replace(/,/g, '');
  if (!/^\d+$/.test(normalized)) return null;

  try {
    const parsed = BigInt(normalized);
    return parsed < 2n ** 256n ? parsed : null;
  } catch {
    return null;
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function identityTypeLabel(value: bigint | null): string {
  if (value === null) return PENDING;
  return value === 0n ? 'Human' : value === 1n ? 'AI' : `Type ${value.toString()}`;
}

function unstakeRequestState(request: { minClaimEpoch: bigint; claimed: boolean } | null): string {
  if (!request) return PENDING;
  if (request.claimed) return 'claimed';
  if (request.minClaimEpoch === 18_446_744_073_709_551_615n) return 'coverage pending';
  return `claim epoch ${request.minClaimEpoch.toString()}`;
}

function shortenHash(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function walletAddressKey(address: string): string {
  return address.toLowerCase();
}

function sameTransactionHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getUnresolvedTransactionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isStoredUnresolvedTransaction(value: unknown, key: string): value is UnresolvedSubmittedTransaction {
  if (!isRecord(value)) return false;

  const { hash, label, walletAddress } = value;
  return typeof hash === 'string' &&
    TRANSACTION_HASH_PATTERN.test(hash) &&
    !/^0+$/.test(hash.slice(2)) &&
    typeof label === 'string' &&
    label.trim().length > 0 &&
    typeof walletAddress === 'string' &&
    WALLET_ADDRESS_PATTERN.test(walletAddress) &&
    walletAddressKey(walletAddress) === key;
}

function readUnresolvedSubmittedTransactions(): UnresolvedSubmittedTransactions {
  const storage = getUnresolvedTransactionStorage();
  if (!storage) return {};

  let serialized: string | null;
  try {
    serialized = storage.getItem(UNRESOLVED_TRANSACTION_STORAGE_KEY);
  } catch {
    return {};
  }
  if (serialized === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};

  const transactions: UnresolvedSubmittedTransactions = {};
  for (const [storedKey, value] of Object.entries(parsed)) {
    const key = walletAddressKey(storedKey);
    if (!WALLET_ADDRESS_PATTERN.test(storedKey) || !isStoredUnresolvedTransaction(value, key)) continue;
    transactions[key] = {
      hash: value.hash,
      label: value.label,
      walletAddress: value.walletAddress,
    };
  }
  return transactions;
}

function persistUnresolvedSubmittedTransactions(transactions: UnresolvedSubmittedTransactions): void {
  const storage = getUnresolvedTransactionStorage();
  if (!storage) return;

  try {
    if (Object.keys(transactions).length === 0) {
      storage.removeItem(UNRESOLVED_TRANSACTION_STORAGE_KEY);
    } else {
      storage.setItem(UNRESOLVED_TRANSACTION_STORAGE_KEY, JSON.stringify(transactions));
    }
  } catch {
    // Storage can be disabled or unavailable in a private browsing context.
  }
}

function persistSubmittedTransaction(transaction: UnresolvedSubmittedTransaction): void {
  const transactions = readUnresolvedSubmittedTransactions();
  transactions[walletAddressKey(transaction.walletAddress)] = transaction;
  persistUnresolvedSubmittedTransactions(transactions);
}

function isKnownMinedRevert(error: unknown): boolean {
  return error instanceof Error && error.message === 'Transaction was mined but reverted on Monad.';
}

function routeHref(route: SiteRoute, hash = ''): string {
  const basePath = import.meta.env.BASE_URL.replace(/\/+$/, '');
  return `${basePath}${route}${hash}` || '/';
}

function currentPage(pathname = window.location.pathname): Page {
  const basePath = import.meta.env.BASE_URL.replace(/\/+$/, '');
  const routePath = basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))
    ? pathname.slice(basePath.length)
    : pathname;
  const normalizedPath = routePath.replace(/\/+$/, '') || '/';

  if (normalizedPath === '/identity') return 'identity';
  if (normalizedPath === '/staking') return 'staking';
  if (normalizedPath === '/tokenomics') return 'tokenomics';
  if (normalizedPath === '/dex') return 'dex';
  if (normalizedPath === '/moderator') return 'moderator';
  return 'home';
}

const navLinks: Array<{ label: string; href: string; id: SectionId }> = [
  { label: 'Overview', href: routeHref('/', '#overview'), id: 'overview' },
  { label: 'Tokenomics', href: routeHref('/tokenomics'), id: 'tokenomics' },
  { label: 'Staking', href: routeHref('/staking'), id: 'staking' },
  { label: 'Identity', href: routeHref('/identity'), id: 'identity' },
  { label: 'DEX', href: routeHref('/dex'), id: 'dex' },
  { label: 'Moderator', href: routeHref('/moderator'), id: 'moderator' },
  { label: 'Pulse', href: routeHref('/', '#pulse'), id: 'pulse' },
];

function buildFeatures(stats: ProtocolStats): Feature[] {
  const symbol = stats.ser9Symbol ?? 'SER9';

  return [
    {
      id: 'identity',
      number: '01',
      eyebrow: 'Identity NFT',
      title: 'Own the signal.',
      description:
        'A living identity primitive for the people, protocols, and places you return to onchain.',
      statLabel: 'Identities minted',
      statValue: stats.identityCount === null ? PENDING : stats.identityCount.toLocaleString('en-US'),
      icon: 'diamond',
      theme: 'light',
      details: [
        { text: `Human mint fee ${tokenAmount(stats.humanMintFee, stats.ser9Decimals, 0)} ${symbol}`, token: 'SER9' },
        { text: `AI mint fee ${tokenAmount(stats.aiMintFee, stats.ser9Decimals, 0)} ${symbol}`, token: 'SER9' },
      ],
    },
    {
      id: 'staking',
      number: '02',
      eyebrow: 'Staking engine',
      title: 'Make time compound.',
      description:
        'Turn conviction into a position. Stake SER9, collect protocol rewards, and keep moving.',
      statLabel: `Total staked (${symbol})`,
      statValue: compactAmount(stats.totalStaked, stats.ser9Decimals),
      statToken: 'SER9',
      icon: 'bolt',
      theme: 'sand',
      details: [
        { text: `Reward index ${tokenAmount(stats.rewardPerTokenStored, stats.ser9Decimals, 2)}`, token: 'SER9' },
        { text: 'Rewards accrue per block' },
      ],
    },
    {
      id: 'wallet',
      number: '03',
      eyebrow: 'Smart wallet',
      title: 'Pay as yourself.',
      description:
        'A smart wallet that keeps permissions simple and your identity close to every action.',
      statLabel: 'Wallets deployed',
      statValue: stats.walletCount === null ? PENDING : stats.walletCount.toLocaleString('en-US'),
      icon: 'wallet',
      theme: 'dark',
      details: [{ text: 'Deterministic CREATE2 address' }, { text: 'Built for Monad speed' }],
    },
  ];
}

/** Live protocol readings, rendered in the slot the mock activity feed used. */
function buildActivity(stats: ProtocolStats, account: AccountStats, connected: boolean): Activity[] {
  const symbol = stats.ser9Symbol ?? 'SER9';

  const rows: Activity[] = [
    {
      type: 'Latest block',
      detail: MONAD.name,
      amount: stats.blockNumber === null ? PENDING : `#${stats.blockNumber.toLocaleString('en-US')}`,
      time: gweiFromWei(stats.gasPriceWei),
      icon: 'cubes',
    },
    {
      type: 'Total staked',
      detail: `${symbol} in staking contract`,
      amount: `${compactAmount(stats.totalStaked, stats.ser9Decimals)} ${symbol}`,
      time: shortenAddress(CONTRACTS.staking),
      token: 'SER9',
      icon: 'bolt',
    },
    {
      type: 'Identities minted',
      detail: 'Series9Identity / S9ID',
      amount: stats.identityCount === null ? PENDING : `${stats.identityCount} minted`,
      time: shortenAddress(CONTRACTS.identity),
      icon: 'diamond',
    },
    {
      type: `${symbol} supply`,
      detail: 'ERC-20 totalSupply',
      amount: `${compactAmount(stats.ser9TotalSupply, stats.ser9Decimals)} ${symbol}`,
      time: shortenAddress(CONTRACTS.ser9),
      token: 'SER9',
      icon: 'cubes',
    },
    {
      type: 'Reputation weight',
      detail: 'Total across all identities',
      amount:
        stats.totalReputationScore === null ? PENDING : stats.totalReputationScore.toLocaleString('en-US'),
      time: 'reward split basis',
      icon: 'check',
    },
  ];

  if (connected) {
    rows.push(
      {
        type: `Your ${symbol} balance`,
        detail: 'Connected wallet',
        amount: `${tokenAmount(account.ser9Balance, stats.ser9Decimals)} ${symbol}`,
        time: 'live',
        token: 'SER9',
        icon: 'wallet',
      },
      {
        type: 'Your staked position',
        detail: 'Series9 staking',
        amount: `${tokenAmount(account.staked, stats.ser9Decimals)} ${symbol}`,
        time: `earned ${tokenAmount(account.stakingRewards, stats.ser9Decimals)} ${symbol}`,
        token: 'SER9',
        timeToken: 'SER9',
        icon: 'bolt',
      },
    );
  }

  return rows;
}

/** Gas used per sampled block, normalized to 0–100 for the bar strip. */
function normalizeSeries(series: number[]): number[] {
  const peak = Math.max(...series, 1);
  return series.map((value) => Math.max(4, Math.round((value / peak) * 100)));
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 260;
const CHART_TOP_PADDING = 24;

/** Maps a 0–100 series onto the pulse chart's viewBox, returning line + area paths. */
function buildChartPaths(series: number[]): { line: string; area: string; lastX: number; lastY: number } {
  if (series.length < 2) {
    const flatY = CHART_HEIGHT / 2;
    return {
      line: `M0 ${flatY} L${CHART_WIDTH} ${flatY}`,
      area: `M0 ${flatY} L${CHART_WIDTH} ${flatY} V${CHART_HEIGHT} H0Z`,
      lastX: CHART_WIDTH,
      lastY: flatY,
    };
  }

  const usableHeight = CHART_HEIGHT - CHART_TOP_PADDING * 2;
  const points = series.map((value, index) => {
    const x = (index / (series.length - 1)) * CHART_WIDTH;
    const y = CHART_HEIGHT - CHART_TOP_PADDING - (value / 100) * usableHeight;
    return `${Math.round(x)} ${Math.round(y)}`;
  });

  const line = `M${points.join(' L')}`;
  const [lastX, lastY] = points[points.length - 1].split(' ').map(Number);

  return { line, area: `${line} V${CHART_HEIGHT} H0Z`, lastX, lastY };
}

/** Percent change between the first and last sample. */
function seriesDelta(series: number[]): string {
  if (series.length < 2 || series[0] === 0) return PENDING;
  const change = ((series[series.length - 1] - series[0]) / series[0]) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
}

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const commonProps = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (name) {
    case 'arrow':
      return (
        <svg {...commonProps}>
          <path d="M5 12h13" />
          <path d="m13 6 6 6-6 6" />
        </svg>
      );
    case 'bolt':
      return (
        <svg {...commonProps}>
          <path d="m13 2-9 12h7l-1 8 9-12h-7l1-8Z" />
        </svg>
      );
    case 'card':
      return (
        <svg {...commonProps}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 10h18" />
          <path d="M7 15h4" />
        </svg>
      );
    case 'check':
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="m8.5 12 2.3 2.3 4.8-5" />
        </svg>
      );
    case 'copy':
      return (
        <svg {...commonProps}>
          <rect x="8" y="8" width="10" height="11" rx="1.5" />
          <path d="M16 8V6a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h2" />
        </svg>
      );
    case 'cubes':
      return (
        <svg {...commonProps}>
          <path d="m12 3 7 4-7 4-7-4 7-4Z" />
          <path d="m5 12 7 4 7-4" />
          <path d="m5 16 7 4 7-4" />
          <path d="M12 11v9" />
        </svg>
      );
    case 'diamond':
      return (
        <svg {...commonProps}>
          <path d="m12 3 8 9-8 9-8-9 8-9Z" />
          <path d="m4 12 8-2 8 2" />
          <path d="m12 3v7" />
        </svg>
      );
    case 'lock':
      return (
        <svg {...commonProps}>
          <rect x="5" y="10" width="14" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          <path d="M12 14v3" />
        </svg>
      );
    case 'menu':
      return (
        <svg {...commonProps}>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      );
    case 'orbit':
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="2.6" />
          <ellipse cx="12" cy="12" rx="9" ry="4.5" transform="rotate(-28 12 12)" />
          <circle cx="19.5" cy="8.1" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'wallet':
      return (
        <svg {...commonProps}>
          <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 16.5v-9Z" />
          <path d="M4 8h13.5a2.5 2.5 0 0 1 0 5H16" />
          <circle cx="16.3" cy="10.5" r=".8" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return null;
  }
}

function ButtonArrow() {
  return <Icon name="arrow" size={16} />;
}

function BrandMark() {
  const rimId = useId();

  return (
    <span className="brand__mark" aria-hidden="true">
      <svg viewBox="0 0 256 256" width={31} height={31} focusable="false">
        <defs>
          <path id={rimId} d="M 128,26 a 102,102 0 1,1 -0.01,0" fill="none" />
        </defs>
        <circle cx="128" cy="128" r="128" fill="#0a0a0a" />
        <circle cx="128" cy="128" r="121" fill="none" stroke="#ffffff" strokeWidth="1.5" opacity="0.9" />
        <circle cx="128" cy="128" r="92" fill="none" stroke="#ffffff" strokeWidth="1" opacity="0.28" />
        <g>
          <text
            fontFamily="'Helvetica Neue', Helvetica, Arial, sans-serif"
            fontSize="13"
            fontWeight="500"
            letterSpacing="2"
            textAnchor="middle"
            fill="#ffffff"
            fillOpacity="0.55"
          >
            {['8.333%', '25%', '41.667%', '58.333%', '75%', '91.667%'].map((offset) => (
              <textPath href={`#${rimId}`} key={offset} startOffset={offset}>
                SERIES9
              </textPath>
            ))}
          </text>
          <g fill="#d4af37">
            <circle cx="128" cy="22" r="2" />
            <circle cx="219.8" cy="75" r="2" />
            <circle cx="219.8" cy="181" r="2" />
            <circle cx="128" cy="234" r="2" />
            <circle cx="36.2" cy="181" r="2" />
            <circle cx="36.2" cy="75" r="2" />
          </g>
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 128 128"
            to="360 128 128"
            dur="40s"
            repeatCount="indefinite"
          />
        </g>
        <path
          fill="#ffffff"
          d="M 128,52 Q 141.44,114.56 204,128 Q 141.44,141.44 128,204 Q 114.56,141.44 52,128 Q 114.56,114.56 128,52 Z"
        />
        <path
          fill="#0a0a0a"
          d="M 128,73.28 Q 137.67,118.33 182.72,128 Q 137.67,137.67 128,182.72 Q 118.33,137.67 73.28,128 Q 118.33,118.33 128,73.28 Z"
        />
        <path
          fill="#d4af37"
          d="M 128,99.12 Q 133.11,122.89 156.88,128 Q 133.11,133.11 128,156.88 Q 122.89,133.11 99.12,128 Q 122.89,122.89 128,99.12 Z"
        />
      </svg>
    </span>
  );
}

function FeatureCard({ feature, ser9Image }: { feature: Feature; ser9Image: string | null }) {
  const workspaceRoutes: Record<Feature['id'], SiteRoute> = {
    identity: '/identity',
    staking: '/staking',
    wallet: '/identity',
  };
  const workspaceHref = routeHref(workspaceRoutes[feature.id]);

  return (
    <article className={`feature-card feature-card--${feature.theme}`}>
      <div className="feature-card__topline">
        <span>{feature.number}</span>
        <span className="feature-card__icon"><Icon name={feature.icon} size={21} /></span>
      </div>
      <div className="feature-card__body">
        <p className="eyebrow">{feature.eyebrow}</p>
        <h3>{feature.title}</h3>
        <p className="feature-card__description">{feature.description}</p>
      </div>
      <ul className="feature-card__details" aria-label={`${feature.eyebrow} details`}>
        {feature.details.map((detail) => (
          <li key={detail.text}>
            <span className="detail-dot" />
            {detail.token ? (
              <span className="token-label">
                <span>{detail.text}</span>
                <TokenLogo token={detail.token} imageUri={detail.token === 'SER9' ? ser9Image : undefined} />
              </span>
            ) : detail.text}
          </li>
        ))}
      </ul>
      <a className="feature-card__link" href={workspaceHref}>
        {feature.id === 'wallet' ? 'Open identity workspace' : 'Open workspace'} <ButtonArrow />
      </a>
      <div className="feature-card__stat">
        <span>{feature.statLabel}</span>
        {feature.statToken ? (
          <strong className="token-value">
            <span>{feature.statValue}</span>
            <TokenLogo token={feature.statToken} imageUri={feature.statToken === 'SER9' ? ser9Image : undefined} />
          </strong>
        ) : (
          <strong>{feature.statValue}</strong>
        )}
      </div>
    </article>
  );
}

function IdentityRewardBreakdown({
  pendingNFTRewards,
  pendingStakingRewards,
  decimals,
  symbol,
  ser9Image,
  className = '',
}: {
  pendingNFTRewards: bigint | null;
  pendingStakingRewards: bigint | null;
  decimals: number;
  symbol: string;
  ser9Image: string | null;
  className?: string;
}) {
  return (
    <dl className={`identity-reward-breakdown${className ? ` ${className}` : ''}`}>
      <div>
        <dt>Claimable now</dt>
        <dd className="token-value">
          <span>{tokenAmount(pendingNFTRewards, decimals)} {symbol}</span>
          <TokenLogo token="SER9" imageUri={ser9Image} />
        </dd>
      </div>
      <div>
        <dt>Awaiting distribution</dt>
        <dd className="token-value">
          <span>{tokenAmount(pendingStakingRewards, decimals)} {symbol}</span>
          <TokenLogo token="SER9" imageUri={ser9Image} />
        </dd>
      </div>
    </dl>
  );
}

function TokenomicsMetric({
  label,
  value,
  note,
  token,
  imageUri,
}: {
  label: string;
  value: string;
  note: string;
  token?: TokenKind;
  imageUri?: string | null;
}) {
  return (
    <div className="tokenomics-metric">
      <span className="tokenomics-metric__label">{label}</span>
      {token ? (
        <strong className="token-value">
          <span>{value}</span>
          <TokenLogo token={token} imageUri={token === 'SER9' ? imageUri : undefined} />
        </strong>
      ) : (
        <strong>{value}</strong>
      )}
      <small>{note}</small>
    </div>
  );
}

function App() {
  const page = currentPage();
  const isHomePage = page === 'home';

  const [menuOpen, setMenuOpen] = useState(false);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [toast, setToast] = useState<{ message: string; kind: ToastKind } | null>(null);
  const [accountRefreshVersion, setAccountRefreshVersion] = useState(0);
  const [unresolvedSubmittedTransactions, setUnresolvedSubmittedTransactions] = useState<UnresolvedSubmittedTransactions>(
    readUnresolvedSubmittedTransactions,
  );
  const [activeSection, setActiveSection] = useState<SectionId>('overview');
  const [actionLabel, setActionLabel] = useState<string | null>(null);
  const [moderatorTokenId, setModeratorTokenId] = useState('');
  const [moderatorVerification, setModeratorVerification] = useState<'verified' | 'unverified'>('verified');
  const [reputationTokenId, setReputationTokenId] = useState('');
  const [reputationScore, setReputationScore] = useState('');
  const [mintName, setMintName] = useState('');
  const [mintBio, setMintBio] = useState('');
  const [mintHandle, setMintHandle] = useState('');
  const [mintEntityType, setMintEntityType] = useState<'human' | 'ai'>('human');
  const [profileName, setProfileName] = useState('');
  const [profileBio, setProfileBio] = useState('');
  const [profileDraftKey, setProfileDraftKey] = useState<string | null>(null);
  const [smartWalletCreatePending, setSmartWalletCreatePending] = useState(false);
  const [identityHandle, setIdentityHandle] = useState('');
  const [stakingAsset, setStakingAsset] = useState<StakingAsset>('SER9');
  const [stakingAmount, setStakingAmount] = useState('');
  const [ser9RequestId, setSer9RequestId] = useState('');
  const [monadRequestId, setMonadRequestId] = useState('');
  const [monGasReserve, setMonGasReserve] = useState(MON_NATIVE_GAS_RESERVE);
  const [monGasReserveSource, setMonGasReserveSource] = useState<'estimated' | 'fallback'>('fallback');
  const [monGasReserveAddress, setMonGasReserveAddress] = useState<string | null>(null);
  const stakingAmountInputRef = useRef<HTMLInputElement>(null);
  const stakingAmountCaretRef = useRef<number | null>(null);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const writeInFlightRef = useRef(false);
  const profileDraftKeyRef = useRef<string | null>(null);
  const smartWalletCreateKeyRef = useRef<string | null>(null);
  const unresolvedSubmittedTransactionsRef = useRef<UnresolvedSubmittedTransactions>(unresolvedSubmittedTransactions);

  const wallet = useWallet();
  const { address: walletAddress, onMonad: walletOnMonad, estimateTransactionFee } = wallet;
  const stats = useProtocol(accountRefreshVersion);
  const account = useAccount(wallet.address, stats.blockNumber, accountRefreshVersion);

  const connected = wallet.address !== null;
  const accountReadReady = connected && !account.loading && account.readStatus === 'ready';
  const stakingReadBlocked = connected && !accountReadReady;
  const accountIdentityKey = walletAddress && account.tokenId !== null
    ? `${walletAddress.toLowerCase()}:${account.tokenId.toString()}`
    : null;
  const moderatorAccess = accountReadReady && account.readStatus === 'ready' && account.identityModerator === true;
  const moderatorPermissionLoading = connected && account.readStatus !== 'error' && !accountReadReady;
  const moderatorAccessState: 'disconnected' | 'loading' | 'authorized' | 'denied' | 'unavailable' = !connected
    ? 'disconnected'
    : account.readStatus === 'error'
      ? 'unavailable'
      : moderatorPermissionLoading
      ? 'loading'
      : accountReadReady && moderatorAccess
        ? 'authorized'
        : !accountReadReady || account.identityModerator === null
          ? 'unavailable'
          : 'denied';
  const moderatorPermissionLabel = moderatorAccessState === 'disconnected'
    ? 'Wallet not connected'
    : moderatorAccessState === 'loading'
      ? 'Checking Identity permission'
      : moderatorAccessState === 'authorized'
        ? 'Permission confirmed'
        : moderatorAccessState === 'unavailable'
          ? 'Permission check unavailable'
          : 'Access denied';
  const moderatorRole = moderatorAccessState === 'loading'
    ? 'Verifying onchain role'
    : account.readStatus === 'error'
      ? 'Read paused'
      : accountReadReady && account.identityOwner === true
      ? 'Protocol owner'
      : accountReadReady && moderatorAccess
        ? 'Identity moderator'
        : connected
          ? 'No moderator role'
          : 'Connect wallet to check';
  const visibleNavLinks = navLinks.filter((link) => link.id !== 'moderator' || moderatorAccess);
  const symbol = stats.ser9Symbol ?? 'SER9';
  const features = buildFeatures(stats);
  const activity = buildActivity(stats, account, connected);
  const chartValues = normalizeSeries(stats.gasSeries);
  const chart = buildChartPaths(chartValues);
  const selectedDecimals = stakingAsset === 'SER9' ? stats.ser9Decimals : MONAD.nativeCurrency.decimals;
  const networkState = stats.error ? 'degraded' : stats.loading ? 'loading' : 'operational';
  const activeMonGasReserve = wallet.address && wallet.onMonad && monGasReserveAddress === wallet.address
    ? monGasReserve
    : MON_NATIVE_GAS_RESERVE;
  const isMonGasReserveEstimated = wallet.address !== null && wallet.onMonad && monGasReserveAddress === wallet.address && monGasReserveSource === 'estimated';
  const spendableMonBalance =
    account.monBalance === null
      ? null
      : account.monBalance > activeMonGasReserve
        ? account.monBalance - activeMonGasReserve
        : 0n;
  const selectedBalance = stakingAsset === 'SER9' ? account.ser9Balance : spendableMonBalance;
  const selectedStaked = stakingAsset === 'SER9' ? account.staked : account.monadStaked;
  const selectedAmount = parseUnitsInput(stakingAmount, selectedDecimals);
  const identityArtworkAlt = account.tokenId === null
    ? 'SERIES9 identity artwork preview'
    : `Identity NFT #${account.tokenId.toString()} artwork`;
  const smartWalletLive = account.walletOfReadReady && account.smartWallet !== null;
  const smartWalletPredictionAvailable = account.predictedWalletReadReady && account.predictedWallet !== null;
  const smartWalletReadsAvailable = account.walletOfReadReady && account.predictedWalletReadReady;
  const unresolvedSubmittedTransaction = walletAddress === null
    ? null
    : unresolvedSubmittedTransactions[walletAddressKey(walletAddress)] ?? null;
  const liquidSer9 = safeSubtract(stats.ser9TotalSupply, stats.totalStaked);
  const stakingRatioLabel = percentageFromValues(stats.totalStaked, stats.ser9TotalSupply);
  const stakingProgress = progressFromValues(stats.totalStaked, stats.ser9TotalSupply);
  const hasClaimableNFTRewards = account.pendingNFTRewards !== null && account.pendingNFTRewards > 0n;
  const hasAwaitingNFTRewards = stats.pendingStakingRewards !== null && stats.pendingStakingRewards > 0n;
  const identityRewardsReadReady = accountReadReady &&
    !stats.loading &&
    stats.error === null &&
    account.pendingNFTRewards !== null &&
    stats.pendingStakingRewards !== null;
  const identityRewardsAvailable = hasClaimableNFTRewards || hasAwaitingNFTRewards;
  const identityRewardsActionDisabled = !identityRewardsReadReady ||
    !identityRewardsAvailable ||
    !walletOnMonad ||
    wallet.connecting ||
    wallet.switching ||
    actionLabel !== null ||
    unresolvedSubmittedTransaction !== null;
  const identityRewardsButtonLabel = !identityRewardsReadReady
    ? 'Reading rewards'
    : hasAwaitingNFTRewards
      ? 'Collect & claim'
      : 'Claim rewards';
  const smartWalletAddress = smartWalletLive
    ? account.smartWallet
    : smartWalletPredictionAvailable
      ? account.predictedWallet
      : null;
  const profileDraftReady = accountIdentityKey !== null &&
    profileDraftKey === accountIdentityKey &&
    accountReadReady &&
    account.profileReadReady;
  const mintFee = mintEntityType === 'human' ? stats.humanMintFee : stats.aiMintFee;
  const mintFeeInsufficient =
    connected && mintFee !== null && account.ser9Balance !== null && account.ser9Balance < mintFee;
  const canStakeSelected =
    selectedAmount !== null &&
    selectedAmount > 0n &&
    (selectedBalance === null ? !connected : selectedAmount <= selectedBalance);
  const canUnstakeSelected =
    selectedAmount !== null &&
    selectedAmount > 0n &&
    (selectedStaked === null ? !connected : selectedAmount <= selectedStaked);
  const ser9ClaimRequestId = parseRequestId(ser9RequestId, account.ser9LatestUnstakeRequestId);
  const monadClaimRequestId = parseRequestId(monadRequestId, account.monadLatestUnstakeRequestId);

  useEffect(() => {
    if (!walletAddress || !walletOnMonad) return;

    let active = true;

    void estimateTransactionFee({
      to: CONTRACTS.staking,
      data: encodeStakeMonad(),
      value: MON_NATIVE_GAS_ESTIMATE_VALUE,
    })
      .then((fee) => {
        if (!active) return;
        setMonGasReserve(bufferedMonGasReserve(fee));
        setMonGasReserveSource('estimated');
        setMonGasReserveAddress(walletAddress);
      })
      .catch(() => {
        if (!active) return;
        setMonGasReserve(MON_NATIVE_GAS_RESERVE);
        setMonGasReserveSource('fallback');
        setMonGasReserveAddress(null);
      });

    return () => {
      active = false;
    };
  }, [walletAddress, walletOnMonad, estimateTransactionFee]);

  useEffect(() => {
    if (accountIdentityKey === null) {
      profileDraftKeyRef.current = null;
      return;
    }
    if (
      profileDraftKeyRef.current === accountIdentityKey ||
      account.loading ||
      account.readStatus !== 'ready' ||
      !account.profileReadReady
    ) return;

    profileDraftKeyRef.current = accountIdentityKey;
    setProfileName(account.name ?? '');
    setProfileBio(account.bio ?? '');
    setProfileDraftKey(accountIdentityKey);
  }, [account.bio, account.loading, account.name, account.profileReadReady, account.readStatus, accountIdentityKey]);

  useEffect(() => {
    const pendingKey = smartWalletCreateKeyRef.current;
    if (pendingKey === null) return;

    const pendingWalletKey = pendingKey.split(':', 1)[0];
    const walletChanged = walletAddress === null || walletAddressKey(walletAddress) !== pendingWalletKey;
    const readyReadShowsDifferentIdentity = accountReadReady &&
      (accountIdentityKey === null || accountIdentityKey !== pendingKey);

    if (walletChanged || readyReadShowsDifferentIdentity || account.smartWallet !== null) {
      smartWalletCreateKeyRef.current = null;
      setSmartWalletCreatePending(false);
    }
  }, [account.smartWallet, accountIdentityKey, accountReadReady, walletAddress]);

  useEffect(() => {
    if (!isHomePage) return;

    const sectionIds: SectionId[] = ['overview', 'pulse'];
    const updateActiveSection = () => {
      const position = window.scrollY + 180;
      let currentSection: SectionId = 'overview';

      sectionIds.forEach((sectionId) => {
        const section = document.getElementById(sectionId);
        if (section && section.offsetTop <= position) {
          currentSection = sectionId;
        }
      });

      setActiveSection(currentSection);
    };

    updateActiveSection();
    window.addEventListener('scroll', updateActiveSection, { passive: true });
    return () => window.removeEventListener('scroll', updateActiveSection);
  }, [isHomePage]);

  useEffect(() => {
    if (!toast) return;

    const timeoutId = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  useLayoutEffect(() => {
    const input = stakingAmountInputRef.current;
    const caretPosition = stakingAmountCaretRef.current;
    if (!input || caretPosition === null) return;

    input.setSelectionRange(caretPosition, caretPosition);
    stakingAmountCaretRef.current = null;
  }, [stakingAmount]);

  useEffect(() => {
    if (!menuOpen) return;

    const firstVisibleNavLink = navRef.current?.querySelector<HTMLAnchorElement>('a:not([hidden])');
    firstVisibleNavLink?.focus();

    function handleMenuKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;

      setMenuOpen(false);
      menuToggleRef.current?.focus();
    }

    document.addEventListener('keydown', handleMenuKeyDown);
    return () => document.removeEventListener('keydown', handleMenuKeyDown);
  }, [menuOpen]);

  function announce(message: string, kind: ToastKind = 'success') {
    setToast({ message, kind });
  }

  function announceError(message: string) {
    announce(message, 'error');
  }

  function rememberUnresolvedSubmittedTransaction(transaction: UnresolvedSubmittedTransaction) {
    const nextTransactions = {
      ...unresolvedSubmittedTransactionsRef.current,
      [walletAddressKey(transaction.walletAddress)]: transaction,
    };
    unresolvedSubmittedTransactionsRef.current = nextTransactions;
    setUnresolvedSubmittedTransactions(nextTransactions);
    persistUnresolvedSubmittedTransactions(nextTransactions);
  }

  function clearUnresolvedSubmittedTransaction(walletAddress: string, expectedHash: string): boolean {
    const key = walletAddressKey(walletAddress);
    const storedTransactions = readUnresolvedSubmittedTransactions();
    const storedTransaction = storedTransactions[key];
    if (storedTransaction && !sameTransactionHash(storedTransaction.hash, expectedHash)) return false;

    if (storedTransaction && sameTransactionHash(storedTransaction.hash, expectedHash)) {
      delete storedTransactions[key];
      persistUnresolvedSubmittedTransactions(storedTransactions);
    }

    const currentTransaction = unresolvedSubmittedTransactionsRef.current[key];
    if (!currentTransaction || !sameTransactionHash(currentTransaction.hash, expectedHash)) return true;

    const nextTransactions = { ...unresolvedSubmittedTransactionsRef.current };
    delete nextTransactions[key];
    unresolvedSubmittedTransactionsRef.current = nextTransactions;
    setUnresolvedSubmittedTransactions(nextTransactions);
    return true;
  }

  function handleAcknowledgeUnresolvedTransaction() {
    if (!walletAddress) return;

    const key = walletAddressKey(walletAddress);
    const transaction = unresolvedSubmittedTransactionsRef.current[key];
    if (!transaction) return;

    if (!clearUnresolvedSubmittedTransaction(transaction.walletAddress, transaction.hash)) return;
    if (transaction.label === 'Create smart wallet') {
      smartWalletCreateKeyRef.current = null;
      setSmartWalletCreatePending(false);
    }
    setAccountRefreshVersion((version) => version + 1);
    announce(`Verified ${shortenHash(transaction.hash)}. New writes are available for this wallet.`);
  }

  function renderUnresolvedTransactionBanner() {
    if (!unresolvedSubmittedTransaction) return null;

    return (
      <div className="workspace-banner workspace-banner--uncertain" role="alert">
        <span>
          <strong>Transaction status uncertain.</strong>{' '}
          {unresolvedSubmittedTransaction.label} was submitted as <code>{shortenHash(unresolvedSubmittedTransaction.hash)}</code> from {shortenAddress(unresolvedSubmittedTransaction.walletAddress)}.
          {' '}Verify it in your wallet or Monad explorer before continuing.
        </span>
        <button className="workspace-button workspace-button--small" type="button" onClick={handleAcknowledgeUnresolvedTransaction}>
          I verified the transaction
        </button>
      </div>
    );
  }

  function handleStakingAmountChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const formattedValue = formatStakingInput(input.value);
    const caretPosition = getFormattedCaretPosition(input.value, formattedValue, input.selectionStart);

    stakingAmountCaretRef.current = formattedValue === stakingAmount ? null : caretPosition;
    input.value = formattedValue;
    input.setSelectionRange(caretPosition, caretPosition);
    setStakingAmount(formattedValue);
  }

  function handleNavClick(event: MouseEvent<HTMLAnchorElement>) {
    if (page === 'dex' && actionLabel !== null) {
      event.preventDefault();
      announceError('A DEX transaction is still being confirmed. Verify or acknowledge it before leaving this page.');
      return;
    }

    const shouldRestoreMenuFocus = menuOpen && window.matchMedia('(max-width: 820px)').matches;
    setMenuOpen(false);

    if (shouldRestoreMenuFocus) {
      window.requestAnimationFrame(() => menuToggleRef.current?.focus());
    }
  }

  async function handleConnectWallet() {
    if (connected) {
      wallet.disconnect();
      announce('Wallet disconnected from this site. Revoke access in your wallet to fully remove it.');
      return;
    }

    const result = await wallet.connect();
    if (result.error) {
      announceError(result.error);
    } else {
      announce(`Connected ${result.address ? shortenAddress(result.address) : 'wallet'} on ${MONAD.name}.`);
    }
  }

  async function handleSwitchNetwork() {
    try {
      await wallet.switchToMonad();
    } catch (switchError) {
      announceError(
        switchError instanceof Error && switchError.message
          ? switchError.message
          : `Could not switch networks. Select ${MONAD.name} in your wallet.`,
      );
    }
  }

  async function requireMonadWallet(): Promise<boolean> {
    if (!wallet.address) {
      const result = await wallet.connect();
      if (result.error) {
        announceError(result.error);
      } else {
        announce(`Wallet connected. Click the action again after ${MONAD.name} is ready.`);
      }
      return false;
    }

    if (!wallet.onMonad) {
      announceError(`Switch your wallet to ${MONAD.name} before signing this action.`);
      return false;
    }

    return true;
  }

  async function sendAndWait(
    label: string,
    request: { to: string; data?: string; value?: bigint },
    writeLockOwned = false,
  ): Promise<boolean> {
    const submittedWalletAddress = wallet.address;
    const unresolvedTransaction = submittedWalletAddress === null
      ? null
      : unresolvedSubmittedTransactionsRef.current[walletAddressKey(submittedWalletAddress)] ??
        readUnresolvedSubmittedTransactions()[walletAddressKey(submittedWalletAddress)] ??
        null;
    if (unresolvedTransaction) {
      announceError(
        `Transaction ${shortenHash(unresolvedTransaction.hash)} is unresolved. Verify it before sending another wallet action.`,
      );
      return false;
    }

    if (!writeLockOwned) {
      if (writeInFlightRef.current) {
        announceError('Another wallet action is already in progress.');
        return false;
      }
      writeInFlightRef.current = true;
    }

    let submittedHash: string | null = null;
    try {
      setActionLabel(`${label} / waiting for wallet`);
      const hash = await wallet.sendTransaction(request);
      submittedHash = hash;
      if (submittedWalletAddress !== null) {
        persistSubmittedTransaction({
          hash,
          label,
          walletAddress: submittedWalletAddress,
        });
      }
      setActionLabel(`${label} / pending`);
      announce(`${label} submitted ${shortenHash(hash)}. Waiting for Monad confirmation.`);
      await wallet.waitForTransaction(hash);
      if (submittedWalletAddress !== null) {
        clearUnresolvedSubmittedTransaction(submittedWalletAddress, hash);
      }
      setAccountRefreshVersion((version) => version + 1);
      announce(`${label} confirmed. Live account data will refresh shortly.`);
      return true;
    } catch (actionError) {
      if (submittedHash !== null && submittedWalletAddress !== null && !isKnownMinedRevert(actionError)) {
        persistSubmittedTransaction({
          hash: submittedHash,
          label,
          walletAddress: submittedWalletAddress,
        });
        rememberUnresolvedSubmittedTransaction({
          hash: submittedHash,
          label,
          walletAddress: submittedWalletAddress,
        });
        announceError(
          `${label} submitted ${shortenHash(submittedHash)}, but its receipt could not be verified. Do not retry until you verify the transaction.`,
        );
      } else {
        if (submittedHash !== null && submittedWalletAddress !== null) {
          clearUnresolvedSubmittedTransaction(submittedWalletAddress, submittedHash);
        }
        announceError(actionError instanceof Error ? actionError.message : `${label} failed.`);
      }
      return false;
    } finally {
      if (!writeLockOwned) {
        setActionLabel(null);
        writeInFlightRef.current = false;
      }
    }
  }

  async function handleMintIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountReadReady) {
      announceError('Wait for a successful account read before minting an identity.');
      return;
    }
    if (writeInFlightRef.current) {
      announceError('Another wallet action is already in progress.');
      return;
    }
    const name = mintName.trim();
    const bio = mintBio.trim();
    const handle = mintHandle.trim();
    const nameBytes = new TextEncoder().encode(name).length;
    const bioBytes = new TextEncoder().encode(bio).length;
    const handleBytes = new TextEncoder().encode(handle).length;

    if (!name) {
      announceError('Give your identity a name before minting.');
      return;
    }
    if (nameBytes > 32 || bioBytes > 128) {
      announceError('Name must be 32 bytes or less and bio must be 128 bytes or less.');
      return;
    }
    if (handle && (handleBytes < 3 || handleBytes > 32)) {
      announceError('Handles must be between 3 and 32 bytes.');
      return;
    }

    const fee = mintEntityType === 'human' ? stats.humanMintFee : stats.aiMintFee;
    if (fee === null) {
      announceError('Mint fee is still loading from Monad.');
      return;
    }
    writeInFlightRef.current = true;
    setActionLabel('Preparing identity mint');

    try {
      if (!(await requireMonadWallet())) return;

      if (fee > 0n) {
        const approved = await sendAndWait(`Approve ${symbol} mint fee`, {
          to: CONTRACTS.ser9,
          data: encodeApprove(CONTRACTS.identity, fee),
        }, true);
        if (!approved) return;
      }

      const data = handle
        ? encodeMintIdentityWithHandle(name, bio, mintEntityType === 'human' ? 0 : 1, 200, 80, handle)
        : encodeMintIdentity(name, bio, mintEntityType === 'human' ? 0 : 1, 200, 80);
      await sendAndWait('Mint identity', { to: CONTRACTS.identity, data }, true);
    } finally {
      writeInFlightRef.current = false;
      setActionLabel(null);
    }
  }

  async function handleSetIdentityHandle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountReadReady) {
      announceError('Wait for a successful account read before updating identity state.');
      return;
    }
    if (account.tokenId === null) {
      announceError('Mint an identity before setting a handle.');
      return;
    }

    const handle = identityHandle.trim();
    const handleBytes = new TextEncoder().encode(handle).length;
    if (handleBytes < 3 || handleBytes > 32) {
      announceError('Handles must be between 3 and 32 bytes.');
      return;
    }
    if (!(await requireMonadWallet())) return;
    await sendAndWait('Update handle', {
      to: CONTRACTS.identity,
      data: encodeSetHandle(account.tokenId, handle),
    });
  }

  async function handleUpdateIdentityProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountReadReady || !account.profileReadReady || !profileDraftReady) {
      announceError('Wait for the complete profile read before updating your identity.');
      return;
    }
    if (account.tokenId === null) {
      announceError('Mint an identity before updating its profile.');
      return;
    }

    const name = profileName.trim();
    const bio = profileBio.trim();
    const nameBytes = utf8ByteLength(name);
    const bioBytes = utf8ByteLength(bio);
    if (!name) {
      announceError('Give your identity a name before updating its profile.');
      return;
    }
    if (nameBytes > 32 || bioBytes > 128) {
      announceError('Name must be 32 bytes or less and bio must be 128 bytes or less.');
      return;
    }
    if (account.hue === null || account.saturation === null) {
      announceError('Current profile colors are still loading from Monad. Try again shortly.');
      return;
    }
    if (!(await requireMonadWallet())) return;

    await sendAndWait('Update profile', {
      to: CONTRACTS.identity,
      data: encodeUpdateProfile(account.tokenId, name, bio, account.hue, account.saturation),
    });
  }

  async function handleCreateIdentityWallet() {
    if (!accountReadReady) {
      announceError('Wait for a successful account read before creating a smart wallet.');
      return;
    }
    if (account.tokenId === null) {
      announceError('Mint an identity before creating its smart wallet.');
      return;
    }
    if (!account.walletOfReadReady || !account.predictedWalletReadReady || account.predictedWallet === null) {
      announceError('Smart wallet address reads are not ready. Try again after Monad refreshes.');
      return;
    }
    if (account.smartWallet !== null) {
      announce('This identity already has a live smart wallet.');
      return;
    }

    const identityKey = accountIdentityKey;
    if (identityKey === null) {
      announceError('Identity state is still loading. Try again shortly.');
      return;
    }
    if (smartWalletCreatePending || smartWalletCreateKeyRef.current === identityKey) {
      announceError('Smart wallet creation is awaiting the live wallet read.');
      return;
    }

    smartWalletCreateKeyRef.current = identityKey;
    setSmartWalletCreatePending(true);
    let confirmed = false;
    try {
      if (!(await requireMonadWallet())) return;
      confirmed = await sendAndWait('Create smart wallet', {
        to: CONTRACTS.identity,
        data: encodeCreateWallet(account.tokenId),
      });
    } finally {
      const pendingTransactionWalletKey = identityKey.split(':', 1)[0];
      const unresolvedTransaction = unresolvedSubmittedTransactionsRef.current[pendingTransactionWalletKey];
      if (!confirmed && unresolvedTransaction === undefined && smartWalletCreateKeyRef.current === identityKey) {
        smartWalletCreateKeyRef.current = null;
        setSmartWalletCreatePending(false);
      }
    }
  }

  async function handleCopySmartWalletAddress() {
    if (!smartWalletAddress) {
      announceError('The smart wallet address is not available yet.');
      return;
    }

    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is not available in this browser.');
      await navigator.clipboard.writeText(smartWalletAddress);
      announce('Smart wallet address copied.');
    } catch (copyError) {
      announceError(copyError instanceof Error ? copyError.message : 'Could not copy the smart wallet address.');
    }
  }

  async function handleClaimNFTRewards() {
    if (
      !accountReadReady ||
      stats.loading ||
      stats.error !== null ||
      account.pendingNFTRewards === null ||
      stats.pendingStakingRewards === null
    ) {
      announceError('Wait for successful account and protocol reward reads before claiming identity rewards.');
      return;
    }
    if (account.pendingNFTRewards === 0n && stats.pendingStakingRewards === 0n) {
      announceError('No identity rewards are claimable or awaiting distribution.');
      return;
    }
    if (writeInFlightRef.current) {
      announceError('Another wallet action is already in progress.');
      return;
    }

    writeInFlightRef.current = true;
    setActionLabel('Preparing identity rewards');
    try {
      if (!(await requireMonadWallet())) return;

      if (stats.pendingStakingRewards > 0n) {
        const collected = await sendAndWait('Collect staking rewards', {
          to: CONTRACTS.identity,
          data: encodeCollectStakingRewards(),
        }, true);
        if (!collected) return;
      }

      await sendAndWait('Claim identity rewards', {
        to: CONTRACTS.identity,
        data: encodeClaimNFTRewards(),
      }, true);
    } finally {
      writeInFlightRef.current = false;
      setActionLabel(null);
    }
  }

  async function handleModeratorVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountReadReady || account.readStatus !== 'ready' || !moderatorAccess) {
      announceError('Moderator permission is not confirmed for this wallet.');
      return;
    }

    const tokenId = parseUnsignedInteger(moderatorTokenId);
    if (tokenId === null || tokenId === 0n) {
      announceError('Enter a token ID greater than 0.');
      return;
    }
    if (!(await requireMonadWallet())) return;

    const action = moderatorVerification === 'verified' ? 'Verify' : 'Unverify';
    await sendAndWait(`${action} identity #${tokenId.toString()}`, {
      to: CONTRACTS.identity,
      data: encodeVerify(tokenId, moderatorVerification === 'verified'),
    });
  }

  async function handleSetReputationScore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountReadReady || account.readStatus !== 'ready' || !moderatorAccess) {
      announceError('Moderator permission is not confirmed for this wallet.');
      return;
    }

    const tokenId = parseUnsignedInteger(reputationTokenId);
    if (tokenId === null || tokenId === 0n) {
      announceError('Enter a token ID greater than 0.');
      return;
    }

    const score = parseUnsignedInteger(reputationScore);
    if (score === null || score < 1n || score > 1_000_000n) {
      announceError('Reputation score must be an integer from 1 to 1,000,000.');
      return;
    }
    if (!(await requireMonadWallet())) return;

    await sendAndWait(`Set reputation #${tokenId.toString()}`, {
      to: CONTRACTS.identity,
      data: encodeSetReputationScore(tokenId, score),
    });
  }

  function readActionAmount(decimals: number, balance: bigint | null, action: string): bigint | null {
    const amount = parseUnitsInput(stakingAmount, decimals);
    if (amount === null || amount === 0n) {
      announceError(`Enter a ${action} amount first.`);
      return null;
    }
    if (balance === null) {
      announceError('Wallet balance is still loading.');
      return null;
    }
    if (amount > balance) {
      announceError(`Not enough ${stakingAsset} for this ${action}.`);
      return null;
    }
    return amount;
  }

  function guardStakingAccountRead(): boolean {
    if (!stakingReadBlocked) return true;

    announceError(
      account.readStatus === 'error'
        ? 'Staking writes are paused because the connected account read failed.'
        : 'Staking writes are paused until the connected account read is ready.',
    );
    return false;
  }

  async function handleStakeSer9(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!guardStakingAccountRead()) return;
    if (writeInFlightRef.current) {
      announceError('Another wallet action is already in progress.');
      return;
    }
    writeInFlightRef.current = true;
    setActionLabel(`Preparing ${symbol} stake`);

    try {
      if ((!wallet.address || !wallet.onMonad) && !(await requireMonadWallet())) return;
      const amount = readActionAmount(stats.ser9Decimals, account.ser9Balance, 'stake');
      if (amount === null) return;

      const approved = await sendAndWait(`Approve ${symbol} stake`, {
        to: CONTRACTS.ser9,
        data: encodeApprove(CONTRACTS.staking, amount),
      }, true);
      if (!approved) return;
      await sendAndWait(`Stake ${symbol}`, { to: CONTRACTS.staking, data: encodeStake(amount) }, true);
    } finally {
      writeInFlightRef.current = false;
      setActionLabel(null);
    }
  }

  async function handleUnstakeSer9() {
    if (!guardStakingAccountRead()) return;
    if ((!wallet.address || !wallet.onMonad) && !(await requireMonadWallet())) return;
    const amount = readActionAmount(stats.ser9Decimals, account.staked, 'unstake');
    if (amount === null) return;
    await sendAndWait(`Request ${symbol} unstake`, {
      to: CONTRACTS.staking,
      data: encodeUnstake(amount),
    });
  }

  async function handleClaimSer9Rewards() {
    if (!guardStakingAccountRead()) return;
    if (account.stakingRewards === null || account.stakingRewards === 0n) {
      announceError('No SER9 staking rewards are currently claimable.');
      return;
    }
    if (!(await requireMonadWallet())) return;
    await sendAndWait('Claim staking rewards', { to: CONTRACTS.staking, data: encodeClaimRewards() });
  }

  async function handleClaimSer9Unstaked() {
    if (!guardStakingAccountRead()) return;
    if (ser9RequestId.trim() === '' && !account.ser9LatestUnstakeRequestReady) {
      announceError('Wait for the latest SER9 unstake request to load before claiming.');
      return;
    }
    if (ser9ClaimRequestId === null) {
      announceError('Enter a valid SER9 request id, or wait for the latest request to load.');
      return;
    }
    if (!(await requireMonadWallet())) return;
    await sendAndWait(`Claim SER9 request #${ser9ClaimRequestId.toString()}`, {
      to: CONTRACTS.staking,
      data: encodeClaimUnstaked(ser9ClaimRequestId),
    });
  }

  async function handleStakeMonad(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!guardStakingAccountRead()) return;
    if (writeInFlightRef.current) {
      announceError('Another wallet action is already in progress.');
      return;
    }
    writeInFlightRef.current = true;
    setActionLabel('Preparing MON stake');

    try {
      if ((!wallet.address || !wallet.onMonad) && !(await requireMonadWallet())) return;
      const amount = readActionAmount(MONAD.nativeCurrency.decimals, spendableMonBalance, 'stake');
      if (amount === null) return;
      const request = {
        to: CONTRACTS.staking,
        data: encodeStakeMonad(),
        value: amount,
      };
      const monBalance = account.monBalance;
      if (monBalance === null) {
        announceError('MON balance is still loading.');
        return;
      }

      setActionLabel('Estimating MON staking gas');
      let fee: bigint;
      try {
        fee = await wallet.estimateTransactionFee(request);
      } catch (estimateError) {
        announceError(
          estimateError instanceof Error
            ? `Could not estimate MON staking gas: ${estimateError.message}`
            : 'Could not estimate MON staking gas.',
        );
        return;
      }
      const gasBuffer = fee / 2n + MON_NATIVE_GAS_CUSHION;
      if (monBalance < amount + fee + gasBuffer) {
        announceError(`Not enough MON for the stake amount plus estimated gas (${tokenAmount(fee + gasBuffer, MONAD.nativeCurrency.decimals)} MON).`);
        return;
      }

      await sendAndWait('Stake MON', request, true);
    } finally {
      writeInFlightRef.current = false;
      setActionLabel(null);
    }
  }

  async function handleUnstakeMonad() {
    if (!guardStakingAccountRead()) return;
    if ((!wallet.address || !wallet.onMonad) && !(await requireMonadWallet())) return;
    const amount = readActionAmount(MONAD.nativeCurrency.decimals, account.monadStaked, 'unstake');
    if (amount === null) return;
    await sendAndWait('Request MON unstake', {
      to: CONTRACTS.staking,
      data: encodeRequestUnstakeMonad(amount),
    });
  }

  async function handleClaimMonadUnstaked() {
    if (!guardStakingAccountRead()) return;
    if (monadRequestId.trim() === '' && !account.monadLatestUnstakeRequestReady) {
      announceError('Wait for the latest MON unstake request to load before claiming.');
      return;
    }
    if (monadClaimRequestId === null) {
      announceError('Enter a valid MON request id, or wait for the latest request to load.');
      return;
    }
    if (!(await requireMonadWallet())) return;
    await sendAndWait(`Claim MON request #${monadClaimRequestId.toString()}`, {
      to: CONTRACTS.staking,
      data: encodeClaimUnstakedMonad(monadClaimRequestId),
    });
  }

  function handleMaxAmount() {
    if (selectedBalance !== null) setStakingAmount(formatInputUnits(selectedBalance, selectedDecimals));
  }

  function isNavLinkActive(sectionId: SectionId): boolean {
    return page === 'home'
      ? (sectionId === 'overview' || sectionId === 'pulse') && activeSection === sectionId
      : sectionId === page;
  }

  function handleDexActionState(label: string | null) {
    setActionLabel(label);
    if (label === null) {
      const nextTransactions = readUnresolvedSubmittedTransactions();
      unresolvedSubmittedTransactionsRef.current = nextTransactions;
      setUnresolvedSubmittedTransactions(nextTransactions);
    }
  }

  return (
    <div className={`site-shell${isHomePage ? '' : ' site-shell--workspace'}`}>
      <header className="site-header">
        <div className="site-header__inner container">
          <a className="brand" href={routeHref('/', '#overview')} onClick={handleNavClick} aria-label="SERIES9 home">
                        <BrandMark />
            <span className="brand__name">SERIES9</span>
          </a>

           <nav ref={navRef} className={`primary-nav${menuOpen ? ' is-open' : ''}`} id="primary-navigation" aria-label="Primary navigation">
             {visibleNavLinks.map((link) => (
              <a
                className={isNavLinkActive(link.id) ? 'is-active' : ''}
                href={link.href}
                key={link.id}
                onClick={handleNavClick}
                aria-current={isNavLinkActive(link.id) ? 'location' : undefined}
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="site-header__actions">
            <button
              className={`network-status network-status--${networkState}`}
              type="button"
              title="View Monad network status"
              onClick={() =>
                announce(
                  stats.error
                    ? `Monad RPC unreachable: ${stats.error}`
                    : `${MONAD.name} (chain ${MONAD.id}) at block ${stats.blockNumber?.toLocaleString('en-US') ?? PENDING}.`,
                )
              }
            >
              <Icon name="cubes" size={14} />
              <span className="network-status__dot" />
              <span>Monad</span>
              <span className="network-status__number">
                {stats.blockNumber === null ? MONAD.id : Number(stats.blockNumber % 100000n).toLocaleString('en-US')}
              </span>
            </button>
            {connected && !wallet.onMonad && (
              <button className="wallet-button wallet-button--warning" type="button" disabled={wallet.connecting || wallet.switching || actionLabel !== null} onClick={handleSwitchNetwork}>
                <Icon name="bolt" size={16} />
                <span>Switch to Monad</span>
              </button>
            )}
            <button
              className={`wallet-button${connected ? ' is-connected' : ''}`}
              type="button"
              aria-pressed={connected}
              aria-busy={wallet.connecting || wallet.switching}
              disabled={wallet.connecting || wallet.switching || actionLabel !== null}
              onClick={() => void handleConnectWallet()}
            >
              <Icon name={connected ? 'check' : 'wallet'} size={16} />
              <span>
                {wallet.connecting
                  ? 'Connecting…'
                  : connected && wallet.address
                    ? shortenAddress(wallet.address)
                    : 'Connect wallet'}
              </span>
            </button>
            <button
              ref={menuToggleRef}
              className="menu-toggle"
              type="button"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              aria-controls="primary-navigation"
              onClick={() => setMenuOpen((isOpen) => !isOpen)}
            >
              <Icon name="menu" size={21} />
            </button>
          </div>
        </div>
      </header>

      <main>
        {isHomePage && (
          <>
            <section className="hero" id="overview" aria-labelledby="hero-title">
          <div className="hero__grid-overlay" aria-hidden="true" />
          <div className="container hero__inner">
            <div className="hero__copy">
              <p className="eyebrow eyebrow--gold">
                <span className="eyebrow__line" />MONAD MAINNET <span>/</span>{' '}
                {stats.blockNumber === null ? MONAD.id : `BLOCK ${stats.blockNumber.toLocaleString('en-US')}`}
              </p>
              <h1 id="hero-title">Your identity,<br /><em>in motion<span className="hero__outline-nine">9</span>.</em></h1>
              <p className="hero__lede">
                SERIES9 is the identity layer for a more personal onchain economy. Move with conviction, keep your signal.
              </p>
              <div className="hero__actions">
                {connected ? (
                  <a className="button button--gold" href="#pulse">
                    View live pulse <ButtonArrow />
                  </a>
                ) : (
                    <button className="button button--gold" type="button" disabled={wallet.connecting || wallet.switching || actionLabel !== null} onClick={() => void handleConnectWallet()}>
                    {wallet.connecting ? 'Connecting…' : 'Connect wallet'} <ButtonArrow />
                  </button>
                )}
                <a
                  className="button button--outline"
                  href={explorerAddressUrl(CONTRACTS.identity)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View contract <ButtonArrow />
                </a>
              </div>
              <div className="hero__meta">
                <span>
                  <span className={`meta-check meta-check--${networkState}`}>
                    <Icon name={networkState === 'degraded' ? 'bolt' : networkState === 'loading' ? 'orbit' : 'check'} size={13} />
                  </span>{' '}
                  {stats.error ? 'RPC unreachable' : stats.loading ? 'Reading mainnet…' : 'Live on mainnet'}
                </span>
                <span className="hero__meta-divider" />
                <span>Chain {MONAD.id} / gas {gweiFromWei(stats.gasPriceWei)}</span>
              </div>
            </div>

            <figure className="identity-stage" aria-labelledby="identity-visual-caption">
              <div className="identity-stage__ticks" aria-hidden="true">
                <span>01</span><span>09</span><span>43</span><span>∞</span>
              </div>
              <div className="orbit orbit--outer" aria-hidden="true" />
              <div className="orbit orbit--inner" aria-hidden="true" />
              <div className="identity-stage__cross identity-stage__cross--one" aria-hidden="true" />
              <div className="identity-stage__cross identity-stage__cross--two" aria-hidden="true" />
              <div className="identity-card">
                <div className="identity-card__texture" aria-hidden="true" />
                <div className="identity-card__header">
                  <span>SER9 IDENTITY</span>
                  <span className="identity-card__signal">
                    <span />{' '}
                    {account.tokenId === null ? (connected ? 'NO IDENTITY' : 'NOT CONNECTED') : account.verified ? 'VERIFIED' : 'AUTHENTIC'}
                  </span>
                </div>
                <IdentityNftArtwork imageUri={account.identityImage} alt={identityArtworkAlt} className="identity-card__monogram" />
                <div className="identity-card__name">
                  <span className="identity-card__label">ONCHAIN HANDLE</span>
                  <strong>
                    {account.tokenId === null
                      ? connected
                        ? 'unclaimed'
                        : 'connect wallet'
                      : `${account.handle || 'unnamed'} / ${account.tokenId.toString().padStart(4, '0')}`}
                  </strong>
                </div>
                <div className="identity-card__footer">
                  <span>{connected && wallet.address ? shortenAddress(wallet.address) : 'NO WALLET'}</span>
                  <span>MONAD MAINNET</span>
                  <span className="identity-card__code">
                    {account.tokenId === null ? 'S9—————' : `S9—${account.tokenId.toString().padStart(4, '0')}`}
                  </span>
                </div>
              </div>
              <div className="identity-float identity-float--top">
                <span className="identity-float__label token-label">
                  <TokenLogo token="SER9" imageUri={stats.ser9Image} />
                  <span>{symbol} BALANCE</span>
                </span>
                <strong className="token-value">
                  <span>{connected ? tokenAmount(account.ser9Balance, stats.ser9Decimals) : PENDING}</span>
                  <TokenLogo token="SER9" imageUri={stats.ser9Image} />
                </strong>
                <span className="identity-float__change token-label">
                  <TokenLogo token="MON" />
                  <span>{connected ? `${tokenAmount(account.monBalance, MONAD.nativeCurrency.decimals)} MON` : 'not connected'}</span>
                </span>
              </div>
              <div className="identity-float identity-float--bottom">
                <span className="identity-float__icon"><Icon name="lock" size={14} /></span>
                <span>
                  <strong>{account.smartWallet ? 'Smart wallet live' : 'Identity layer live'}</strong>
                  <small>
                    {account.smartWallet
                      ? shortenAddress(account.smartWallet)
                      : `Block ${stats.blockNumber?.toLocaleString('en-US') ?? PENDING}`}
                  </small>
                </span>
              </div>
              <figcaption id="identity-visual-caption">
                {account.tokenId === null
                  ? 'A portable identity, anchored to your motion.'
                  : `Identity #${account.tokenId} read live from Series9Identity on Monad.`}
              </figcaption>
            </figure>
          </div>
          <div className="hero__footer-line container"><span>scroll to enter</span><span className="hero__footer-arrow" aria-hidden="true">↓</span><span>09—∞</span></div>
            </section>

            <section className={`signal-strip signal-strip--${networkState}`} aria-label="Live protocol signals">
          <div className="container signal-strip__grid">
            <div className="signal-strip__intro"><span className="signal-strip__pulse" /> LIVE SIGNAL</div>
            <div className="signal-metric">
              <span className="token-label"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>{symbol} / SUPPLY</span></span>
              <strong>{compactAmount(stats.ser9TotalSupply, stats.ser9Decimals)}</strong>
              <small>{symbol}</small>
            </div>
            <div className="signal-metric">
              <span className="token-label"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>TOTAL STAKED</span></span>
              <strong>{compactAmount(stats.totalStaked, stats.ser9Decimals)}</strong>
              <small>{symbol}</small>
            </div>
            <div className="signal-metric">
              <span>IDENTITIES</span>
              <strong>{stats.identityCount === null ? PENDING : stats.identityCount.toLocaleString('en-US')}</strong>
              <small>minted</small>
            </div>
            <div className={`signal-metric signal-metric--status signal-metric--${networkState}`}>
              <span>NETWORK STATUS</span>
              <strong><i /> {stats.error ? 'Degraded' : stats.loading ? 'Connecting' : 'Operational'}</strong>
              <small>{stats.error ? 'RPC unreachable' : `Block ${stats.blockNumber?.toLocaleString('en-US') ?? PENDING}`}</small>
            </div>
          </div>
            </section>

            <section className="features-section" id="protocol" aria-labelledby="features-title">
          <div className="container">
            <div className="section-intro section-intro--features">
              <div>
                <p className="eyebrow"><span className="eyebrow__line eyebrow__line--ink" />THE PROTOCOL</p>
                <h2 id="features-title">One signal.<br /><em>Three ways forward.</em></h2>
              </div>
              <p className="section-intro__copy">Everything you need to be legible, aligned, and active in the next internet.</p>
            </div>
            <div className="feature-grid">
               {features.map((feature) => <FeatureCard feature={feature} key={feature.id} ser9Image={stats.ser9Image} />)}
            </div>
          </div>
            </section>
          </>
        )}

        {page === 'identity' && (
          <section className="workspace-section workspace-section--identity" aria-labelledby="identity-workspace-title">
          <div className="container">
            <div className="workspace-heading">
              <div>
                <p className="eyebrow"><span className="eyebrow__line eyebrow__line--ink" />IDENTITY WORKSPACE</p>
                <h2 id="identity-workspace-title">Make your signal<br /><em>recognizable.</em></h2>
              </div>
              <p>Read the identity you already own, or mint the root that makes every future action legible.</p>
            </div>

            {actionLabel && (
              <div className="workspace-status" role="status" aria-live="polite">
                <span className="workspace-status__pulse" />{actionLabel}
              </div>
            )}

            {renderUnresolvedTransactionBanner()}

            {connected && !wallet.onMonad && (
              <div className="workspace-banner">
                <span><strong>Wrong network.</strong> Writes are available on {MONAD.name} only.</span>
                <button className="workspace-button workspace-button--small" type="button" disabled={wallet.connecting || wallet.switching || actionLabel !== null} onClick={() => void handleSwitchNetwork()}>
                  Switch to Monad <ButtonArrow />
                </button>
              </div>
            )}

            <div className="workspace-grid workspace-grid--identity">
              <article className="workspace-panel identity-summary-panel">
                <div className="workspace-panel__header">
                  <div><span className="panel-kicker">ONCHAIN PROFILE</span><strong>Identity state</strong></div>
                  <span className="workspace-panel__tag">{connected ? 'CONNECTED' : 'READ ONLY'}</span>
                </div>

                {!connected ? (
                  <div className="workspace-empty">
                    <span className="workspace-empty__icon"><Icon name="diamond" size={23} /></span>
                    <strong>Connect to read your identity.</strong>
                    <p>The summary is resolved directly from Series9Identity on Monad. No profile data is stored here.</p>
                    <button className="workspace-button workspace-button--ink" type="button" disabled={wallet.connecting || wallet.switching || actionLabel !== null} onClick={() => void handleConnectWallet()}>
                      {wallet.connecting ? 'Connecting...' : 'Connect wallet'} <ButtonArrow />
                    </button>
                  </div>
                ) : account.loading ? (
                  <div className="workspace-empty workspace-empty--compact">
                    <span className="workspace-status__pulse" />Reading identity state from Monad...
                  </div>
                ) : account.readStatus === 'error' && account.tokenId === null ? (
                  <div className="workspace-empty workspace-empty--error">
                    <span className="workspace-empty__icon"><Icon name="bolt" size={23} /></span>
                    <strong>Identity read paused.</strong>
                    <p>{account.readError ?? 'Monad did not return a safe account read.'} Mint controls stay hidden until the read succeeds.</p>
                  </div>
                ) : account.tokenId === null ? (
                  <div className="workspace-empty">
                    <span className="workspace-empty__icon"><Icon name="orbit" size={23} /></span>
                    <strong>No identity found for this wallet.</strong>
                    <p>Your first identity will be one per address, paid in SER9 and anchored to this wallet.</p>
                    <a className="workspace-text-link" href="#identity-form">Start the mint flow <ButtonArrow /></a>
                  </div>
                ) : (
                   <div className="identity-summary">
                     {account.readError && (
                       <div className="workspace-rail-note workspace-rail-note--error">
                         <span className="meta-check meta-check--degraded"><Icon name="bolt" size={12} /></span>
                         <span>Live refresh paused. Showing the last successful identity read. {account.readError}</span>
                       </div>
                     )}
                     <div className="identity-summary__hero">
                       <IdentityNftArtwork imageUri={account.identityImage} alt={identityArtworkAlt} className="identity-summary__monogram" decorative />
                       <div>
                          <span className="panel-kicker">S9ID / TOKEN {account.tokenId.toString().padStart(4, '0')}</span>
                          <h3>{account.name || 'Unnamed identity'}</h3>
                          <p>{account.handle ? `@${account.handle}` : 'No payment handle registered'}</p>
                          <p className="identity-summary__bio">
                            <span>BIO</span>{account.bio === null ? PENDING : account.bio || 'No bio registered'}
                          </p>
                        </div>
                     </div>
                     <div className="identity-summary__preview">
                       <div className="identity-summary__preview-header">
                         <span>ONCHAIN ARTWORK</span>
                         <span>ERC-721 / 720 x 440</span>
                       </div>
                       <IdentityNftArtwork imageUri={account.identityImage} alt={identityArtworkAlt} className="identity-summary__artwork" />
                     </div>
                     <dl className="identity-summary__facts">
                      <div><dt>ENTITY</dt><dd>{identityTypeLabel(account.entityType)}</dd></div>
                      <div><dt>VERIFIED</dt><dd>{account.verified === null ? PENDING : account.verified ? 'Yes' : 'No'}</dd></div>
                      <div><dt>REPUTATION</dt><dd>{account.reputation === null ? PENDING : account.reputation.toLocaleString('en-US')}</dd></div>
                      <div><dt>TOKEN ID</dt><dd>#{account.tokenId.toString()}</dd></div>
                    </dl>
                       <div className="identity-summary__footer">
                         <div className="identity-summary__rewards">
                           <span className="panel-kicker">IDENTITY REWARDS</span>
                           <IdentityRewardBreakdown
                             pendingNFTRewards={account.pendingNFTRewards}
                             pendingStakingRewards={stats.pendingStakingRewards}
                             decimals={stats.ser9Decimals}
                             symbol={symbol}
                             ser9Image={stats.ser9Image}
                             className="identity-reward-breakdown--summary"
                           />
                         </div>
                         <button
                           className="workspace-button workspace-button--small"
                           type="button"
                           disabled={identityRewardsActionDisabled}
                           onClick={() => void handleClaimNFTRewards()}
                         >
                           {actionLabel ?? identityRewardsButtonLabel} <ButtonArrow />
                         </button>
                       </div>
                    <a className="workspace-contract-link" href={explorerAddressUrl(CONTRACTS.identity)} target="_blank" rel="noreferrer">
                      View identity contract <ButtonArrow />
                    </a>
                  </div>
                )}
              </article>

              <article className="workspace-panel identity-action-panel" id="identity-form">
                <div className="workspace-panel__header">
                  <div><span className="panel-kicker">IDENTITY CONTROL</span><strong>{account.readStatus === 'error' ? 'Read paused' : account.tokenId === null ? 'Mint your identity' : 'Manage your identity'}</strong></div>
                  <Icon name="diamond" size={19} />
                </div>

                {!connected || account.loading ? (
                  <div className="workspace-rail-note">
                    <span className="detail-dot" />Connect and wait for the account read before writing identity state.
                  </div>
                ) : account.readStatus === 'error' ? (
                  <div className="workspace-rail-note workspace-rail-note--error">
                    <span className="meta-check meta-check--degraded"><Icon name="bolt" size={12} /></span>
                    <span><strong>Account read paused.</strong> {account.readError ?? 'Monad did not return a safe account read.'} Writing controls remain disabled until the next successful refresh.</span>
                  </div>
                ) : account.tokenId === null ? (
                  <form className="workspace-form" onSubmit={(event) => void handleMintIdentity(event)}>
                    <label className="workspace-field">
                      <span>Name <i>required</i></span>
                      <input value={mintName} maxLength={32} onChange={(event) => setMintName(event.target.value)} placeholder="A name people can remember" />
                    </label>
                    <label className="workspace-field">
                      <span>Bio <i>optional</i></span>
                      <textarea value={mintBio} maxLength={128} onChange={(event) => setMintBio(event.target.value)} placeholder="A short line about your signal" rows={3} />
                    </label>
                    <label className="workspace-field">
                      <span>Payment handle <i>optional</i></span>
                      <input value={mintHandle} maxLength={32} onChange={(event) => setMintHandle(event.target.value)} placeholder="your-handle" />
                    </label>
                    <div className="workspace-field">
                      <span>Entity type</span>
                      <div className="segmented-control" role="group" aria-label="Identity entity type">
                        <button type="button" className={mintEntityType === 'human' ? 'is-selected' : ''} aria-pressed={mintEntityType === 'human'} onClick={() => setMintEntityType('human')}>Human</button>
                        <button type="button" className={mintEntityType === 'ai' ? 'is-selected' : ''} aria-pressed={mintEntityType === 'ai'} onClick={() => setMintEntityType('ai')}>AI</button>
                      </div>
                    </div>
                    <div className="workspace-fee-row">
                      <span>{mintEntityType === 'human' ? 'Human' : 'AI'} mint fee</span>
                      <strong className="token-value"><span>{tokenAmount(mintEntityType === 'human' ? stats.humanMintFee : stats.aiMintFee, stats.ser9Decimals, 2)} {symbol}</span><TokenLogo token="SER9" imageUri={stats.ser9Image} /></strong>
                    </div>
                    {mintFeeInsufficient && <p className="workspace-form__error">This wallet needs more {symbol} to cover the live mint fee.</p>}
                    <p className="workspace-form__note">SER9 approval is confirmed first, then the identity mint is submitted. Both receipts must succeed.</p>
                      <button className="workspace-button workspace-button--gold" type="submit" disabled={!accountReadReady || wallet.connecting || wallet.switching || actionLabel !== null || unresolvedSubmittedTransaction !== null || mintFeeInsufficient}>
                      {actionLabel ? actionLabel : 'Approve & mint identity'} <ButtonArrow />
                    </button>
                  </form>
                ) : !account.profileReadReady ? (
                  <div className="workspace-rail-note workspace-rail-note--error">
                    <span className="meta-check meta-check--degraded"><Icon name="bolt" size={12} /></span>
                    <span><strong>Profile read paused.</strong> The complete `profiles()` tuple is not available yet. Writing stays disabled until it is read in full.</span>
                  </div>
                ) : (
                   <>
                   <div className="workspace-form">
                     <div className="workspace-rail-note workspace-rail-note--positive"><span className="meta-check"><Icon name="check" size={12} /></span> Identity #{account.tokenId.toString()} is owned by this wallet.</div>
                   </div>
                   <form className="workspace-form workspace-form--profile" onSubmit={(event) => void handleUpdateIdentityProfile(event)}>
                     <div className="workspace-form__intro">
                       <span className="panel-kicker">ONCHAIN PROFILE</span>
                       <strong>Update profile</strong>
                     </div>
                     <label className="workspace-field">
                       <span>Name <i className={utf8ByteLength(profileName) > 32 ? 'is-invalid' : undefined}>{utf8ByteLength(profileName)} / 32 bytes</i></span>
                       <input value={profileName} maxLength={32} onChange={(event) => setProfileName(event.target.value)} placeholder="A name people can remember" />
                     </label>
                     <label className="workspace-field">
                       <span>Bio <i className={utf8ByteLength(profileBio) > 128 ? 'is-invalid' : undefined}>{utf8ByteLength(profileBio)} / 128 bytes</i></span>
                       <textarea value={profileBio} maxLength={128} onChange={(event) => setProfileBio(event.target.value)} placeholder="A short line about your signal" rows={4} />
                     </label>
                     <p className="workspace-form__note">Name and BIO are written onchain. Current hue and saturation are preserved from the profile read; nothing is saved locally.</p>
                      <button className="workspace-button workspace-button--gold" type="submit" disabled={!profileDraftReady || !profileName.trim() || utf8ByteLength(profileName) > 32 || utf8ByteLength(profileBio) > 128 || wallet.connecting || wallet.switching || actionLabel !== null || unresolvedSubmittedTransaction !== null || account.hue === null || account.saturation === null}>
                       {actionLabel ?? 'Update profile'} <ButtonArrow />
                     </button>
                   </form>
                   <form className="workspace-inline-form" onSubmit={(event) => void handleSetIdentityHandle(event)}>
                       <label className="workspace-field">
                         <span>Update payment handle</span>
                         <input value={identityHandle} maxLength={32} onChange={(event) => setIdentityHandle(event.target.value)} placeholder={account.handle || 'new-handle'} />
                       </label>
                          <button className="workspace-button workspace-button--ink" type="submit" disabled={!accountReadReady || wallet.connecting || wallet.switching || actionLabel !== null || unresolvedSubmittedTransaction !== null}>Set handle <ButtonArrow /></button>
                     </form>
                       <div className="workspace-action-row workspace-action-row--muted">
                         <div className="identity-reward-action">
                           <span className="panel-kicker">REPUTATION REWARDS</span>
                           <strong>Collect and claim NFT rewards</strong>
                           <IdentityRewardBreakdown
                             pendingNFTRewards={account.pendingNFTRewards}
                             pendingStakingRewards={stats.pendingStakingRewards}
                             decimals={stats.ser9Decimals}
                             symbol={symbol}
                             ser9Image={stats.ser9Image}
                             className="identity-reward-breakdown--action"
                           />
                           <p>Awaiting distribution is collected before the identity claim.</p>
                         </div>
                         <button className="workspace-button workspace-button--outline" type="button" disabled={identityRewardsActionDisabled} onClick={() => void handleClaimNFTRewards()}>
                           {actionLabel ?? identityRewardsButtonLabel} <ButtonArrow />
                         </button>
                      </div>
                   </>
                 )}
               </article>

               <article className="workspace-panel smart-wallet-panel">
                 <div className="workspace-panel__header">
                   <div><span className="panel-kicker">IDENTITY SMART WALLET</span><strong>Keep control close.</strong></div>
                   <Icon name="wallet" size={19} />
                 </div>

                 {!connected ? (
                   <div className="workspace-empty workspace-empty--compact">
                     <span className="workspace-status__pulse" />Connect a wallet to read the identity wallet state.
                   </div>
                  ) : account.loading ? (
                    <div className="workspace-empty workspace-empty--compact">
                      <span className="workspace-status__pulse" />Reading the deterministic wallet address from Monad...
                    </div>
                  ) : account.readStatus === 'error' ? (
                    <div className="workspace-empty workspace-empty--compact workspace-empty--error">
                      <span className="workspace-status__pulse" /><span>Smart wallet reads paused. {account.readError ?? 'Monad did not return safe wallet state.'}</span>
                    </div>
                  ) : account.tokenId === null ? (
                    <div className="workspace-empty workspace-empty--compact">
                      <span className="workspace-status__pulse" />Mint an identity before managing its smart wallet.
                    </div>
                  ) : (
                    <div className="smart-wallet-panel__body">
                      <div className={`smart-wallet-state${smartWalletLive ? ' smart-wallet-state--deployed' : ''}`} role="status" aria-live="polite">
                        <span className="smart-wallet-state__icon"><Icon name={smartWalletLive ? 'check' : 'orbit'} size={18} /></span>
                        <div>
                          <span className="panel-kicker">{smartWalletLive ? 'DEPLOYED' : smartWalletPredictionAvailable ? 'PREDICTED' : 'UNAVAILABLE'}</span>
                          <strong>{smartWalletLive ? 'Smart wallet is live.' : smartWalletPredictionAvailable ? 'Ready to deploy.' : 'Address read unavailable.'}</strong>
                          <p>{smartWalletLive ? 'The wallet is deployed at the deterministic address for this identity.' : smartWalletPredictionAvailable ? smartWalletCreatePending ? unresolvedSubmittedTransaction ? 'The submitted transaction status is uncertain. Verify it before acknowledging the workspace warning.' : 'Creation confirmed. Waiting for the live wallet read before allowing another transaction.' : 'Create the wallet when you are ready; deployment is permissionless.' : 'Both wallet reads must complete before deployment can be offered.'}</p>
                        </div>
                      </div>

                     <div className="smart-wallet-address">
                       <span className="panel-kicker">FULL SMART WALLET ADDRESS</span>
                       <code>{smartWalletAddress ?? 'Wallet factory read unavailable'}</code>
                     </div>

                      <div className="smart-wallet-actions">
                       <button className="workspace-button workspace-button--outline" type="button" aria-label="Copy smart wallet address" disabled={!smartWalletAddress || !smartWalletReadsAvailable || account.loading} onClick={() => void handleCopySmartWalletAddress()}>
                         <Icon name="copy" size={15} /> Copy address
                       </button>
                       {smartWalletAddress && (
                         <a className="workspace-button workspace-button--outline" href={explorerAddressUrl(smartWalletAddress)} target="_blank" rel="noreferrer">
                           Open explorer <ButtonArrow />
                         </a>
                       )}
                     </div>

                     <p className="smart-wallet-panel__note"><Icon name="lock" size={15} /><span><strong>NFT ownership controls this smart wallet.</strong> This workspace only reads its state and deploys the deterministic wallet. Arbitrary execute controls are not exposed.</span></p>

                     {!smartWalletLive && smartWalletReadsAvailable && smartWalletPredictionAvailable && (
                        <button className="workspace-button workspace-button--gold smart-wallet-panel__create" type="button" disabled={smartWalletCreatePending || wallet.connecting || wallet.switching || actionLabel !== null || unresolvedSubmittedTransaction !== null} onClick={() => void handleCreateIdentityWallet()}>
                         {smartWalletCreatePending ? 'Waiting for live read' : 'Create smart wallet'} <ButtonArrow />
                       </button>
                     )}
                   </div>
                 )}
               </article>
             </div>
          </div>
          </section>
        )}

          {page === 'tokenomics' && (
            <section className="workspace-section workspace-section--tokenomics" aria-labelledby="tokenomics-workspace-title">
              <div className="container">
                <div className="workspace-heading">
                  <div>
                    <p className="eyebrow"><span className="eyebrow__line eyebrow__line--ink" />TOKENOMICS</p>
                    <h2 id="tokenomics-workspace-title">Follow the value<br /><em>through the loop.</em></h2>
                  </div>
                  <p>Live protocol readings for supply, staking, identity economics, and the reward path that turns shared activity into a claim.</p>
                </div>

                {stats.error && (
                  <div className="workspace-banner" role="status">
                    <span><strong>Protocol refresh unavailable.</strong> Values shown are the last successful readings; fresh data is unavailable. {stats.error}</span>
                  </div>
                )}

                <div className="tokenomics-grid">
                  <article className="workspace-panel tokenomics-supply-panel">
                    <div className="workspace-panel__header">
                      <div><span className="panel-kicker">SER9 SUPPLY MAP</span><strong>Where the token sits</strong></div>
                      <TokenLogo token="SER9" imageUri={stats.ser9Image} size="medium" standalone />
                    </div>
                    <div className="tokenomics-supply-panel__body">
                      <div className="tokenomics-primary-stat">
                        <span className="tokenomics-metric__label">TOTAL SER9 SUPPLY</span>
                        <strong className="token-value">
                          <span>{tokenAmount(stats.ser9TotalSupply, stats.ser9Decimals)} {symbol}</span>
                          <TokenLogo token="SER9" imageUri={stats.ser9Image} size="medium" />
                        </strong>
                      </div>
                      <div className="tokenomics-progress-block">
                        <div className="tokenomics-progress-block__header">
                          <span>STAKING RATIO</span>
                          <strong>{stakingRatioLabel}</strong>
                        </div>
                        <div
                          className="tokenomics-progress"
                          role="progressbar"
                          aria-label="SER9 staking ratio"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={stakingProgress ?? undefined}
                        >
                          <span style={stakingProgress === null ? undefined : { width: `${stakingProgress}%` }} />
                        </div>
                        <div className="tokenomics-progress-block__legend">
                          <span className="token-label"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>STAKED {tokenAmount(stats.totalStaked, stats.ser9Decimals)} {symbol}</span></span>
                          <span className="token-label"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>LIQUID {tokenAmount(liquidSer9, stats.ser9Decimals)} {symbol}</span></span>
                        </div>
                      </div>
                    </div>
                  </article>

                  <article className="workspace-panel tokenomics-flow-panel">
                    <div className="workspace-panel__header">
                      <div><span className="panel-kicker">REWARD FLOW</span><strong>Collect. Distribute. Claim.</strong></div>
                      <Icon name="orbit" size={19} />
                    </div>
                    <div className="tokenomics-flow-panel__body">
                      <div className="tokenomics-flow">
                        <div className="tokenomics-flow__step">
                          <span>01 / COLLECT</span>
                          <strong>Pull from staking</strong>
                          <p>A permissionless `collectStakingRewards()` call moves pending SER9 into the identity reward path.</p>
                        </div>
                        <div className="tokenomics-flow__step">
                          <span>02 / DISTRIBUTE</span>
                          <strong>Make rewards attributable</strong>
                          <p>The identity contract accounts for the collected SER9 before an identity can claim it.</p>
                        </div>
                        <div className="tokenomics-flow__step">
                          <span>03 / CLAIM</span>
                          <strong>Claim your identity share</strong>
                          <p>Identity owners claim the amount shown as Claimable now in the identity workspace.</p>
                        </div>
                      </div>
                      <a className="workspace-button workspace-button--gold tokenomics-flow-panel__link" href={routeHref('/identity')} onClick={handleNavClick}>
                        Open identity workspace <ButtonArrow />
                      </a>
                    </div>
                  </article>
                </div>

                <div className="tokenomics-metrics" aria-label="Live tokenomics readings">
                  <TokenomicsMetric
                    label="TOTAL IDENTITIES"
                    value={stats.identityCount === null ? PENDING : stats.identityCount.toLocaleString('en-US')}
                    note="minted identity tokens"
                  />
                  <TokenomicsMetric
                    label="WALLETS DEPLOYED"
                    value={stats.walletCount === null ? PENDING : stats.walletCount.toLocaleString('en-US')}
                    note="identity smart wallets"
                  />
                  <TokenomicsMetric
                    label="HUMAN MINT FEE"
                    value={tokenAmount(stats.humanMintFee, stats.ser9Decimals)}
                    note={`${symbol} per identity mint`}
                    token="SER9"
                    imageUri={stats.ser9Image}
                  />
                  <TokenomicsMetric
                    label="AI MINT FEE"
                    value={tokenAmount(stats.aiMintFee, stats.ser9Decimals)}
                    note={`${symbol} per identity mint`}
                    token="SER9"
                    imageUri={stats.ser9Image}
                  />
                  <TokenomicsMetric
                    label="SER9 REWARD RATE / BLOCK"
                    value={tokenAmount(stats.rewardRatePerBlock, stats.ser9Decimals, 4)}
                    note="staking emission"
                    token="SER9"
                    imageUri={stats.ser9Image}
                  />
                  <TokenomicsMetric
                    label="MON STAKING REWARD RATE / BLOCK"
                    value={tokenAmount(stats.monadRewardRatePerBlock, stats.ser9Decimals, 4)}
                    note="SER9 emission for MON staking"
                    token="SER9"
                    imageUri={stats.ser9Image}
                  />
                  <TokenomicsMetric
                    label="NFT REWARDS AWAITING DISTRIBUTION"
                    value={tokenAmount(stats.pendingStakingRewards, stats.ser9Decimals)}
                    note="SER9 still in the staking contract"
                    token="SER9"
                    imageUri={stats.ser9Image}
                  />
                </div>
              </div>
            </section>
          )}

          {page === 'dex' && <DexPage wallet={wallet} onNotify={announce} onActionState={handleDexActionState} />}

          {page === 'staking' && (
           <section className="workspace-section workspace-section--staking" aria-labelledby="staking-workspace-title">
          <div className="container">
            <div className="workspace-heading">
              <div>
                <p className="eyebrow"><span className="eyebrow__line eyebrow__line--ink" />STAKING WORKSPACE</p>
                <h2 id="staking-workspace-title">Put conviction<br /><em>to work.</em></h2>
              </div>
              <p>Two assets, one position view. Every write is a real wallet transaction and every unstake waits for its protocol epoch.</p>
            </div>

            {actionLabel && (
              <div className="workspace-status" role="status" aria-live="polite">
                <span className="workspace-status__pulse" />{actionLabel}
              </div>
            )}

            {renderUnresolvedTransactionBanner()}

            {stakingReadBlocked && (
              <div className="workspace-banner" role="status">
                <span><strong>Staking writes paused.</strong> {account.readStatus === 'error' ? 'The connected account read failed.' : 'Balances and unstake requests are still loading.'} Writes resume after a fresh account read.</span>
              </div>
            )}

            <div className="workspace-grid workspace-grid--staking">
              <article className="workspace-panel position-panel">
                <div className="workspace-panel__header">
                  <div><span className="panel-kicker">LIVE POSITION</span><strong>Your conviction</strong></div>
                  <span className="workspace-panel__tag">
                    {connected
                      ? `MONAD / ${stats.blockNumber === null ? 'SYNC' : (stats.blockNumber % 1000n).toString().padStart(3, '0')}`
                      : 'CONNECT WALLET'}
                  </span>
                </div>
                <div className="position-grid">
                   <div className="position-cell position-cell--gold"><span className="position-cell__label token-label"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>{symbol} BALANCE</span></span><strong>{tokenAmount(account.ser9Balance, stats.ser9Decimals)}</strong><small>{symbol}</small></div>
                   <div className="position-cell"><span className="position-cell__label token-label"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>{symbol} STAKED</span></span><strong>{tokenAmount(account.staked, stats.ser9Decimals)}</strong><small>{symbol}</small></div>
                   <div className="position-cell"><span className="position-cell__label token-label"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>STAKING EARNED</span></span><strong>{tokenAmount(account.stakingRewards, stats.ser9Decimals)}</strong><small>{symbol} claimable</small></div>
                   <div className="position-cell position-cell--sand"><span className="position-cell__label token-label"><TokenLogo token="MON" /><span>MON BALANCE</span></span><strong>{tokenAmount(account.monBalance, MONAD.nativeCurrency.decimals)}</strong><small>MON</small></div>
                   <div className="position-cell"><span className="position-cell__label token-label"><TokenLogo token="MON" /><span>MON STAKED</span></span><strong>{tokenAmount(account.monadStaked, MONAD.nativeCurrency.decimals)}</strong><small>MON</small></div>
                   <div className="position-cell"><span className="position-cell__label token-label"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>MON EARNED</span></span><strong>{tokenAmount(account.monadRewards, stats.ser9Decimals)}</strong><small>{symbol} reward</small></div>
                </div>
                <div className="position-context">
                   <div><span className="position-context__label token-label"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>PROTOCOL TOTAL / {symbol}</span></span><strong>{tokenAmount(stats.totalStaked, stats.ser9Decimals)} {symbol}</strong></div>
                   <div><span className="position-context__label token-label"><TokenLogo token="MON" /><span>PROTOCOL TOTAL / MON</span></span><strong>{tokenAmount(stats.totalMonadStaked, MONAD.nativeCurrency.decimals)} MON</strong></div>
                   <div><span className="position-context__label token-label"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>REWARD RATE / BLOCK</span></span><strong>{tokenAmount(stats.rewardRatePerBlock, stats.ser9Decimals, 4)} {symbol}</strong></div>
                   <div><span className="position-context__label token-label"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>MON REWARD RATE / BLOCK</span></span><strong>{tokenAmount(stats.monadRewardRatePerBlock, stats.ser9Decimals, 4)} {symbol}</strong></div>
                </div>
                <a className="workspace-contract-link" href={explorerAddressUrl(CONTRACTS.staking)} target="_blank" rel="noreferrer">
                  View staking contract <ButtonArrow />
                </a>
              </article>

              <article className="workspace-panel staking-action-panel">
                <div className="workspace-panel__header">
                  <div><span className="panel-kicker">POSITION CONTROL</span><strong>Move your position</strong></div>
                  <span className="workspace-panel__tag">{stakingAsset}</span>
                </div>
                <div className="asset-tabs" role="tablist" aria-label="Staking asset">
                   <button type="button" role="tab" aria-selected={stakingAsset === 'SER9'} className={stakingAsset === 'SER9' ? 'is-selected' : ''} onClick={() => setStakingAsset('SER9')}><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>SER9</span></button>
                   <button type="button" role="tab" aria-selected={stakingAsset === 'MON'} className={stakingAsset === 'MON' ? 'is-selected' : ''} onClick={() => setStakingAsset('MON')}><TokenLogo token="MON" /><span>MON / native</span></button>
                </div>

                {stakingAsset === 'SER9' ? (
                  <div className="staking-tab-panel" role="tabpanel">
                     <form className="workspace-form" onSubmit={(event) => void handleStakeSer9(event)}>
                       <label className="workspace-field workspace-field--amount">
                         <span>
                           Amount to move
                           <i className="token-label">
                             <span>available {tokenAmount(account.ser9Balance, stats.ser9Decimals)} {symbol}</span>
                             <TokenLogo token="SER9" imageUri={stats.ser9Image} />
                           </i>
                         </span>
                           <div className="amount-input-wrap"><input ref={stakingAmountInputRef} inputMode="decimal" value={stakingAmount} onChange={handleStakingAmountChange} placeholder="0.00" /><span className="amount-input-wrap__token token-label"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>{symbol}</span></span><button type="button" onClick={handleMaxAmount}>MAX</button></div>
                       </label>
                       <div className="workspace-action-grid">
                           <button className="workspace-button workspace-button--gold" type="submit" disabled={stakingReadBlocked || wallet.connecting || wallet.switching || actionLabel !== null || unresolvedSubmittedTransaction !== null || !canStakeSelected}>Approve & stake <ButtonArrow /></button>
                           <button className="workspace-button workspace-button--ink" type="button" disabled={stakingReadBlocked || wallet.connecting || wallet.switching || actionLabel !== null || unresolvedSubmittedTransaction !== null || !canUnstakeSelected} onClick={() => void handleUnstakeSer9()}>Request unstake <ButtonArrow /></button>
                       </div>
                    </form>
                    <div className="unstake-note"><span className="workspace-row-icon"><Icon name="lock" size={15} /></span><span><strong>Epoch delayed</strong><small>Unstake creates a request first. SER9 becomes claimable after the protocol delay.</small></span></div>
                     <div className="request-control">
                       <div><span className="panel-kicker">SER9 REQUESTS</span><small>{account.ser9UnstakeRequestCount === null ? 'Reading request count...' : `${account.ser9UnstakeRequestCount.toString()} request${account.ser9UnstakeRequestCount === 1n ? '' : 's'}`}</small></div>
                          <div className="request-control__form"><input inputMode="numeric" value={ser9RequestId} onChange={(event) => setSer9RequestId(event.target.value)} placeholder={account.ser9LatestUnstakeRequestId === null ? 'request id' : `latest ${account.ser9LatestUnstakeRequestId.toString()}`} aria-label="SER9 unstake request id" /><button className="workspace-button workspace-button--small" type="button" disabled={stakingReadBlocked || wallet.connecting || wallet.switching || actionLabel !== null || unresolvedSubmittedTransaction !== null || ser9ClaimRequestId === null || (ser9RequestId.trim() === '' && !account.ser9LatestUnstakeRequestReady)} onClick={() => void handleClaimSer9Unstaked()}>Claim <ButtonArrow /></button></div>
                       {account.ser9LatestUnstakeRequest && (
                         <small className="request-control__detail">
                           <span className="token-value">
                             <span>Latest amount {tokenAmount(account.ser9LatestUnstakeRequest.amount, stats.ser9Decimals)} {symbol}</span>
                             <TokenLogo token="SER9" imageUri={stats.ser9Image} />
                           </span>
                           <span>/ {unstakeRequestState(account.ser9LatestUnstakeRequest)}</span>
                         </small>
                       )}
                       <small className="request-control__hint">Blank uses the latest request. It must have passed its minimum claim epoch.</small>
                     </div>
                        <button className="workspace-button workspace-button--outline workspace-button--full" type="button" disabled={stakingReadBlocked || wallet.connecting || wallet.switching || actionLabel !== null || unresolvedSubmittedTransaction !== null || account.stakingRewards === null || account.stakingRewards === 0n} onClick={() => void handleClaimSer9Rewards()}>Claim earned rewards <span className="token-value"><span>{tokenAmount(account.stakingRewards, stats.ser9Decimals)} {symbol}</span><TokenLogo token="SER9" imageUri={stats.ser9Image} /></span> <ButtonArrow /></button>
                  </div>
                ) : (
                  <div className="staking-tab-panel" role="tabpanel">
                     <form className="workspace-form" onSubmit={(event) => void handleStakeMonad(event)}>
                       <label className="workspace-field workspace-field--amount">
                         <span>
                           Amount to move
                           <i className="token-label">
                             <span>available {tokenAmount(spendableMonBalance, MONAD.nativeCurrency.decimals)} MON ({isMonGasReserveEstimated ? 'estimated' : 'fallback'} {tokenAmount(activeMonGasReserve, MONAD.nativeCurrency.decimals)} MON gas reserve)</span>
                             <TokenLogo token="MON" />
                           </i>
                         </span>
                           <div className="amount-input-wrap"><input ref={stakingAmountInputRef} inputMode="decimal" value={stakingAmount} onChange={handleStakingAmountChange} placeholder="0.00" /><span className="amount-input-wrap__token token-label"><TokenLogo token="MON" /><span>MON</span></span><button type="button" onClick={handleMaxAmount}>MAX</button></div>
                       </label>
                       <div className="workspace-action-grid">
                           <button className="workspace-button workspace-button--gold" type="submit" disabled={stakingReadBlocked || wallet.connecting || wallet.switching || actionLabel !== null || unresolvedSubmittedTransaction !== null || !canStakeSelected}>Stake MON <ButtonArrow /></button>
                           <button className="workspace-button workspace-button--ink" type="button" disabled={stakingReadBlocked || wallet.connecting || wallet.switching || actionLabel !== null || unresolvedSubmittedTransaction !== null || !canUnstakeSelected} onClick={() => void handleUnstakeMonad()}>Request unstake <ButtonArrow /></button>
                       </div>
                    </form>
                    <div className="unstake-note"><span className="workspace-row-icon"><Icon name="lock" size={15} /></span><span><strong>Native MON, epoch covered</strong><small>MON is delegated through Monad staking. Coverage and the epoch delay must clear before a claim can settle.</small></span></div>
                     <div className="request-control">
                       <div><span className="panel-kicker">MON REQUESTS</span><small>{account.monadUnstakeRequestCount === null ? 'Reading request count...' : `${account.monadUnstakeRequestCount.toString()} request${account.monadUnstakeRequestCount === 1n ? '' : 's'}`}</small></div>
                          <div className="request-control__form"><input inputMode="numeric" value={monadRequestId} onChange={(event) => setMonadRequestId(event.target.value)} placeholder={account.monadLatestUnstakeRequestId === null ? 'request id' : `latest ${account.monadLatestUnstakeRequestId.toString()}`} aria-label="MON unstake request id" /><button className="workspace-button workspace-button--small" type="button" disabled={stakingReadBlocked || wallet.connecting || wallet.switching || actionLabel !== null || unresolvedSubmittedTransaction !== null || monadClaimRequestId === null || (monadRequestId.trim() === '' && !account.monadLatestUnstakeRequestReady)} onClick={() => void handleClaimMonadUnstaked()}>Claim <ButtonArrow /></button></div>
                       {account.monadLatestUnstakeRequest && (
                         <small className="request-control__detail">
                           <span className="token-value">
                             <span>Latest amount {tokenAmount(account.monadLatestUnstakeRequest.amount, MONAD.nativeCurrency.decimals)} MON</span>
                             <TokenLogo token="MON" />
                           </span>
                           <span>/ {unstakeRequestState(account.monadLatestUnstakeRequest)}</span>
                         </small>
                       )}
                      <small className="request-control__hint">Blank uses the latest request. The protocol must have covered its undelegation.</small>
                    </div>
                    <div className="workspace-rail-note">MON staking sends native value with the `stakeMonad()` call. Gas reserve is estimated when the wallet allows it; otherwise a conservative fallback is used.</div>
                  </div>
                )}
              </article>
            </div>
          </div>
           </section>
         )}

         {page === 'moderator' && (
           <section className="workspace-section workspace-section--moderator" aria-labelledby="moderator-workspace-title">
           <div className="container">
             <div className="workspace-heading">
               <div>
                 <p className="eyebrow"><span className="eyebrow__line eyebrow__line--ink" />MODERATOR WORKSPACE</p>
                 <h2 id="moderator-workspace-title">Keep the signal<br /><em>credible.</em></h2>
               </div>
               <p>Identity moderation is deliberately narrow: confirm an identity and tune its reputation signal, with every change signed on Monad.</p>
             </div>

              {actionLabel && (
                <div className="workspace-status" role="status" aria-live="polite">
                  <span className="workspace-status__pulse" />{actionLabel}
                </div>
              )}

              {renderUnresolvedTransactionBanner()}

              {connected && !wallet.onMonad && (
               <div className="workspace-banner">
                 <span><strong>Wrong network.</strong> Moderator writes are available on {MONAD.name} only.</span>
                 <button className="workspace-button workspace-button--small" type="button" disabled={wallet.connecting || wallet.switching || actionLabel !== null} onClick={() => void handleSwitchNetwork()}>
                   Switch to Monad <ButtonArrow />
                 </button>
               </div>
             )}

             <div className="moderator-grid moderator-grid--access">
               <article className="workspace-panel moderator-panel moderator-access-panel">
                 <div className="workspace-panel__header">
                   <div><span className="panel-kicker">IDENTITY AUTHORITY</span><strong>Permission checkpoint</strong></div>
                   <span className={`workspace-panel__tag moderator-tag--${moderatorAccessState}`}>{moderatorPermissionLabel}</span>
                 </div>
                 <div className="moderator-access-panel__body">
                    <div
                      className={`moderator-access-state moderator-access-state--${moderatorAccessState}`}
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                     <span className="moderator-access-state__icon">
                       <Icon name={moderatorAccessState === 'authorized' ? 'check' : moderatorAccessState === 'loading' ? 'orbit' : 'lock'} size={20} />
                     </span>
                     <div>
                       <span className="panel-kicker">PERMISSION CHECK</span>
                       <strong>{moderatorPermissionLabel}</strong>
                       <p>
                          {moderatorAccessState === 'authorized'
                            ? 'Permission confirmed. The moderator write forms are now available below.'
                           : moderatorAccessState === 'loading'
                             ? 'Reading owner() and moderators(address) from Series9Identity.'
                             : moderatorAccessState === 'disconnected'
                               ? 'Connect a wallet to verify its Identity role on Monad.'
                               : moderatorAccessState === 'unavailable'
                                 ? 'The role read did not return a safe answer. No moderator controls are available.'
                                 : 'This wallet is not the Identity owner or an assigned moderator.'}
                       </p>
                     </div>
                   </div>
                   <dl className="moderator-facts">
                     <div><dt>ROLE</dt><dd>{moderatorRole}</dd></div>
                     <div><dt>CONNECTED ADDRESS</dt><dd className="moderator-facts__address">{wallet.address ?? 'Wallet not connected'}</dd></div>
                     <div><dt>IDENTITY CONTRACT</dt><dd>{shortenAddress(CONTRACTS.identity)}</dd></div>
                   </dl>
                   <div className="moderator-access-panel__footer">
                     <a className="workspace-contract-link" href={explorerAddressUrl(CONTRACTS.identity)} target="_blank" rel="noreferrer">
                       View Identity contract <ButtonArrow />
                     </a>
                     {!connected && (
                         <button className="workspace-button workspace-button--ink" type="button" disabled={wallet.connecting || wallet.switching || actionLabel !== null} onClick={() => void handleConnectWallet()}>
                         {wallet.connecting ? 'Connecting...' : 'Connect wallet'} <ButtonArrow />
                       </button>
                     )}
                     {connected && !wallet.onMonad && (
                        <button className="workspace-button workspace-button--outline" type="button" disabled={wallet.connecting || wallet.switching || actionLabel !== null} onClick={() => void handleSwitchNetwork()}>
                         Switch network <ButtonArrow />
                       </button>
                     )}
                   </div>
                 </div>
               </article>

               <article className="workspace-panel moderator-panel moderator-scope-panel">
                 <div className="workspace-panel__header">
                   <div><span className="panel-kicker">AUTHORITY SURFACE</span><strong>Two writes only</strong></div>
                   <Icon name="lock" size={19} />
                 </div>
                 <div className="moderator-scope">
                   <div className="moderator-scope__item">
                     <span className="moderator-scope__number">01 / VERIFY</span>
                     <strong>Identity status</strong>
                     <p>Set an identity token's verification flag without touching ownership or mint configuration.</p>
                   </div>
                   <div className="moderator-scope__item">
                     <span className="moderator-scope__number">02 / REPUTATION</span>
                     <strong>Reputation score</strong>
                     <p>Set a token score from 1 to 1,000,000. The value remains an onchain protocol signal.</p>
                   </div>
                   <div className="moderator-scope__note"><span className="detail-dot" />Owner administration, fees, pauses, and moderator assignment are not exposed here.</div>
                 </div>
               </article>
             </div>

             {moderatorAccess ? (
               <div className="moderator-grid moderator-grid--controls">
                 <article className="workspace-panel moderator-panel moderator-control-panel">
                   <div className="workspace-panel__header">
                     <div><span className="panel-kicker">MODERATOR WRITE / 01</span><strong>Verify an identity</strong></div>
                     <span className="workspace-panel__tag">VERIFY</span>
                   </div>
                   <form className="workspace-form moderator-form" onSubmit={(event) => void handleModeratorVerification(event)}>
                     <label className="workspace-field">
                       <span>Token ID <i>uint256</i></span>
                       <input inputMode="numeric" value={moderatorTokenId} onChange={(event) => setModeratorTokenId(event.target.value)} placeholder="e.g. 42" aria-label="Token ID for verification" />
                     </label>
                     <div className="workspace-field">
                       <span>Verification status <i>moderator write</i></span>
                       <div className="segmented-control moderator-status-control" role="group" aria-label="Verification status">
                         <button type="button" className={moderatorVerification === 'verified' ? 'is-selected' : ''} aria-pressed={moderatorVerification === 'verified'} onClick={() => setModeratorVerification('verified')}>Verify</button>
                         <button type="button" className={moderatorVerification === 'unverified' ? 'is-selected' : ''} aria-pressed={moderatorVerification === 'unverified'} onClick={() => setModeratorVerification('unverified')}>Unverify</button>
                       </div>
                     </div>
                     <p className="workspace-form__note">Calls <code>verify(tokenId, status)</code> on Series9Identity. This does not change ownership.</p>
                      <button className="workspace-button workspace-button--gold" type="submit" disabled={wallet.connecting || wallet.switching || actionLabel !== null || unresolvedSubmittedTransaction !== null}>
                       {actionLabel ?? `${moderatorVerification === 'verified' ? 'Verify' : 'Unverify'} identity`} <ButtonArrow />
                     </button>
                   </form>
                 </article>

                 <article className="workspace-panel moderator-panel moderator-control-panel">
                   <div className="workspace-panel__header">
                     <div><span className="panel-kicker">MODERATOR WRITE / 02</span><strong>Set reputation</strong></div>
                     <span className="workspace-panel__tag">1 — 1M</span>
                   </div>
                   <form className="workspace-form moderator-form" onSubmit={(event) => void handleSetReputationScore(event)}>
                     <label className="workspace-field">
                       <span>Token ID <i>uint256</i></span>
                       <input inputMode="numeric" value={reputationTokenId} onChange={(event) => setReputationTokenId(event.target.value)} placeholder="e.g. 42" aria-label="Token ID for reputation" />
                     </label>
                     <label className="workspace-field">
                       <span>Reputation score <i>1 — 1,000,000</i></span>
                       <input inputMode="numeric" value={reputationScore} onChange={(event) => setReputationScore(event.target.value)} placeholder="e.g. 750,000" aria-label="Reputation score" min="1" max="1000000" />
                     </label>
                     <p className="workspace-form__note">Scores are checked in the browser before <code>setReputationScore(tokenId, newScore)</code> is signed.</p>
                       <button className="workspace-button workspace-button--ink" type="submit" disabled={wallet.connecting || wallet.switching || actionLabel !== null || unresolvedSubmittedTransaction !== null}>
                       {actionLabel ?? 'Set reputation score'} <ButtonArrow />
                     </button>
                   </form>
                 </article>
               </div>
             ) : (
                <div className={`moderator-locked moderator-locked--${moderatorAccessState}`}>
                 <span className="moderator-locked__icon">
                   <Icon name={moderatorAccessState === 'loading' ? 'orbit' : 'lock'} size={21} />
                 </span>
                 <div>
                   <span className="panel-kicker">ACCESS GATE</span>
                   <strong>
                     {moderatorAccessState === 'disconnected'
                       ? 'Connect to check moderator access.'
                       : moderatorAccessState === 'loading'
                         ? 'Checking moderator access on Monad.'
                         : moderatorAccessState === 'unavailable'
                           ? 'Moderator controls are paused until the role can be verified.'
                           : 'This wallet cannot access moderator controls.'}
                   </strong>
                   <p>
                     {moderatorAccessState === 'disconnected'
                       ? 'Only the connected wallet address can unlock this workspace.'
                       : moderatorAccessState === 'loading'
                         ? 'The write forms will appear only after owner() and moderators(address) return a confirmed result.'
                         : moderatorAccessState === 'unavailable'
                           ? 'Try again when the Identity permission read is available. No transaction UI is exposed.'
                           : 'A Series9Identity moderator or the protocol owner is required. No transaction UI is exposed.'}
                   </p>
                 </div>
               </div>
             )}
           </div>
           </section>
         )}

         {isHomePage && (
          <>
            <section className="architecture-section" id="architecture" aria-labelledby="architecture-title">
          <div className="container architecture-section__inner">
            <div className="architecture-copy">
              <p className="eyebrow eyebrow--gold"><span className="eyebrow__line" />THE ARCHITECTURE</p>
              <h2 id="architecture-title">A better way<br /><em>to belong.</em></h2>
              <p>Identity is not a profile sitting beside the protocol. It is the thread connecting every move you make.</p>
              <a className="text-link" href="#pulse" onClick={() => announce('Following the signal into Protocol pulse.')}>Follow the signal <ButtonArrow /></a>
            </div>
            <figure className="architecture-visual" aria-labelledby="architecture-caption">
              <div className="architecture-visual__header"><span>FLOW / 001</span><span>LIVE SYSTEM MAP</span></div>
              <svg className="architecture-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <marker id="flow-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
                    <path d="M0 0 5 2.5 0 5Z" fill="#e8c46a" />
                  </marker>
                </defs>
                <path d="M22 51 C 31 29, 39 29, 49 49" markerEnd="url(#flow-arrow)" />
                <path d="M53 52 C 63 72, 71 72, 80 51" markerEnd="url(#flow-arrow)" />
                <path className="architecture-lines__orbit" d="M19 51 C 28 19, 72 16, 83 49 C 90 73, 62 91, 35 82 C 21 77, 15 65, 19 51Z" />
                <circle cx="50" cy="50" r="2.2" />
              </svg>
              <div className="diagram-node diagram-node--identity">
                <span className="diagram-node__icon"><Icon name="diamond" size={20} /></span>
                <span className="diagram-node__eyebrow">01 / ORIGIN</span>
                <strong>Identity</strong>
                <small>your signal</small>
              </div>
              <div className="diagram-node diagram-node--wallet">
                <span className="diagram-node__icon"><Icon name="wallet" size={20} /></span>
                <span className="diagram-node__eyebrow">02 / CONTROL</span>
                <strong>Wallet</strong>
                <small>your permissions</small>
              </div>
              <div className="diagram-node diagram-node--protocol">
                <span className="diagram-node__icon"><Icon name="cubes" size={20} /></span>
                <span className="diagram-node__eyebrow">03 / MOTION</span>
                <strong>Protocol</strong>
                <small>your economy</small>
              </div>
              <div className="architecture-visual__legend"><span><i className="legend-dot legend-dot--gold" /> ownership</span><span><i className="legend-dot legend-dot--paper" /> permissionless</span></div>
              <figcaption id="architecture-caption">A simple loop from identity to action to shared value.</figcaption>
            </figure>
          </div>
        </section>

        <section className="pulse-section" id="pulse" aria-labelledby="pulse-title">
          <div className="container">
            <div className="section-intro section-intro--pulse">
              <div>
                <p className="eyebrow"><span className="eyebrow__line eyebrow__line--ink" />PROTOCOL PULSE</p>
                <h2 id="pulse-title">The network<br /><em>is moving.</em></h2>
              </div>
              <p className="section-intro__copy">A real-time view of identity, conviction, and the small actions that add up.</p>
            </div>

            <div className="pulse-layout">
              <div className="chart-panel">
                <div className="chart-panel__topline">
                  <div>
                    <span className="panel-kicker">MONAD THROUGHPUT</span>
                    <strong>{seriesDelta(chartValues)}</strong>
                    <small>gas used across the last 550 blocks</small>
                  </div>
                  <span className="chart-panel__period">
                    LIVE <i>{stats.blockNumber === null ? PENDING : `#${stats.blockNumber.toLocaleString('en-US')}`}</i>
                  </span>
                </div>
                <div className="chart-wrap">
                  <svg className="pulse-chart" viewBox="0 0 720 260" preserveAspectRatio="none" role="img" aria-label="Gas used per sampled Monad block">
                    <title>Monad block gas usage</title>
                    <defs>
                      <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="#c9a45d" stopOpacity=".22" />
                        <stop offset="100%" stopColor="#c9a45d" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <path className="chart-grid-line" d="M0 32H720M0 98H720M0 164H720M0 230H720" />
                    <path className="chart-area" d={chart.area} />
                    <path className="chart-line" d={chart.line} />
                    <circle className="chart-point" cx={chart.lastX} cy={chart.lastY} r="5" />
                    <circle className="chart-point__halo" cx={chart.lastX} cy={chart.lastY} r="12" />
                  </svg>
                  <div className="chart-axis"><span>-550</span><span>-400</span><span>-250</span><span>-100</span><span>NOW</span></div>
                </div>
                <div className="bar-strip" aria-label="Gas used per sampled block">
                  {chartValues.map((value, index) => <span className="bar-strip__item" key={index}><i style={{ height: `${value}%` }} /></span>)}
                </div>
              </div>

              <div className="activity-panel">
                <div className="activity-panel__header">
                  <div><span className="panel-kicker">PROTOCOL STATE</span><strong>Read from Monad</strong></div>
                  <span className={`activity-live activity-live--${networkState}`}>
                    <i /> {networkState === 'degraded' ? 'stale' : networkState === 'loading' ? 'syncing' : 'live'}
                  </span>
                </div>
                <div className="activity-list">
                   {activity.slice(0, showAllActivity ? activity.length : 3).map((item) => (
                     <div className="activity-row" key={item.type}>
                       <span className="activity-row__icon"><Icon name={item.icon} size={17} /></span>
                       <span className="activity-row__copy"><strong>{item.type}</strong><small>{item.detail}</small></span>
                       <span className="activity-row__value">
                         {item.token ? (
                           <strong className="token-value">
                             <span>{item.amount}</span>
                             <TokenLogo token={item.token} imageUri={item.token === 'SER9' ? stats.ser9Image : undefined} />
                           </strong>
                         ) : (
                           <strong>{item.amount}</strong>
                         )}
                         {item.timeToken ? (
                           <small className="token-value">
                             <span>{item.time}</span>
                             <TokenLogo token={item.timeToken} imageUri={item.timeToken === 'SER9' ? stats.ser9Image : undefined} />
                           </small>
                         ) : (
                           <small>{item.time}</small>
                         )}
                       </span>
                     </div>
                   ))}
                </div>
                <button className="activity-more" type="button" aria-expanded={showAllActivity} onClick={() => setShowAllActivity((isOpen) => !isOpen)}>
                  {showAllActivity ? 'Show less' : 'View all readings'} <ButtonArrow />
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="cta-section" id="launch" aria-labelledby="cta-title">
          <div className="cta-section__grid" aria-hidden="true" />
          <div className="container cta-section__inner">
            <div>
              <p className="eyebrow eyebrow--gold"><span className="eyebrow__line" />YOUR NEXT MOVE</p>
              <h2 id="cta-title">Make it<br /><em>recognizable.</em></h2>
            </div>
            <div className="cta-section__aside">
              <p>Claim your place in the SERIES9 motion. The network is already in progress.</p>
              <button
                className="button button--gold"
                type="button"
                 disabled={wallet.connecting || wallet.switching || actionLabel !== null}
                onClick={() => void handleConnectWallet()}
              >
                {connected && wallet.address ? `Connected ${shortenAddress(wallet.address)}` : 'Connect wallet'} <ButtonArrow />
              </button>
              <span className="cta-section__note">
                <Icon name="lock" size={14} />{' '}
                {wallet.available ? 'Non-custodial by design' : 'No injected wallet detected'}
              </span>
            </div>
          </div>
          <div className="cta-section__stamp" aria-hidden="true">S9<br /><span>143</span></div>
            </section>
          </>
        )}
      </main>

      <footer className="site-footer">
        <div className="container site-footer__inner">
          <a className="brand brand--footer" href={routeHref('/', '#overview')} onClick={handleNavClick} aria-label="SERIES9 home">
                        <BrandMark />
            <span className="brand__name">SERIES9</span>
          </a>
          <p>Identity in motion.</p>
          <div className="site-footer__meta">
            <a href={explorerAddressUrl(CONTRACTS.identity)} target="_blank" rel="noreferrer">
              S9ID {shortenAddress(CONTRACTS.identity)}
            </a>
            <a href={explorerAddressUrl(CONTRACTS.ser9)} target="_blank" rel="noreferrer">
              <TokenLogo token="SER9" imageUri={stats.ser9Image} />
              <span>{symbol} {shortenAddress(CONTRACTS.ser9)}</span>
            </a>
            <span>MONAD MAINNET / {MONAD.id}</span>
          </div>
        </div>
      </footer>

      {toast && <div className={`toast toast--${toast.kind}`} role="status" aria-live="polite"><span className="toast__icon"><Icon name={toast.kind === 'error' ? 'bolt' : 'check'} size={16} /></span><span>{toast.message}</span><button type="button" aria-label="Dismiss notification" onClick={() => setToast(null)}>×</button></div>}
    </div>
  );
}

export default App;
