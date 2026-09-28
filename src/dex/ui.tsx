import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { explorerAddressUrl, shortenAddress } from '../chain.ts';
import { normalizeAddress, sameAddress, type TokenInfo } from './config.ts';
import { formatAmount, toInputString } from './math.ts';

const BADGE_HUES = [42, 18, 160, 205, 280, 330];

function hueFor(address: string): number {
  let hash = 0;
  for (const char of address.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return BADGE_HUES[hash % BADGE_HUES.length];
}

export function TokenIcon({ token, size = 26 }: { token: TokenInfo | null | undefined; size?: number }) {
  const [broken, setBroken] = useState<string | null>(null);
  const logo = token?.logo ?? null;
  if (logo && broken !== logo) {
    return <img className="dx-token-icon" src={logo} alt="" width={size} height={size} onError={() => setBroken(logo)} />;
  }
  const hue = token ? hueFor(token.address) : 42;
  return (
    <span
      className="dx-token-icon dx-token-icon--letter"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `linear-gradient(135deg, hsl(${hue} 45% 42%), hsl(${hue} 35% 22%))` }}
      aria-hidden="true"
    >
      {(token?.symbol ?? '?').slice(0, 1)}
    </span>
  );
}

export function PairIcons({ a, b, size = 24 }: { a: TokenInfo | null | undefined; b: TokenInfo | null | undefined; size?: number }) {
  return (
    <span className="dx-pair-icons" style={{ width: size * 1.7 }}>
      <TokenIcon token={a} size={size} />
      <span className="dx-pair-icons__second" style={{ marginLeft: -size * 0.3 }}><TokenIcon token={b} size={size} /></span>
    </span>
  );
}

export function AddressLink({ address, label }: { address: string; label?: string }) {
  return (
    <a className="dx-address" href={explorerAddressUrl(address)} target="_blank" rel="noreferrer">
      {label ?? shortenAddress(address)}
    </a>
  );
}

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dx-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`dx-modal${wide ? ' dx-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="dx-modal__head">
          <h3>{title}</h3>
          <button type="button" className="dx-icon-button" onClick={onClose} aria-label="닫기">×</button>
        </header>
        <div className="dx-modal__body">{children}</div>
      </div>
    </div>
  );
}

type TokenSelectProps = {
  tokens: TokenInfo[];
  balances?: Map<string, bigint>;
  exclude?: string | null;
  onSelect: (token: TokenInfo) => void;
  onImport: (address: string) => Promise<TokenInfo | null>;
  onClose: () => void;
};

export function TokenSelectModal({ tokens, balances, exclude, onSelect, onImport, onClose }: TokenSelectProps) {
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const needle = query.trim().toLowerCase();
  const pasted = normalizeAddress(query);
  const filtered = useMemo(() => tokens.filter((token) =>
    !needle || token.symbol.toLowerCase().includes(needle) || (token.name ?? '').toLowerCase().includes(needle) || token.address.toLowerCase() === needle,
  ), [needle, tokens]);
  const canImport = pasted !== null && !tokens.some((token) => sameAddress(token.address, pasted));

  const importPasted = async () => {
    if (!pasted) return;
    setImporting(true);
    setImportError(null);
    const token = await onImport(pasted).catch(() => null);
    setImporting(false);
    if (token) onSelect(token);
    else setImportError('이 주소에서 ERC-20 정보를 읽지 못했습니다.');
  };

  return (
    <Modal title="토큰 선택" onClose={onClose}>
      <input
        ref={inputRef}
        className="dx-input dx-input--search"
        placeholder="심볼 검색 또는 토큰 주소 붙여넣기"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        spellCheck={false}
      />
      <ul className="dx-token-list">
        {filtered.map((token) => {
          const disabled = !!exclude && sameAddress(token.address, exclude);
          const balance = balances?.get(token.address.toLowerCase());
          return (
            <li key={token.address}>
              <button type="button" className="dx-token-row" disabled={disabled} onClick={() => onSelect(token)}>
                <TokenIcon token={token} size={30} />
                <span className="dx-token-row__name">
                  <strong>{token.symbol}</strong>
                  <small>{token.native ? '네이티브 · 자동 래핑' : token.name ?? shortenAddress(token.address)}</small>
                </span>
                <span className="dx-token-row__balance">{balance !== undefined ? formatAmount(balance, token.decimals) : ''}</span>
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && !canImport && <li className="dx-empty">일치하는 토큰이 없습니다.</li>}
      </ul>
      {canImport && (
        <div className="dx-import">
          <p>목록에 없는 토큰입니다. 컨트랙트에서 정보를 읽어 추가합니다. 누구나 토큰을 만들 수 있으니 주소를 꼭 확인하세요.</p>
          <button type="button" className="dx-button dx-button--ghost" disabled={importing} onClick={() => void importPasted()}>
            {importing ? '읽는 중…' : '토큰 가져오기'}
          </button>
          {importError && <p className="dx-error-text">{importError}</p>}
        </div>
      )}
    </Modal>
  );
}

export function TokenButton({ token, onClick, placeholder = '토큰 선택' }: { token: TokenInfo | null; onClick: () => void; placeholder?: string }) {
  return (
    <button type="button" className={`dx-token-button${token ? '' : ' dx-token-button--empty'}`} onClick={onClick}>
      {token && <TokenIcon token={token} size={22} />}
      <span>{token?.symbol ?? placeholder}</span>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
    </button>
  );
}

type AmountBoxProps = {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  token: TokenInfo | null;
  onPickToken?: () => void;
  balance?: bigint | null;
  onMax?: () => void;
  readOnly?: boolean;
  note?: ReactNode;
  invalid?: boolean;
};

export function AmountBox({ label, value, onChange, token, onPickToken, balance, onMax, readOnly, note, invalid }: AmountBoxProps) {
  return (
    <div className={`dx-amount${invalid ? ' dx-amount--invalid' : ''}`}>
      <div className="dx-amount__top">
        <span>{label}</span>
        {balance !== undefined && balance !== null && token && (
          <span className="dx-amount__balance">
            잔액 {formatAmount(balance, token.decimals)}
            {onMax && !readOnly && <button type="button" onClick={onMax}>MAX</button>}
          </span>
        )}
      </div>
      <div className="dx-amount__main">
        <input
          className="dx-amount__input"
          inputMode="decimal"
          placeholder="0"
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange?.(event.target.value.replace(/[^\d.,]/g, ''))}
          aria-label={label}
        />
        {onPickToken ? <TokenButton token={token} onClick={onPickToken} /> : token && (
          <span className="dx-token-static"><TokenIcon token={token} size={22} />{token.symbol}</span>
        )}
      </div>
      {note && <div className="dx-amount__note">{note}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' | 'warn' }) {
  return (
    <div className="dx-stat">
      <span className="dx-stat__label">{label}</span>
      <strong className={`dx-stat__value${tone ? ` dx-tone-${tone}` : ''}`}>{value}</strong>
      {sub && <span className="dx-stat__sub">{sub}</span>}
    </div>
  );
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="dx-row">
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: {
  value: T;
  options: Array<{ value: T; label: ReactNode; tone?: 'up' | 'down' }>;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={`dx-segmented dx-segmented--${size}`} role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={`${value === option.value ? 'is-active' : ''}${option.tone ? ` dx-seg-${option.tone}` : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="dx-empty-state">
      <span className="dx-empty-state__mark" aria-hidden="true">✦</span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

/** Preset percentage chips that fill an input from a balance. */
export function PercentChips({ balance, decimals, onPick }: { balance: bigint | null | undefined; decimals: number; onPick: (text: string) => void }) {
  if (!balance) return null;
  return (
    <div className="dx-chips">
      {[25n, 50n, 75n, 100n].map((pct) => (
        <button key={pct.toString()} type="button" onClick={() => onPick(toInputString((balance * pct) / 100n, decimals))}>
          {pct.toString()}%
        </button>
      ))}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  return <div className={`dx-notice dx-notice--${tone}`}>{children}</div>;
}
