import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CONTRACTS,
  MONAD,
  encodeApprove,
  encodeClaimNFTRewards,
  encodeClaimRewards,
  encodeClaimUnstaked,
  encodeClaimUnstakedMonad,
  encodeCreateWallet,
  encodeMintIdentity,
  encodeMintIdentityWithHandle,
  encodeRequestUnstakeMonad,
  encodeSetHandle,
  encodeStake,
  encodeStakeMonad,
  encodeUnstake,
  explorerAddressUrl,
  formatCompact,
  formatUnits,
  shortenAddress,
} from './chain.ts';
import { useWallet } from './useWallet.ts';
import { useAccount, useProtocol, type AccountStats, type ProtocolStats } from './useProtocol.ts';

type IconName = 'arrow' | 'bolt' | 'card' | 'check' | 'copy' | 'cubes' | 'diamond' | 'lock' | 'menu' | 'orbit' | 'wallet';
type SectionId = 'overview' | 'identity' | 'staking' | 'pulse';
type SiteRoute = '/' | '/identity' | '/staking';
type Page = 'home' | 'identity' | 'staking';
type TokenKind = 'SER9' | 'MON';
type StakingAsset = TokenKind;
type ToastKind = 'success' | 'error';

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

function gweiFromWei(value: bigint | null): string {
  if (value === null) return PENDING;
  return `${formatUnits(value, 9, 2)} gwei`;
}

function parseUnitsInput(value: string, decimals: number): bigint | null {
  const normalized = value.trim();
  if (!/^\d*(?:\.\d*)?$/.test(normalized) || normalized === '' || normalized === '.') return null;

  const [whole = '0', fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) return null;

  try {
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  } catch {
    return null;
  }
}

function formatInputUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
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
  return 'home';
}

const navLinks: Array<{ label: string; href: string; id: SectionId }> = [
  { label: 'Overview', href: routeHref('/', '#overview'), id: 'overview' },
  { label: 'Identity', href: routeHref('/identity'), id: 'identity' },
  { label: 'Staking', href: routeHref('/staking'), id: 'staking' },
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

function App() {
  const page = currentPage();
  const isHomePage = page === 'home';

  const [menuOpen, setMenuOpen] = useState(false);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [toast, setToast] = useState<{ message: string; kind: ToastKind } | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>('overview');
  const [actionLabel, setActionLabel] = useState<string | null>(null);
  const [mintName, setMintName] = useState('');
  const [mintBio, setMintBio] = useState('');
  const [mintHandle, setMintHandle] = useState('');
  const [mintEntityType, setMintEntityType] = useState<'human' | 'ai'>('human');
  const [identityHandle, setIdentityHandle] = useState('');
  const [stakingAsset, setStakingAsset] = useState<StakingAsset>('SER9');
  const [stakingAmount, setStakingAmount] = useState('');
  const [ser9RequestId, setSer9RequestId] = useState('');
  const [monadRequestId, setMonadRequestId] = useState('');
  const [monGasReserve, setMonGasReserve] = useState(MON_NATIVE_GAS_RESERVE);
  const [monGasReserveSource, setMonGasReserveSource] = useState<'estimated' | 'fallback'>('fallback');
  const [monGasReserveAddress, setMonGasReserveAddress] = useState<string | null>(null);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);

  const wallet = useWallet();
  const { address: walletAddress, onMonad: walletOnMonad, estimateTransactionFee } = wallet;
  const stats = useProtocol();
  const account = useAccount(wallet.address, stats.blockNumber);

  const connected = wallet.address !== null;
  const symbol = stats.ser9Symbol ?? 'SER9';
  const features = buildFeatures(stats);
  const activity = buildActivity(stats, account, connected);
  const chartValues = normalizeSeries(stats.gasSeries);
  const chart = buildChartPaths(chartValues);
  const selectedDecimals = stakingAsset === 'SER9' ? stats.ser9Decimals : MONAD.nativeCurrency.decimals;
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

  function handleNavClick() {
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
    } catch {
      announceError(`Could not switch networks. Select ${MONAD.name} in your wallet.`);
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
  ): Promise<boolean> {
    setActionLabel(`${label} / waiting for wallet`);

    try {
      const hash = await wallet.sendTransaction(request);
      setActionLabel(`${label} / pending`);
      announce(`${label} submitted ${shortenHash(hash)}. Waiting for Monad confirmation.`);
      await wallet.waitForTransaction(hash);
      announce(`${label} confirmed. Live account data will refresh shortly.`);
      return true;
    } catch (actionError) {
      announceError(actionError instanceof Error ? actionError.message : `${label} failed.`);
      return false;
    } finally {
      setActionLabel(null);
    }
  }

  async function handleMintIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    if (!(await requireMonadWallet())) return;

    if (fee > 0n) {
      const approved = await sendAndWait(`Approve ${symbol} mint fee`, {
        to: CONTRACTS.ser9,
        data: encodeApprove(CONTRACTS.identity, fee),
      });
      if (!approved) return;
    }

    const data = handle
      ? encodeMintIdentityWithHandle(name, bio, mintEntityType === 'human' ? 0 : 1, 200, 80, handle)
      : encodeMintIdentity(name, bio, mintEntityType === 'human' ? 0 : 1, 200, 80);
    await sendAndWait('Mint identity', { to: CONTRACTS.identity, data });
  }

  async function handleSetIdentityHandle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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

  async function handleCreateIdentityWallet() {
    if (account.tokenId === null) {
      announceError('Mint an identity before creating its smart wallet.');
      return;
    }
    if (!(await requireMonadWallet())) return;
    await sendAndWait('Create smart wallet', {
      to: CONTRACTS.identity,
      data: encodeCreateWallet(account.tokenId),
    });
  }

  async function handleClaimNFTRewards() {
    if (account.pendingNFTRewards === null || account.pendingNFTRewards === 0n) {
      announceError('No NFT rewards are currently claimable.');
      return;
    }
    if (!(await requireMonadWallet())) return;
    await sendAndWait('Claim identity rewards', {
      to: CONTRACTS.identity,
      data: encodeClaimNFTRewards(),
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

  async function handleStakeSer9(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if ((!wallet.address || !wallet.onMonad) && !(await requireMonadWallet())) return;
    const amount = readActionAmount(stats.ser9Decimals, account.ser9Balance, 'stake');
    if (amount === null) return;

    const approved = await sendAndWait(`Approve ${symbol} stake`, {
      to: CONTRACTS.ser9,
      data: encodeApprove(CONTRACTS.staking, amount),
    });
    if (!approved) return;
    await sendAndWait(`Stake ${symbol}`, { to: CONTRACTS.staking, data: encodeStake(amount) });
  }

  async function handleUnstakeSer9() {
    if ((!wallet.address || !wallet.onMonad) && !(await requireMonadWallet())) return;
    const amount = readActionAmount(stats.ser9Decimals, account.staked, 'unstake');
    if (amount === null) return;
    await sendAndWait(`Request ${symbol} unstake`, {
      to: CONTRACTS.staking,
      data: encodeUnstake(amount),
    });
  }

  async function handleClaimSer9Rewards() {
    if (account.stakingRewards === null || account.stakingRewards === 0n) {
      announceError('No SER9 staking rewards are currently claimable.');
      return;
    }
    if (!(await requireMonadWallet())) return;
    await sendAndWait('Claim staking rewards', { to: CONTRACTS.staking, data: encodeClaimRewards() });
  }

  async function handleClaimSer9Unstaked() {
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

    try {
      const fee = await wallet.estimateTransactionFee(request);
      const gasBuffer = fee / 2n + MON_NATIVE_GAS_CUSHION;
      if (monBalance < amount + fee + gasBuffer) {
        announceError(`Not enough MON for the stake amount plus estimated gas (${tokenAmount(fee + gasBuffer, MONAD.nativeCurrency.decimals)} MON).`);
        return;
      }
    } catch (estimateError) {
      announceError(
        estimateError instanceof Error
          ? `Could not estimate MON staking gas: ${estimateError.message}`
          : 'Could not estimate MON staking gas.',
      );
      return;
    }

    await sendAndWait('Stake MON', request);
  }

  async function handleUnstakeMonad() {
    if ((!wallet.address || !wallet.onMonad) && !(await requireMonadWallet())) return;
    const amount = readActionAmount(MONAD.nativeCurrency.decimals, account.monadStaked, 'unstake');
    if (amount === null) return;
    await sendAndWait('Request MON unstake', {
      to: CONTRACTS.staking,
      data: encodeRequestUnstakeMonad(amount),
    });
  }

  async function handleClaimMonadUnstaked() {
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

  return (
    <div className={`site-shell${isHomePage ? '' : ' site-shell--workspace'}`}>
      <header className="site-header">
        <div className="site-header__inner container">
          <a className="brand" href={routeHref('/', '#overview')} onClick={handleNavClick} aria-label="SERIES9 home">
            <span className="brand__mark">S9</span>
            <span className="brand__name">SERIES9</span>
          </a>

          <nav ref={navRef} className={`primary-nav${menuOpen ? ' is-open' : ''}`} id="primary-navigation" aria-label="Primary navigation">
            {navLinks.map((link) => (
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
              className="network-status"
              type="button"
              onClick={() =>
                announce(
                  stats.error
                    ? `Monad RPC unreachable: ${stats.error}`
                    : `${MONAD.name} (chain ${MONAD.id}) at block ${stats.blockNumber?.toLocaleString('en-US') ?? PENDING}.`,
                )
              }
            >
              <span className="network-status__dot" />
              <span>Monad</span>
              <span className="network-status__number">
                {stats.blockNumber === null ? MONAD.id : Number(stats.blockNumber % 100000n).toLocaleString('en-US')}
              </span>
            </button>
            {connected && !wallet.onMonad && (
              <button className="wallet-button wallet-button--warning" type="button" onClick={handleSwitchNetwork}>
                <Icon name="bolt" size={16} />
                <span>Switch to Monad</span>
              </button>
            )}
            <button
              className={`wallet-button${connected ? ' is-connected' : ''}`}
              type="button"
              aria-pressed={connected}
              disabled={wallet.connecting}
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
                  <button className="button button--gold" type="button" disabled={wallet.connecting} onClick={() => void handleConnectWallet()}>
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
                  <span className="meta-check"><Icon name="check" size={13} /></span>{' '}
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
                <div className="identity-card__monogram">
                  <span className="monogram-ring monogram-ring--back" aria-hidden="true" />
                  <span className="monogram-ring monogram-ring--front" aria-hidden="true" />
                  <span className="monogram-nine">9</span>
                </div>
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

            <section className="signal-strip" aria-label="Live protocol signals">
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
            <div className="signal-metric signal-metric--status">
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

            {connected && !wallet.onMonad && (
              <div className="workspace-banner">
                <span><strong>Wrong network.</strong> Writes are available on {MONAD.name} only.</span>
                <button className="workspace-button workspace-button--small" type="button" onClick={() => void handleSwitchNetwork()}>
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
                    <button className="workspace-button workspace-button--ink" type="button" disabled={wallet.connecting} onClick={() => void handleConnectWallet()}>
                      {wallet.connecting ? 'Connecting...' : 'Connect wallet'} <ButtonArrow />
                    </button>
                  </div>
                ) : account.loading ? (
                  <div className="workspace-empty workspace-empty--compact">
                    <span className="workspace-status__pulse" />Reading identity state from Monad...
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
                    <div className="identity-summary__hero">
                      <div className="identity-summary__monogram"><span>9</span></div>
                      <div>
                        <span className="panel-kicker">S9ID / TOKEN {account.tokenId.toString().padStart(4, '0')}</span>
                        <h3>{account.name || 'Unnamed identity'}</h3>
                        <p>{account.handle ? `@${account.handle}` : 'No payment handle registered'}</p>
                      </div>
                    </div>
                    <dl className="identity-summary__facts">
                      <div><dt>ENTITY</dt><dd>{identityTypeLabel(account.entityType)}</dd></div>
                      <div><dt>VERIFIED</dt><dd>{account.verified === null ? PENDING : account.verified ? 'Yes' : 'No'}</dd></div>
                      <div><dt>REPUTATION</dt><dd>{account.reputation === null ? PENDING : account.reputation.toLocaleString('en-US')}</dd></div>
                      <div><dt>TOKEN ID</dt><dd>#{account.tokenId.toString()}</dd></div>
                    </dl>
                    <div className="identity-summary__wallet">
                      <span className="workspace-row-icon"><Icon name="wallet" size={16} /></span>
                      <span><small>SMART WALLET</small><strong>{account.smartWallet ? shortenAddress(account.smartWallet) : 'Not deployed'}</strong></span>
                      <span className="identity-summary__wallet-state">{account.smartWallet ? 'LIVE' : 'PREDICTED'}</span>
                    </div>
                    <div className="identity-summary__wallet-address">
                      {account.smartWallet
                        ? account.smartWallet
                        : account.predictedWallet
                          ? `Future address ${shortenAddress(account.predictedWallet)}`
                          : 'Wallet factory read unavailable'}
                    </div>
                     <div className="identity-summary__footer">
                       <span>NFT rewards <strong className="token-value"><span>{tokenAmount(account.pendingNFTRewards, stats.ser9Decimals)} {symbol}</span><TokenLogo token="SER9" imageUri={stats.ser9Image} /></strong></span>
                      <button
                        className="workspace-button workspace-button--small"
                        type="button"
                        disabled={actionLabel !== null || account.pendingNFTRewards === null || account.pendingNFTRewards === 0n}
                        onClick={() => void handleClaimNFTRewards()}
                      >
                        Claim rewards <ButtonArrow />
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
                  <div><span className="panel-kicker">IDENTITY CONTROL</span><strong>{account.tokenId === null ? 'Mint your identity' : 'Manage your identity'}</strong></div>
                  <Icon name="diamond" size={19} />
                </div>

                {!connected || account.loading ? (
                  <div className="workspace-rail-note">
                    <span className="detail-dot" />Connect and wait for the account read before writing identity state.
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
                    <button className="workspace-button workspace-button--gold" type="submit" disabled={actionLabel !== null || mintFeeInsufficient}>
                      {actionLabel ? actionLabel : 'Approve & mint identity'} <ButtonArrow />
                    </button>
                  </form>
                ) : (
                  <div className="workspace-form">
                    <div className="workspace-rail-note workspace-rail-note--positive"><span className="meta-check"><Icon name="check" size={12} /></span> Identity #{account.tokenId.toString()} is owned by this wallet.</div>
                    <form className="workspace-inline-form" onSubmit={(event) => void handleSetIdentityHandle(event)}>
                      <label className="workspace-field">
                        <span>Update payment handle</span>
                        <input value={identityHandle} maxLength={32} onChange={(event) => setIdentityHandle(event.target.value)} placeholder={account.handle || 'new-handle'} />
                      </label>
                      <button className="workspace-button workspace-button--ink" type="submit" disabled={actionLabel !== null}>Set handle <ButtonArrow /></button>
                    </form>
                    {!account.smartWallet && (
                      <div className="workspace-action-row">
                        <div><span className="panel-kicker">CREATE2 FACTORY</span><strong>Deploy the smart wallet</strong><p>Permissionless deployment at the predicted address for this token.</p></div>
                        <button className="workspace-button workspace-button--outline" type="button" disabled={actionLabel !== null} onClick={() => void handleCreateIdentityWallet()}>Create wallet <ButtonArrow /></button>
                      </div>
                    )}
                     <div className="workspace-action-row workspace-action-row--muted">
                       <div><span className="panel-kicker">REPUTATION REWARDS</span><strong>Claim NFT rewards</strong><p className="token-copy"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>{tokenAmount(account.pendingNFTRewards, stats.ser9Decimals)} {symbol} currently attributable to this identity.</span></p></div>
                      <button className="workspace-button workspace-button--outline" type="button" disabled={actionLabel !== null || account.pendingNFTRewards === null || account.pendingNFTRewards === 0n} onClick={() => void handleClaimNFTRewards()}>Claim <ButtonArrow /></button>
                    </div>
                  </div>
                )}
              </article>
            </div>
          </div>
          </section>
        )}

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

            <div className="workspace-grid workspace-grid--staking">
              <article className="workspace-panel position-panel">
                <div className="workspace-panel__header">
                  <div><span className="panel-kicker">LIVE POSITION</span><strong>Your conviction</strong></div>
                  <span className="workspace-panel__tag">{connected ? 'MONAD / 143' : 'CONNECT WALLET'}</span>
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
                          <div className="amount-input-wrap"><input inputMode="decimal" value={stakingAmount} onChange={(event) => setStakingAmount(event.target.value)} placeholder="0.00" /><span className="amount-input-wrap__token token-label"><TokenLogo token="SER9" imageUri={stats.ser9Image} /><span>{symbol}</span></span><button type="button" onClick={handleMaxAmount}>MAX</button></div>
                       </label>
                      <div className="workspace-action-grid">
                        <button className="workspace-button workspace-button--gold" type="submit" disabled={actionLabel !== null || !canStakeSelected}>Approve & stake <ButtonArrow /></button>
                        <button className="workspace-button workspace-button--ink" type="button" disabled={actionLabel !== null || !canUnstakeSelected} onClick={() => void handleUnstakeSer9()}>Request unstake <ButtonArrow /></button>
                      </div>
                    </form>
                    <div className="unstake-note"><span className="workspace-row-icon"><Icon name="lock" size={15} /></span><span><strong>Epoch delayed</strong><small>Unstake creates a request first. SER9 becomes claimable after the protocol delay.</small></span></div>
                     <div className="request-control">
                       <div><span className="panel-kicker">SER9 REQUESTS</span><small>{account.ser9UnstakeRequestCount === null ? 'Reading request count...' : `${account.ser9UnstakeRequestCount.toString()} request${account.ser9UnstakeRequestCount === 1n ? '' : 's'}`}</small></div>
                       <div className="request-control__form"><input inputMode="numeric" value={ser9RequestId} onChange={(event) => setSer9RequestId(event.target.value)} placeholder={account.ser9LatestUnstakeRequestId === null ? 'request id' : `latest ${account.ser9LatestUnstakeRequestId.toString()}`} aria-label="SER9 unstake request id" /><button className="workspace-button workspace-button--small" type="button" disabled={actionLabel !== null || ser9ClaimRequestId === null} onClick={() => void handleClaimSer9Unstaked()}>Claim <ButtonArrow /></button></div>
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
                     <button className="workspace-button workspace-button--outline workspace-button--full" type="button" disabled={actionLabel !== null || account.stakingRewards === null || account.stakingRewards === 0n} onClick={() => void handleClaimSer9Rewards()}>Claim earned rewards <span className="token-value"><span>{tokenAmount(account.stakingRewards, stats.ser9Decimals)} {symbol}</span><TokenLogo token="SER9" imageUri={stats.ser9Image} /></span> <ButtonArrow /></button>
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
                          <div className="amount-input-wrap"><input inputMode="decimal" value={stakingAmount} onChange={(event) => setStakingAmount(event.target.value)} placeholder="0.00" /><span className="amount-input-wrap__token token-label"><TokenLogo token="MON" /><span>MON</span></span><button type="button" onClick={handleMaxAmount}>MAX</button></div>
                      </label>
                      <div className="workspace-action-grid">
                        <button className="workspace-button workspace-button--gold" type="submit" disabled={actionLabel !== null || !canStakeSelected}>Stake MON <ButtonArrow /></button>
                        <button className="workspace-button workspace-button--ink" type="button" disabled={actionLabel !== null || !canUnstakeSelected} onClick={() => void handleUnstakeMonad()}>Request unstake <ButtonArrow /></button>
                      </div>
                    </form>
                    <div className="unstake-note"><span className="workspace-row-icon"><Icon name="lock" size={15} /></span><span><strong>Native MON, epoch covered</strong><small>MON is delegated through Monad staking. Coverage and the epoch delay must clear before a claim can settle.</small></span></div>
                     <div className="request-control">
                       <div><span className="panel-kicker">MON REQUESTS</span><small>{account.monadUnstakeRequestCount === null ? 'Reading request count...' : `${account.monadUnstakeRequestCount.toString()} request${account.monadUnstakeRequestCount === 1n ? '' : 's'}`}</small></div>
                       <div className="request-control__form"><input inputMode="numeric" value={monadRequestId} onChange={(event) => setMonadRequestId(event.target.value)} placeholder={account.monadLatestUnstakeRequestId === null ? 'request id' : `latest ${account.monadLatestUnstakeRequestId.toString()}`} aria-label="MON unstake request id" /><button className="workspace-button workspace-button--small" type="button" disabled={actionLabel !== null || monadClaimRequestId === null} onClick={() => void handleClaimMonadUnstaked()}>Claim <ButtonArrow /></button></div>
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
                  <span className="activity-live"><i /> {stats.error ? 'stale' : 'live'}</span>
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
                disabled={wallet.connecting}
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
          <a className="brand brand--footer" href={routeHref('/', '#overview')} aria-label="SERIES9 home">
            <span className="brand__mark">S9</span>
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
