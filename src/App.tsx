import { useEffect, useRef, useState } from 'react';
import {
  CONTRACTS,
  MONAD,
  explorerAddressUrl,
  formatCompact,
  formatUnits,
  shortenAddress,
} from './chain.ts';
import { useWallet } from './useWallet.ts';
import { useAccount, useProtocol, type AccountStats, type ProtocolStats } from './useProtocol.ts';

type IconName = 'arrow' | 'bolt' | 'card' | 'check' | 'copy' | 'cubes' | 'diamond' | 'lock' | 'menu' | 'orbit' | 'wallet';
type SectionId = 'overview' | 'identity' | 'staking' | 'pulse';

type Feature = {
  id: 'identity' | 'staking' | 'wallet';
  number: string;
  eyebrow: string;
  title: string;
  description: string;
  statLabel: string;
  statValue: string;
  icon: IconName;
  theme: 'light' | 'sand' | 'dark';
  details: string[];
};

type Activity = {
  type: string;
  detail: string;
  amount: string;
  time: string;
  icon: IconName;
};

/** Placeholder for a value the chain has not returned (yet, or at all). */
const PENDING = '—';

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

const navLinks: Array<{ label: string; href: `#${SectionId}`; id: SectionId }> = [
  { label: 'Overview', href: '#overview', id: 'overview' },
  { label: 'Identity', href: '#identity', id: 'identity' },
  { label: 'Staking', href: '#staking', id: 'staking' },
  { label: 'Pulse', href: '#pulse', id: 'pulse' },
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
        `Human mint fee ${tokenAmount(stats.humanMintFee, stats.ser9Decimals, 0)} ${symbol}`,
        `AI mint fee ${tokenAmount(stats.aiMintFee, stats.ser9Decimals, 0)} ${symbol}`,
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
      icon: 'bolt',
      theme: 'sand',
      details: [
        `Reward index ${tokenAmount(stats.rewardPerTokenStored, stats.ser9Decimals, 2)}`,
        'Rewards accrue per block',
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
      details: ['Deterministic CREATE2 address', 'Built for Monad speed'],
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
        icon: 'wallet',
      },
      {
        type: 'Your staked position',
        detail: 'Series9 staking',
        amount: `${tokenAmount(account.staked, stats.ser9Decimals)} ${symbol}`,
        time: `pending ${tokenAmount(account.pendingRewards, stats.ser9Decimals)}`,
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

function FeatureCard({ feature }: { feature: Feature }) {
  return (
    <article className={`feature-card feature-card--${feature.theme}`} id={feature.id === 'identity' ? undefined : feature.id}>
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
          <li key={detail}><span className="detail-dot" />{detail}</li>
        ))}
      </ul>
      <div className="feature-card__stat">
        <span>{feature.statLabel}</span>
        <strong>{feature.statValue}</strong>
      </div>
    </article>
  );
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>('overview');
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);

  const wallet = useWallet();
  const stats = useProtocol();
  const account = useAccount(wallet.address, stats.blockNumber);

  const connected = wallet.address !== null;
  const symbol = stats.ser9Symbol ?? 'SER9';
  const features = buildFeatures(stats);
  const activity = buildActivity(stats, account, connected);
  const chartValues = normalizeSeries(stats.gasSeries);
  const chart = buildChartPaths(chartValues);

  useEffect(() => {
    const sectionIds: SectionId[] = ['overview', 'identity', 'staking', 'pulse'];
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
  }, []);

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

  function announce(message: string) {
    setToast(message);
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
    announce(
      result.error ?? `Connected ${result.address ? shortenAddress(result.address) : 'wallet'} on ${MONAD.name}.`,
    );
  }

  async function handleSwitchNetwork() {
    try {
      await wallet.switchToMonad();
    } catch {
      announce(`Could not switch networks. Select ${MONAD.name} in your wallet.`);
    }
  }

  return (
    <div className="site-shell">
      <header className="site-header">
        <div className="site-header__inner container">
          <a className="brand" href="#overview" onClick={handleNavClick} aria-label="SERIES9 home">
            <span className="brand__mark">S9</span>
            <span className="brand__name">SERIES9</span>
          </a>

          <nav ref={navRef} className={`primary-nav${menuOpen ? ' is-open' : ''}`} id="primary-navigation" aria-label="Primary navigation">
            {navLinks.map((link) => (
              <a
                className={activeSection === link.id ? 'is-active' : ''}
                href={link.href}
                key={link.id}
                onClick={handleNavClick}
                aria-current={activeSection === link.id ? 'location' : undefined}
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
                <span className="identity-float__label">{symbol} BALANCE</span>
                <strong>{connected ? tokenAmount(account.ser9Balance, stats.ser9Decimals) : PENDING}</strong>
                <span className="identity-float__change">
                  {connected ? `${tokenAmount(account.monBalance, MONAD.nativeCurrency.decimals)} MON` : 'not connected'}
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
              <span>{symbol} / SUPPLY</span>
              <strong>{compactAmount(stats.ser9TotalSupply, stats.ser9Decimals)}</strong>
              <small>{symbol}</small>
            </div>
            <div className="signal-metric">
              <span>TOTAL STAKED</span>
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

        <section className="features-section" id="identity" aria-labelledby="features-title">
          <div className="container">
            <div className="section-intro section-intro--features">
              <div>
                <p className="eyebrow"><span className="eyebrow__line eyebrow__line--ink" />THE PROTOCOL</p>
                <h2 id="features-title">One signal.<br /><em>Three ways forward.</em></h2>
              </div>
              <p className="section-intro__copy">Everything you need to be legible, aligned, and active in the next internet.</p>
            </div>
            <div className="feature-grid">
              {features.map((feature) => <FeatureCard feature={feature} key={feature.id} />)}
            </div>
          </div>
        </section>

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
                      <span className="activity-row__value"><strong>{item.amount}</strong><small>{item.time}</small></span>
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
      </main>

      <footer className="site-footer">
        <div className="container site-footer__inner">
          <a className="brand brand--footer" href="#overview" aria-label="SERIES9 home">
            <span className="brand__mark">S9</span>
            <span className="brand__name">SERIES9</span>
          </a>
          <p>Identity in motion.</p>
          <div className="site-footer__meta">
            <a href={explorerAddressUrl(CONTRACTS.identity)} target="_blank" rel="noreferrer">
              S9ID {shortenAddress(CONTRACTS.identity)}
            </a>
            <a href={explorerAddressUrl(CONTRACTS.ser9)} target="_blank" rel="noreferrer">
              {symbol} {shortenAddress(CONTRACTS.ser9)}
            </a>
            <span>MONAD MAINNET / {MONAD.id}</span>
          </div>
        </div>
      </footer>

      {toast && <div className="toast" role="status" aria-live="polite"><span className="toast__icon"><Icon name="check" size={16} /></span><span>{toast}</span><button type="button" aria-label="Dismiss notification" onClick={() => setToast(null)}>×</button></div>}
    </div>
  );
}

export default App;
