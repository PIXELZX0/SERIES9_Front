import { useEffect, useRef, useState } from 'react';

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

const navLinks: Array<{ label: string; href: `#${SectionId}`; id: SectionId }> = [
  { label: 'Overview', href: '#overview', id: 'overview' },
  { label: 'Identity', href: '#identity', id: 'identity' },
  { label: 'Staking', href: '#staking', id: 'staking' },
  { label: 'Pulse', href: '#pulse', id: 'pulse' },
];

const features: Feature[] = [
  {
    id: 'identity',
    number: '01',
    eyebrow: 'Identity NFT',
    title: 'Own the signal.',
    description:
      'A living identity primitive for the people, protocols, and places you return to onchain.',
    statLabel: 'Identities minted',
    statValue: '12,482',
    icon: 'diamond',
    theme: 'light',
    details: ['Soulbound by choice', 'Composable profile layer'],
  },
  {
    id: 'staking',
    number: '02',
    eyebrow: 'Staking engine',
    title: 'Make time compound.',
    description:
      'Turn conviction into a position. Stake SER9, collect protocol rewards, and keep moving.',
    statLabel: 'Current APR',
    statValue: '18.42%',
    icon: 'bolt',
    theme: 'sand',
    details: ['Flexible lock periods', 'Rewards stream daily'],
  },
  {
    id: 'wallet',
    number: '03',
    eyebrow: 'Smart wallet',
    title: 'Pay as yourself.',
    description:
      'A smart wallet that keeps permissions simple and your identity close to every action.',
    statLabel: 'Wallets activated',
    statValue: '3,106',
    icon: 'wallet',
    theme: 'dark',
    details: ['One-tap approvals', 'Built for Monad speed'],
  },
];

const activity: Activity[] = [
  { type: 'Identity minted', detail: 'SER9 ID #0143', amount: '+ 1 identity', time: '02:14 ago', icon: 'diamond' },
  { type: 'Stake position', detail: 'Position #0089', amount: '4,280 SER9', time: '08:42 ago', icon: 'bolt' },
  { type: 'Reward claimed', detail: 'Epoch 084 / Monad', amount: '+ 126.40 SER9', time: '16:09 ago', icon: 'check' },
  { type: 'Wallet activated', detail: 'Smart wallet #319', amount: '0x7A...91D2', time: '24:33 ago', icon: 'wallet' },
  { type: 'Protocol vote', detail: 'Proposal 004 / fee split', amount: 'Voted yes', time: '41:17 ago', icon: 'cubes' },
  { type: 'SER9 transfer', detail: 'Identity #811 → #143', amount: '680 SER9', time: '58:02 ago', icon: 'arrow' },
];

const chartValues = [28, 38, 34, 46, 44, 61, 56, 72, 68, 79, 76, 91];

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
  const [connected, setConnected] = useState(false);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>('overview');
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);

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

  function handleConnectWallet() {
    const nextConnectedState = !connected;
    setConnected(nextConnectedState);
    announce(nextConnectedState ? 'Wallet connected. Identity #0143 is ready.' : 'Wallet disconnected from this mock session.');
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
            <button className="network-status" type="button" onClick={() => announce('Monad mainnet is live at block 143.') }>
              <span className="network-status__dot" />
              <span>Monad</span>
              <span className="network-status__number">143</span>
            </button>
            <button
              className={`wallet-button${connected ? ' is-connected' : ''}`}
              type="button"
              aria-pressed={connected}
              onClick={handleConnectWallet}
            >
              <Icon name={connected ? 'check' : 'wallet'} size={16} />
              <span>{connected ? '0x7A...91D2' : 'Connect wallet'}</span>
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
              <p className="eyebrow eyebrow--gold"><span className="eyebrow__line" />MONAD MAINNET <span>/</span> 143</p>
              <h1 id="hero-title">Your identity,<br /><em>in motion<span className="hero__outline-nine">9</span>.</em></h1>
              <p className="hero__lede">
                SERIES9 is the identity layer for a more personal onchain economy. Move with conviction, keep your signal.
              </p>
              <div className="hero__actions">
                <a className="button button--gold" href="#pulse" onClick={() => announce('App surface ready. Explore the live protocol pulse below.') }>
                  Launch app <ButtonArrow />
                </a>
                <a className="button button--outline" href="#architecture" onClick={() => announce('Protocol architecture opened.') }>
                  Explore protocol <ButtonArrow />
                </a>
              </div>
              <div className="hero__meta">
                <span><span className="meta-check"><Icon name="check" size={13} /></span> Mainnet ready</span>
                <span className="hero__meta-divider" />
                <span>Built for Monad</span>
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
                  <span className="identity-card__signal"><span /> AUTHENTIC</span>
                </div>
                <div className="identity-card__monogram">
                  <span className="monogram-ring monogram-ring--back" aria-hidden="true" />
                  <span className="monogram-ring monogram-ring--front" aria-hidden="true" />
                  <span className="monogram-nine">9</span>
                </div>
                <div className="identity-card__name">
                  <span className="identity-card__label">ONCHAIN HANDLE</span>
                  <strong>orbit / 0143</strong>
                </div>
                <div className="identity-card__footer">
                  <span>ISSUED 2025</span>
                  <span>MONAD MAINNET</span>
                  <span className="identity-card__code">S9—0143</span>
                </div>
              </div>
              <div className="identity-float identity-float--top">
                <span className="identity-float__label">SER9 BALANCE</span>
                <strong>8,901.42</strong>
                <span className="identity-float__change">+ 12.8%</span>
              </div>
              <div className="identity-float identity-float--bottom">
                <span className="identity-float__icon"><Icon name="lock" size={14} /></span>
                <span><strong>Identity secured</strong><small>Block 18,420,991</small></span>
              </div>
              <figcaption id="identity-visual-caption">A portable identity, anchored to your motion.</figcaption>
            </figure>
          </div>
          <div className="hero__footer-line container"><span>scroll to enter</span><span className="hero__footer-arrow" aria-hidden="true">↓</span><span>09—∞</span></div>
        </section>

        <section className="signal-strip" aria-label="Live protocol signals">
          <div className="container signal-strip__grid">
            <div className="signal-strip__intro"><span className="signal-strip__pulse" /> LIVE SIGNAL</div>
            <div className="signal-metric"><span>SER9 / PRICE</span><strong>$0.0842</strong><small>+8.91%</small></div>
            <div className="signal-metric"><span>TOTAL STAKED</span><strong>18.42M</strong><small>SER9</small></div>
            <div className="signal-metric"><span>IDENTITIES</span><strong>12,482</strong><small>+143 today</small></div>
            <div className="signal-metric signal-metric--status"><span>NETWORK STATUS</span><strong><i /> Operational</strong><small>Monad mainnet</small></div>
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
                <div className="chart-panel__topline"><div><span className="panel-kicker">SER9 ACTIVITY</span><strong>+28.4%</strong><small>last 24 hours</small></div><span className="chart-panel__period">24H <i>7D</i> 30D</span></div>
                <div className="chart-wrap">
                  <svg className="pulse-chart" viewBox="0 0 720 260" preserveAspectRatio="none" role="img" aria-label="SER9 protocol activity rising over the last 24 hours">
                    <title>SER9 protocol activity</title>
                    <defs>
                      <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="#c9a45d" stopOpacity=".22" />
                        <stop offset="100%" stopColor="#c9a45d" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <path className="chart-grid-line" d="M0 32H720M0 98H720M0 164H720M0 230H720" />
                    <path className="chart-area" d="M0 208 L65 184 L130 194 L196 156 L261 168 L327 124 L392 138 L458 96 L523 110 L589 69 L654 81 L720 24 V260 H0Z" />
                    <path className="chart-line" d="M0 208 L65 184 L130 194 L196 156 L261 168 L327 124 L392 138 L458 96 L523 110 L589 69 L654 81 L720 24" />
                    <circle className="chart-point" cx="720" cy="24" r="5" />
                    <circle className="chart-point__halo" cx="720" cy="24" r="12" />
                  </svg>
                  <div className="chart-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>NOW</span></div>
                </div>
                <div className="bar-strip" aria-label="Hourly activity volume">
                  {chartValues.map((value, index) => <span className="bar-strip__item" key={`${value}-${index}`}><i style={{ height: `${value}%` }} /></span>)}
                </div>
              </div>

              <div className="activity-panel">
                <div className="activity-panel__header"><div><span className="panel-kicker">RECENT ACTIVITY</span><strong>Latest signal</strong></div><span className="activity-live"><i /> live</span></div>
                <div className="activity-list">
                  {activity.slice(0, showAllActivity ? activity.length : 3).map((item) => (
                    <div className="activity-row" key={`${item.type}-${item.time}`}>
                      <span className="activity-row__icon"><Icon name={item.icon} size={17} /></span>
                      <span className="activity-row__copy"><strong>{item.type}</strong><small>{item.detail}</small></span>
                      <span className="activity-row__value"><strong>{item.amount}</strong><small>{item.time}</small></span>
                    </div>
                  ))}
                </div>
                <button className="activity-more" type="button" aria-expanded={showAllActivity} onClick={() => setShowAllActivity((isOpen) => !isOpen)}>
                  {showAllActivity ? 'Show less' : 'View all activity'} <ButtonArrow />
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
              <button className="button button--gold" type="button" onClick={() => announce('Launch sequence initiated. Connect your wallet to continue.')}>Launch SERIES9 <ButtonArrow /></button>
              <span className="cta-section__note"><Icon name="lock" size={14} /> Non-custodial by design</span>
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
          <div className="site-footer__meta"><span>MONAD MAINNET / 143</span><span>© 2025 SERIES9</span></div>
        </div>
      </footer>

      {toast && <div className="toast" role="status" aria-live="polite"><span className="toast__icon"><Icon name="check" size={16} /></span><span>{toast}</span><button type="button" aria-label="Dismiss notification" onClick={() => setToast(null)}>×</button></div>}
    </div>
  );
}

export default App;
