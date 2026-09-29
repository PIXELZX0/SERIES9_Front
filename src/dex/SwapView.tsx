import { useEffect, useMemo, useState } from 'react';
import { MON_NATIVE_GAS_RESERVE, TOKENS } from '../chain.ts';
import { asUint } from './abi.ts';
import { routerSwap, unwrapMon, wrapMon } from './actions.ts';
import { DEFAULT_TOKENS, DEX, MON, sameAddress, type TokenInfo } from './config.ts';
import { approvalSteps, balanceOf, type DexCtx } from './context.ts';
import {
  BPS,
  E18,
  applySlippage,
  formatAmount,
  formatBps,
  formatPpm,
  formatPriceX18,
  formatSig,
  parseAmount,
  parseSlippageBps,
  toInputString,
} from './math.ts';
import { batch, call, pairMidX18, quoteRoutes, type PairInfo, type Route } from './reads.ts';
import type { AnyStep } from './useTxRunner.ts';
import { AmountBox, Empty, Modal, PairIcons, Row, TokenIcon, TokenSelectModal } from './ui.tsx';

const SLIPPAGE_PRESETS = ['0.1', '0.5', '1', '3'];
const SLIPPAGE_KEY = 'series9:dex-slippage';

function readSlippage(): string {
  try {
    const stored = window.localStorage.getItem(SLIPPAGE_KEY);
    return stored && parseSlippageBps(stored) !== null ? stored : '0.5';
  } catch {
    return '0.5';
  }
}

/** The ERC-20 a token trades as on-chain: native MON routes as WMON. */
function onChain(token: TokenInfo): string {
  return token.native ? TOKENS.wmon : token.address;
}

/** Output along a route at pre-trade prices, after fees: the no-impact baseline. */
function midOut(route: Route, amountIn: bigint): bigint | null {
  let amount = amountIn;
  let token = route.tokens[0];
  for (const pool of route.pools) {
    const forward = sameAddress(pool.token0, token);
    const reserveIn = forward ? pool.reserve0 : pool.reserve1;
    const reserveOut = forward ? pool.reserve1 : pool.reserve0;
    if (reserveIn === 0n) return null;
    amount = (((amount * (1_000_000n - pool.feePpm)) / 1_000_000n) * reserveOut) / reserveIn;
    token = forward ? pool.token1 : pool.token0;
  }
  return amount;
}

type QuoteState = { key: string; routes: Route[]; error: string | null };

export default function SwapView({ ctx }: { ctx: DexCtx }) {
  const [tokenIn, setTokenIn] = useState<TokenInfo>(DEFAULT_TOKENS[0]);
  const [tokenOut, setTokenOut] = useState<TokenInfo | null>(MON);
  const [amountText, setAmountText] = useState('');
  const [picker, setPicker] = useState<'in' | 'out' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [slippage, setSlippage] = useState(readSlippage);
  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [routeIndex, setRouteIndex] = useState(0);

  const amountIn = parseAmount(amountText, tokenIn.decimals);
  const slippageBps = parseSlippageBps(slippage) ?? 50n;
  const wrapOnly = !!tokenOut && ((tokenIn.native && sameAddress(tokenOut.address, TOKENS.wmon)) || (tokenOut.native && sameAddress(tokenIn.address, TOKENS.wmon)));
  const sameToken = !!tokenOut && onChain(tokenIn).toLowerCase() === onChain(tokenOut).toLowerCase() && !wrapOnly;
  const quoteKey = tokenOut && amountIn && amountIn > 0n && !wrapOnly && !sameToken
    ? `${onChain(tokenIn)}:${onChain(tokenOut)}:${amountIn}:${ctx.refreshSignal}:${ctx.pairs.length}`
    : null;

  useEffect(() => {
    if (!quoteKey || !tokenOut || !amountIn) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      quoteRoutes(ctx.pairs, onChain(tokenIn), onChain(tokenOut), amountIn, controller.signal)
        .then((routes) => setQuote({ key: quoteKey, routes, error: null }))
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setQuote({ key: quoteKey, routes: [], error: error instanceof Error ? error.message : '견적 실패' });
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [quoteKey, ctx.pairs, tokenIn, tokenOut, amountIn]);

  const currentQuote = quote && quote.key === quoteKey ? quote : null;
  const routes = useMemo(() => currentQuote?.routes ?? [], [currentQuote]);
  const route = routes[Math.min(routeIndex, Math.max(routes.length - 1, 0))] ?? null;
  const amountOut = wrapOnly ? amountIn : route?.amountOut ?? null;
  const minOut = amountOut !== null && amountOut !== undefined && !wrapOnly ? applySlippage(amountOut, slippageBps) : amountOut;
  const mid = route && amountIn ? midOut(route, amountIn) : null;
  const impactBps = mid && route && mid > 0n && route.amountOut < mid ? ((mid - route.amountOut) * BPS) / mid : 0n;

  const balanceIn = tokenIn.native ? ctx.nativeBalance : balanceOf(ctx, tokenIn);
  const balanceOut = tokenOut ? (tokenOut.native ? ctx.nativeBalance : balanceOf(ctx, tokenOut)) : null;
  const spendable = tokenIn.native && balanceIn !== null ? (balanceIn > MON_NATIVE_GAS_RESERVE ? balanceIn - MON_NATIVE_GAS_RESERVE : 0n) : balanceIn;
  const insufficient = amountIn !== null && spendable !== null && amountIn > spendable;

  const flip = () => {
    if (!tokenOut) return;
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountText(amountOut && amountOut > 0n ? toInputString(amountOut, tokenOut.decimals, 6) : '');
    setRouteIndex(0);
  };

  const choose = (token: TokenInfo) => {
    if (picker === 'in') {
      if (tokenOut && sameAddress(token.address, tokenOut.address)) setTokenOut(tokenIn);
      setTokenIn(token);
    } else if (picker === 'out') {
      if (sameAddress(token.address, tokenIn.address)) setTokenIn(tokenOut ?? DEFAULT_TOKENS[0]);
      setTokenOut(token);
    }
    setRouteIndex(0);
    setPicker(null);
  };

  const submit = async () => {
    if (!ctx.account) {
      await ctx.wallet.connect();
      return;
    }
    if (!tokenOut || !amountIn) return;
    const account = ctx.account;
    if (wrapOnly) {
      await ctx.run(tokenIn.native ? '래핑' : '언래핑', [tokenIn.native ? wrapMon(amountIn) : unwrapMon(amountIn)]);
      setAmountText('');
      return;
    }
    if (!route || !minOut) return;
    const tokenInAddress = onChain(tokenIn);
    const steps: AnyStep[] = [];
    if (tokenIn.native) steps.push(wrapMon(amountIn));
    const erc20In: TokenInfo = tokenIn.native ? { ...DEFAULT_TOKENS[1] } : tokenIn;
    const pools = route.pools.map((pool) => pool.address);
    steps.push(...approvalSteps(account, [{ token: erc20In, spender: DEX.router, amount: amountIn }]));
    let wmonBefore = 0n;
    if (tokenOut.native) {
      const [before] = await batch([call(TOKENS.wmon, 'balanceOf(address)', [account])]);
      wmonBefore = asUint(before) ?? 0n;
    }
    steps.push(routerSwap(pools, tokenInAddress, amountIn, minOut, account));
    if (tokenOut.native) {
      steps.push({
        label: 'WMON → MON 언래핑',
        build: async () => {
          const [after] = await batch([call(TOKENS.wmon, 'balanceOf(address)', [account])]);
          const received = (asUint(after) ?? 0n) - wmonBefore;
          return received > 0n ? unwrapMon(received) : null;
        },
      });
    }
    const ok = await ctx.run(`${tokenIn.symbol} → ${tokenOut.symbol} 스왑`, steps);
    if (ok) setAmountText('');
  };

  let cta = '스왑';
  let disabled = false;
  if (!ctx.account) cta = '지갑 연결';
  else if (ctx.paused) { cta = 'DEX 일시정지 중'; disabled = true; }
  else if (!tokenOut) { cta = '토큰 선택'; disabled = true; }
  else if (sameToken) { cta = '같은 토큰입니다'; disabled = true; }
  else if (!amountIn) { cta = '금액 입력'; disabled = true; }
  else if (insufficient) { cta = `${tokenIn.symbol} 잔액 부족`; disabled = true; }
  else if (wrapOnly) cta = tokenIn.native ? 'WMON으로 래핑' : 'MON으로 언래핑';
  else if (!currentQuote) { cta = '견적 계산 중…'; disabled = true; }
  else if (!route) { cta = '거래 가능한 경로 없음'; disabled = true; }
  else if (impactBps > 1500n) cta = '가격 영향 큼 · 그래도 스왑';
  if (ctx.busy) disabled = true;

  const rate = route && amountIn && tokenOut && amountIn > 0n
    ? formatSig((route.amountOut * 10n ** BigInt(tokenIn.decimals) * E18) / (amountIn * 10n ** BigInt(tokenOut.decimals)), 18, 6)
    : null;

  return (
    <div className="dx-swap-layout">
      <section className="dx-card dx-swap">
        <header className="dx-card__head">
          <h2>스왑</h2>
          <button type="button" className="dx-chip-button" onClick={() => setSettingsOpen(true)} aria-label="슬리피지 설정">
            슬리피지 {slippage}%
          </button>
        </header>

        <AmountBox
          label="보내는 토큰"
          value={amountText}
          onChange={(value) => { setAmountText(value); setRouteIndex(0); }}
          token={tokenIn}
          onPickToken={() => setPicker('in')}
          balance={balanceIn}
          onMax={spendable ? () => setAmountText(toInputString(spendable, tokenIn.decimals, 6)) : undefined}
          invalid={insufficient}
          note={tokenIn.native ? '네이티브 MON은 스왑 전에 WMON으로 래핑됩니다. 가스용 0.25 MON은 남겨둡니다.' : undefined}
        />
        <div className="dx-flip">
          <button type="button" onClick={flip} aria-label="방향 바꾸기">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2v11M5 13l-3-3M5 13l3-3M11 14V3M11 3 8 6M11 3l3 3" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
          </button>
        </div>
        <AmountBox
          label="받는 토큰 (예상)"
          value={amountOut && tokenOut ? formatAmount(amountOut, tokenOut.decimals, 8).replace(/,/g, '') : ''}
          token={tokenOut}
          onPickToken={() => setPicker('out')}
          balance={balanceOut}
          readOnly
          note={tokenOut?.native && !wrapOnly ? '받은 WMON은 자동으로 MON으로 언래핑됩니다.' : undefined}
        />

        {route && tokenOut && amountIn && (
          <div className="dx-details">
            <Row label="환율">1 {tokenIn.symbol} ≈ {rate} {tokenOut.symbol}</Row>
            <Row label="최소 수령 (슬리피지 적용)">{formatAmount(minOut, tokenOut.decimals)} {tokenOut.symbol}</Row>
            <Row label="가격 영향"><span className={impactBps > 300n ? 'dx-tone-down' : ''}>{impactBps < 1n ? '<0.01%' : formatBps(impactBps)}</span></Row>
            <Row label="경로">
              <span className="dx-route">
                {route.tokens.map((address, index) => (
                  <span key={`${address}-${index}`} className="dx-route__hop">
                    {index > 0 && <em>{formatPpm(route.pools[index - 1].feePpm)}</em>}
                    {ctx.tokenFor(address)?.symbol ?? '?'}
                  </span>
                ))}
              </span>
            </Row>
            {routes.length > 1 && (
              <details className="dx-route-alt">
                <summary>다른 경로 {routes.length - 1}개</summary>
                {routes.map((candidate, index) => (
                  <button key={index} type="button" className={index === routeIndex ? 'is-active' : ''} onClick={() => setRouteIndex(index)}>
                    <span>{candidate.tokens.map((address) => ctx.tokenFor(address)?.symbol ?? '?').join(' → ')}</span>
                    <span>{candidate.pools.map((pool) => formatPpm(pool.feePpm)).join(' + ')}</span>
                    <strong>{formatAmount(candidate.amountOut, tokenOut.decimals)}</strong>
                  </button>
                ))}
              </details>
            )}
            <p className="dx-fine">DexRouter로 실행되며 20분 데드라인이 걸립니다. 스왑 직후 풀이 페어 오더북을 자동 매칭할 수 있습니다.</p>
          </div>
        )}
        {currentQuote?.error && <p className="dx-error-text">{currentQuote.error}</p>}

        <button type="button" className="dx-button dx-button--solid dx-button--block" disabled={disabled} onClick={() => void submit()}>
          {ctx.busy ?? cta}
        </button>
      </section>

      <MarketsPanel ctx={ctx} onPick={(pair) => { setTokenIn(pair.base); setTokenOut(pair.quote); setRouteIndex(0); }} />

      {picker && (
        <TokenSelectModal
          tokens={ctx.withNative}
          balances={ctx.balances}
          onSelect={choose}
          onImport={ctx.importToken}
          onClose={() => setPicker(null)}
        />
      )}
      {settingsOpen && (
        <Modal title="슬리피지 허용치" onClose={() => setSettingsOpen(false)}>
          <div className="dx-chips dx-chips--wide">
            {SLIPPAGE_PRESETS.map((preset) => (
              <button key={preset} type="button" className={slippage === preset ? 'is-active' : ''} onClick={() => {
                setSlippage(preset);
                try { window.localStorage.setItem(SLIPPAGE_KEY, preset); } catch { /* per-visit only */ }
              }}>{preset}%</button>
            ))}
          </div>
          <label className="dx-field">
            <span>직접 입력 (%)</span>
            <input className="dx-input" inputMode="decimal" value={slippage} onChange={(event) => {
              setSlippage(event.target.value);
              if (parseSlippageBps(event.target.value) !== null) {
                try { window.localStorage.setItem(SLIPPAGE_KEY, event.target.value); } catch { /* per-visit only */ }
              }
            }} />
          </label>
          {parseSlippageBps(slippage) === null && <p className="dx-error-text">0 ~ 50% 사이 숫자를 입력하세요.</p>}
          <p className="dx-fine">가격이 이 비율보다 불리하게 움직이면 스왑이 되돌려집니다.</p>
        </Modal>
      )}
    </div>
  );
}

function pairTvlNote(pair: PairInfo): string {
  const pools = pair.spotPools.filter((pool) => pool.reserve0 > 0n);
  if (pools.length === 0) return '유동성 없음';
  const reserve0 = pools.reduce((sum, pool) => sum + pool.reserve0, 0n);
  const reserve1 = pools.reduce((sum, pool) => sum + pool.reserve1, 0n);
  return `${formatAmount(reserve0, pair.base.decimals, 4)} ${pair.base.symbol} · ${formatAmount(reserve1, pair.quote.decimals, 4)} ${pair.quote.symbol}`;
}

function MarketsPanel({ ctx, onPick }: { ctx: DexCtx; onPick: (pair: PairInfo) => void }) {
  return (
    <aside className="dx-card dx-markets">
      <header className="dx-card__head">
        <h2>마켓</h2>
        <span className="dx-muted">{ctx.marketsLoading && ctx.pairs.length === 0 ? '불러오는 중…' : `${ctx.pairs.length}개 페어`}</span>
      </header>
      {ctx.pairs.length === 0 && !ctx.marketsLoading && (
        <Empty title="등록된 페어가 없습니다">유동성 탭에서 첫 풀을 만들 수 있어요.</Empty>
      )}
      <ul className="dx-market-list">
        {ctx.pairs.map((pair) => {
          const mid = pairMidX18(pair);
          return (
            <li key={pair.address}>
              <button type="button" onClick={() => onPick(pair)}>
                <PairIcons a={pair.base} b={pair.quote} size={22} />
                <span className="dx-market-list__name">
                  <strong>{pair.base.symbol}/{pair.quote.symbol}</strong>
                  <small>{pairTvlNote(pair)}</small>
                </span>
                <span className="dx-market-list__price">
                  <strong>{formatPriceX18(mid, pair.base.decimals, pair.quote.decimals)}</strong>
                  <small>{pair.spotPools.length}풀{pair.perpPools.length ? ` · 선물 ${pair.perpPools.length}` : ''}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="dx-fine"><TokenIcon token={MON} size={14} /> 가격은 가장 깊은 현물 풀 기준 (quote / base).</p>
    </aside>
  );
}
