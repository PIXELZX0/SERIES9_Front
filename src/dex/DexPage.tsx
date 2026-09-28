import { useCallback, useMemo, useState } from 'react';
import type { WalletState } from '../useWallet.ts';
import { DEX, normalizeAddress, sameAddress, type TokenInfo } from './config.ts';
import type { DexCtx, Notify } from './context.ts';
import { useRegistry, useTokenList, useUniverse, usePolled } from './hooks.ts';
import { cachedToken, readWallet } from './reads.ts';
import { dexHref, useDexSection, type DexSection } from './route.ts';
import { useTxRunner } from './useTxRunner.ts';
import { AddressLink, Notice } from './ui.tsx';
import SwapView from './SwapView.tsx';
import TradeView from './TradeView.tsx';
import PoolsView from './PoolsView.tsx';
import PerpsView from './PerpsView.tsx';

type DexPageProps = {
  wallet: WalletState;
  onNotify: Notify;
  onActionState: (label: string | null) => void;
};

const TABS: Array<[DexSection, string]> = [
  ['swap', '스왑'],
  ['trade', '지정가'],
  ['pools', '유동성'],
  ['perps', '선물'],
];

const TRACKED_PAIRS_KEY = 'series9:dex-tracked-pairs';

function readTrackedPairs(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(TRACKED_PAIRS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.map((entry) => normalizeAddress(String(entry))).filter((entry): entry is string => !!entry).slice(0, 30) : [];
  } catch {
    return [];
  }
}

export default function DexPage({ wallet, onNotify, onActionState }: DexPageProps) {
  const [section, navigate] = useDexSection();
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [trackedPairs, setTrackedPairs] = useState<string[]>(readTrackedPairs);
  const [tradePair, setTradePair] = useState<string | null>(null);
  const account = wallet.address;

  const { tokens, withNative, importToken } = useTokenList();
  const registry = useRegistry(refreshSignal);
  const universe = useUniverse(tokens, trackedPairs, refreshSignal);
  const pairs = useMemo(() => universe.data?.pairs ?? [], [universe.data]);

  const balanceTokens = useMemo(() => {
    const set = new Map<string, string>();
    tokens.forEach((token) => set.set(token.address.toLowerCase(), token.address));
    pairs.forEach((pair) => {
      set.set(pair.base.address.toLowerCase(), pair.base.address);
      set.set(pair.quote.address.toLowerCase(), pair.quote.address);
    });
    return [...set.values()];
  }, [pairs, tokens]);
  const walletData = usePolled(
    account ? `wallet:${account}:${balanceTokens.join(',')}` : null,
    (signal) => readWallet(account!, balanceTokens, [], signal),
    refreshSignal,
  );

  const refresh = useCallback(() => setRefreshSignal((value) => value + 1), []);
  const tx = useTxRunner(wallet, onNotify, onActionState, refresh);

  const trackPair = useCallback((pair: string) => {
    setTrackedPairs((previous) => {
      if (previous.some((entry) => sameAddress(entry, pair))) return previous;
      const next = [...previous, pair];
      try {
        window.localStorage.setItem(TRACKED_PAIRS_KEY, JSON.stringify(next));
      } catch {
        // per-visit only
      }
      return next;
    });
  }, []);

  const tokenFor = useCallback((address: string | null | undefined): TokenInfo | null => {
    if (!address) return null;
    return withNative.find((token) => sameAddress(token.address, address)) ?? cachedToken(address);
  }, [withNative]);

  const paused = registry.data?.paused === true;
  const ctx: DexCtx = {
    wallet,
    account,
    tokens,
    withNative,
    importToken,
    pairs,
    marketsLoading: universe.loading,
    paused,
    balances: walletData.data?.balances ?? new Map(),
    nativeBalance: walletData.data?.native ?? null,
    busy: tx.busy,
    run: tx.run,
    refresh,
    refreshSignal,
    notify: onNotify,
    tokenFor,
    trackPair,
  };

  const readError = registry.error ?? universe.error;

  return (
    <section className="workspace-section workspace-section--dex" aria-labelledby="dex-page-title">
      <div className="dx-shell">
        <header className="dx-topbar">
          <h1 id="dex-page-title" className="dx-visually-hidden">SERIES9 DEX</h1>
          <nav className="dx-tabs" aria-label="DEX 섹션">
            {TABS.map(([id, label]) => (
              <a
                key={id}
                href={dexHref(id)}
                className={section === id ? 'is-active' : ''}
                aria-current={section === id ? 'page' : undefined}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  navigate(id);
                }}
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="dx-topbar__status">
            <span className={`dx-status-dot${registry.data ? (paused ? ' is-paused' : ' is-live') : ''}`} />
            <span>{registry.data ? (paused ? '일시정지' : '운영 중') : registry.loading ? '연결 중' : '읽기 실패'}</span>
            <button type="button" className="dx-icon-button" onClick={refresh} aria-label="새로고침" title="새로고침">
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
            </button>
          </div>
        </header>

        {paused && (
          <Notice tone="warn">
            <span>
              DEX가 비상 정지 상태입니다. 스왑·주문·예치·포지션 진입이 막혀 있습니다.
              <strong> 유동성 회수, 주문 취소, 포지션 축소·청산은 계속 가능합니다.</strong>
            </span>
          </Notice>
        )}
        {registry.data && registry.data.mismatches.length > 0 && (
          <Notice tone="error"><span>레지스트리 배선이 설정과 다릅니다: {registry.data.mismatches.join(', ')}. <AddressLink address={DEX.registry} label="레지스트리 확인" /></span></Notice>
        )}
        {readError && !registry.data && <Notice tone="error">Monad에서 DEX를 읽지 못했습니다: {readError}</Notice>}
        {tx.unresolved && (
          <Notice tone="warn">
            <span>{tx.unresolved.label} 트랜잭션 <code title={tx.unresolved.hash}>{tx.unresolved.hash.slice(0, 10)}…{tx.unresolved.hash.slice(-6)}</code> 의 결과를 확인하지 못했습니다. 확인 전까지 새 트랜잭션을 막아 둡니다.</span>
            <span className="dx-inline-actions">
              <button type="button" className="dx-link-button" onClick={() => void tx.clearUnresolved()}>다시 확인</button>
              <button type="button" className="dx-link-button" onClick={tx.dismissUnresolved}>무시</button>
            </span>
          </Notice>
        )}
        {account && !wallet.onMonad && (
          <Notice><span>지갑이 Monad 메인넷이 아닙니다.</span> <button type="button" className="dx-link-button" onClick={() => void wallet.switchToMonad()}>Monad로 전환</button></Notice>
        )}

        <main className="dx-main">
          {section === 'swap' && <SwapView ctx={ctx} />}
          {section === 'trade' && <TradeView ctx={ctx} pairAddress={tradePair} onPair={setTradePair} />}
          {section === 'pools' && <PoolsView ctx={ctx} />}
          {section === 'perps' && <PerpsView ctx={ctx} />}
        </main>

        <footer className="dx-footer">
          <span>Series9 DEX · Monad</span>
          <AddressLink address={DEX.registry} label="Registry" />
          <AddressLink address={DEX.router} label="Router" />
          <AddressLink address={DEX.positionManager} label="Positions (S9-POS)" />
          <AddressLink address={DEX.treasury} label="Treasury" />
        </footer>
      </div>
    </section>
  );
}
