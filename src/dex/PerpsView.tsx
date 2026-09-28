import { useMemo, useState } from 'react';
import { MON_NATIVE_GAS_RESERVE } from '../chain.ts';
import { addMargin, createPerpPool, decreasePosition, openPosition, pokeMark, removeMargin } from './actions.ts';
import { LIMITS, sameAddress } from './config.ts';
import { approvalSteps, balanceOf, wrapFor, type DexCtx } from './context.ts';
import { useNow, usePolled } from './hooks.ts';
import { BPS, E18, PPM, formatAmount, formatBps, formatPpm, formatPriceX18, parseAmount, ratioPct, toInputString } from './math.ts';
import { readPerpMarkets, type PairInfo, type PerpMarket, type PerpSide } from './reads.ts';
import { PerpLpModal } from './PoolsView.tsx';
import { AddressLink, AmountBox, Empty, Modal, Notice, PairIcons, Row, Segmented, Stat } from './ui.tsx';

/** Price at which equity meets maintenance, from `_belowMaintenance`. Null when it cannot be hit. */
function liquidationPriceX18(isLong: boolean, sizeBase: bigint, entryNotional: bigint, margin: bigint, mmBps: bigint): bigint | null {
  if (sizeBase === 0n) return null;
  if (isLong) {
    if (entryNotional <= margin) return null;
    return ((entryNotional - margin) * E18 * BPS) / (sizeBase * (BPS - mmBps));
  }
  return ((margin + entryNotional) * E18 * BPS) / (sizeBase * (BPS + mmBps));
}

function markAge(market: PerpMarket, now: bigint): bigint {
  return market.twapTsCheckpoint > 0n && now > market.twapTsCheckpoint ? now - market.twapTsCheckpoint : 0n;
}

export default function PerpsView({ ctx }: { ctx: DexCtx }) {
  const pools = useMemo(() => ctx.pairs.flatMap((pair) => pair.perpPools), [ctx.pairs]);
  const key = pools.length > 0 ? `perps:${pools.join(',')}:${ctx.account ?? ''}` : null;
  const markets = usePolled(key, (signal) => readPerpMarkets(pools, ctx.account, signal), ctx.refreshSignal);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = markets.data ?? [];
  const market = list.find((entry) => sameAddress(entry.address, selected)) ?? list[0] ?? null;

  return (
    <div className="dx-perps">
      <header className="dx-hero dx-hero--compact">
        <div>
          <h2>무기한 선물</h2>
          <p>현물 풀 TWAP을 마크 가격으로 쓰는 격리 마진 선물입니다. 단측 LP 금고가 모든 포지션의 상대방이 됩니다.</p>
        </div>
        <div className="dx-hero__actions">
          <button type="button" className="dx-button dx-button--ghost" disabled={ctx.paused || ctx.pairs.length === 0} onClick={() => setCreating(true)}>+ 선물 시장 만들기</button>
        </div>
      </header>

      {pools.length === 0 && (
        <section className="dx-card"><Empty title={ctx.marketsLoading ? '마켓을 불러오는 중…' : '열린 선물 시장이 없습니다'}>현물 풀이 있는 페어에서 선물 시장을 만들 수 있습니다.</Empty></section>
      )}
      {pools.length > 0 && !market && <section className="dx-card"><Empty title="선물 시장을 불러오는 중…" /></section>}

      {market && (
        <>
          <div className="dx-perp-tabs">
            {list.map((entry) => (
              <button key={entry.address} type="button" className={entry.address === market.address ? 'is-active' : ''} onClick={() => setSelected(entry.address)}>
                <PairIcons a={entry.base} b={entry.quote} size={18} />
                {entry.base.symbol}-PERP <small>{entry.quote.symbol} 마진 · {formatPpm(entry.feePpm)}</small>
              </button>
            ))}
          </div>
          <PerpMarketView key={market.address} ctx={ctx} market={market} />
        </>
      )}
      {creating && <CreatePerpModal ctx={ctx} onClose={() => setCreating(false)} />}
    </div>
  );
}

function PerpMarketView({ ctx, market }: { ctx: DexCtx; market: PerpMarket }) {
  const now = useNow();
  const { base, quote } = market;
  const age = markAge(market, now);
  const stale = market.markX18 === 0n || age > BigInt(LIMITS.maxTwapWindow);
  const longNotional = (market.longSizeBase * market.markX18) / E18;
  const shortNotional = (market.shortSizeBase * market.markX18) / E18;
  const capNotional = (market.lpEquity * market.maxUtilizationBps) / BPS;
  const [lpOpen, setLpOpen] = useState(false);

  return (
    <div className="dx-perp-layout">
      <section className="dx-card dx-perp-stats">
        <div className="dx-stat-grid">
          <Stat label="마크 가격 (TWAP)" value={market.markX18 > 0n ? formatPriceX18(market.markX18, base.decimals, quote.decimals) : '준비 안됨'}
            sub={market.markX18 > 0n ? `${quote.symbol} · ${age.toString()}초 전 갱신` : '5분 TWAP 창이 필요합니다'} tone={stale ? 'warn' : undefined} />
          <Stat label="롱 미결제약정" value={`${formatAmount(longNotional, quote.decimals, 5)}`} sub={`한도 ${formatAmount(capNotional, quote.decimals, 5)} ${quote.symbol}`} tone="up" />
          <Stat label="숏 미결제약정" value={`${formatAmount(shortNotional, quote.decimals, 5)}`} sub={`한도 ${formatAmount(capNotional, quote.decimals, 5)} ${quote.symbol}`} tone="down" />
          <Stat label="LP 금고" value={`${formatAmount(market.lpEquity, quote.decimals, 5)}`} sub={quote.symbol} />
          <Stat label="최대 레버리지" value={`${market.maxLeverageX.toString()}x`} sub={`유지증거금 ${formatBps(market.maintenanceMarginBps)}`} />
          <Stat label="거래 수수료" value={formatPpm(market.feePpm)} sub={`펀딩 계수 ${formatPpm(market.fundingCoeffPpmPerHour)}/h`} />
        </div>
        {stale && (
          <Notice tone="warn">
            마크가 {market.markX18 === 0n ? '아직 없습니다' : '1시간 넘게 갱신되지 않았습니다'}. 갱신하면 새 TWAP 창이 열리고 5분 뒤부터 거래할 수 있습니다.
          </Notice>
        )}
        <div className="dx-inline-actions">
          <button type="button" className="dx-button dx-button--ghost dx-button--sm" disabled={!!ctx.busy} onClick={() => void ctx.run('마크 갱신', [pokeMark(market.address)])}>마크 갱신</button>
          <button type="button" className="dx-button dx-button--ghost dx-button--sm" disabled={ctx.paused} onClick={() => setLpOpen(true)}>LP 금고 예치</button>
          <AddressLink address={market.address} label="선물 풀" />
          <AddressLink address={market.spotPool} label="마크 소스 현물 풀" />
        </div>
      </section>

      {lpOpen && <PerpLpModal ctx={ctx} pool={market.address} position={null} onClose={() => setLpOpen(false)} />}
      <OpenPositionCard ctx={ctx} market={market} stale={stale} />

      <section className="dx-card dx-perp-positions">
        <header className="dx-card__head"><h2>내 포지션</h2></header>
        {!ctx.account && <Empty title="지갑을 연결하면 포지션이 보입니다" />}
        {ctx.account && !market.long && !market.short && <Empty title="열린 포지션이 없습니다" />}
        {market.long && <PositionPanel ctx={ctx} market={market} side={market.long} isLong />}
        {market.short && <PositionPanel ctx={ctx} market={market} side={market.short} isLong={false} />}
        <p className="dx-fine">포지션 축소·청산과 증거금 인출은 DEX가 일시정지돼도 가능합니다. 청산(강제)은 정지 중 차단됩니다.</p>
      </section>
    </div>
  );
}

function OpenPositionCard({ ctx, market, stale }: { ctx: DexCtx; market: PerpMarket; stale: boolean }) {
  const { base, quote } = market;
  const [isLong, setIsLong] = useState(true);
  const [marginText, setMarginText] = useState('');
  const [leverage, setLeverage] = useState(2);
  const margin = parseAmount(marginText, quote.decimals);
  const mark = market.markX18;
  const maxLev = Number(market.maxLeverageX);
  // openPosition requires size·mark ≤ (margin − fee)·maxLeverage, and the fee grows with size.
  const effectiveMax = maxLev / (1 + (maxLev * Number(market.feePpm)) / 1e6);
  const notional = margin ? (margin * BigInt(Math.round(leverage * 100))) / 100n : null;
  const sizeBase = notional && mark > 0n ? (notional * E18) / mark : null;
  const fee = notional ? (notional * market.feePpm) / PPM : null;
  const marginAfterFee = margin && fee !== null ? margin - fee : null;
  const liq = sizeBase && notional && marginAfterFee !== null
    ? liquidationPriceX18(isLong, sizeBase, notional, marginAfterFee, market.maintenanceMarginBps)
    : null;
  const balance = balanceOf(ctx, quote);
  const plan = margin !== null ? wrapFor(quote, margin, balance ?? 0n, ctx.nativeBalance, MON_NATIVE_GAS_RESERVE) : [];
  const sideNotional = ((isLong ? market.longSizeBase : market.shortSizeBase) * mark) / E18 + (notional ?? 0n);
  const overCap = notional !== null && sideNotional > (market.lpEquity * market.maxUtilizationBps) / BPS;

  const submit = async () => {
    if (!ctx.account) {
      await ctx.wallet.connect();
      return;
    }
    if (!margin || !sizeBase || plan === null) return;
    const account = ctx.account;
    const ok = await ctx.run(isLong ? '롱 진입' : '숏 진입', [
      ...plan,
      ...approvalSteps(account, [{ token: quote, spender: market.address, amount: margin }]),
      openPosition(market.address, isLong, margin, sizeBase),
    ]);
    if (ok) setMarginText('');
  };

  let cta = isLong ? `${base.symbol} 롱` : `${base.symbol} 숏`;
  let disabled = false;
  if (!ctx.account) cta = '지갑 연결';
  else if (ctx.paused) { cta = 'DEX 일시정지 중'; disabled = true; }
  else if (mark === 0n) { cta = '마크 가격 준비 안됨'; disabled = true; }
  else if (!margin) { cta = '증거금 입력'; disabled = true; }
  else if (plan === null) { cta = `${quote.symbol} 잔액 부족`; disabled = true; }
  else if (leverage > effectiveMax) { cta = '레버리지 초과'; disabled = true; }
  else if (overCap) { cta = '미결제약정 한도 초과'; disabled = true; }
  if (ctx.busy) disabled = true;

  return (
    <section className="dx-card dx-perp-order">
      <Segmented value={isLong ? 'long' : 'short'} onChange={(value) => setIsLong(value === 'long')}
        options={[{ value: 'long', label: '롱', tone: 'up' }, { value: 'short', label: '숏', tone: 'down' }]} />
      <AmountBox label={`증거금 (${quote.symbol})`} value={marginText} onChange={setMarginText} token={quote} balance={balance}
        onMax={() => { if (balance) setMarginText(toInputString(balance, quote.decimals, 6)); }} invalid={plan === null} />
      <div className="dx-field">
        <span className="dx-field__row"><span>레버리지</span><strong>{leverage.toFixed(1)}x</strong></span>
        <input type="range" min={1} max={Math.max(1, Math.floor(effectiveMax * 10) / 10)} step={0.1} value={leverage} onChange={(event) => setLeverage(Number(event.target.value))} aria-label="레버리지" />
        <div className="dx-chips">
          {[1, 2, 5, 10, 20, 50].filter((value) => value <= effectiveMax).map((value) => (
            <button key={value} type="button" className={leverage === value ? 'is-active' : ''} onClick={() => setLeverage(value)}>{value}x</button>
          ))}
        </div>
      </div>
      <div className="dx-details">
        <Row label="포지션 크기">{sizeBase ? `${formatAmount(sizeBase, base.decimals)} ${base.symbol}` : '—'}</Row>
        <Row label="명목가">{notional ? `${formatAmount(notional, quote.decimals)} ${quote.symbol}` : '—'}</Row>
        <Row label="진입 수수료">{fee !== null ? `${formatAmount(fee, quote.decimals)} ${quote.symbol}` : '—'}</Row>
        <Row label="예상 청산가">{liq ? formatPriceX18(liq, base.decimals, quote.decimals) : '—'}</Row>
      </div>
      {stale && mark > 0n && <Notice tone="warn">마크가 오래되어 이 거래에서 초기화되면 MarkNotReady로 실패합니다. 먼저 마크를 갱신하세요.</Notice>}
      <button type="button" className={`dx-button dx-button--solid dx-button--block${isLong ? '' : ' dx-button--sell'}`} disabled={disabled} onClick={() => void submit()}>
        {ctx.busy ?? cta}
      </button>
      <p className="dx-fine">체결가는 트랜잭션 시점의 TWAP 마크입니다. 무거운 쪽이 LP 금고에 펀딩을 지불합니다.</p>
    </section>
  );
}

function PositionPanel({ ctx, market, side, isLong }: { ctx: DexCtx; market: PerpMarket; side: PerpSide; isLong: boolean }) {
  const { base, quote } = market;
  const [mode, setMode] = useState<'close' | 'add' | 'remove'>('close');
  const [text, setText] = useState('');
  const mark = market.markX18;
  const entryPrice = (side.entryNotional * E18) / side.sizeBase;
  const pnl = side.equity - side.marginQuote;
  const notional = (side.sizeBase * mark) / E18;
  const liq = liquidationPriceX18(isLong, side.sizeBase, side.entryNotional, side.marginQuote, market.maintenanceMarginBps);
  const effLev = side.equity > 0n ? Number((notional * 100n) / side.equity) / 100 : null;
  const amount = parseAmount(text, mode === 'close' ? base.decimals : quote.decimals);

  const submit = async () => {
    if (!ctx.account || !amount) return;
    const account = ctx.account;
    if (mode === 'close') {
      await ctx.run('포지션 축소', [decreasePosition(market.address, isLong, amount > side.sizeBase ? side.sizeBase : amount)]);
    } else if (mode === 'add') {
      await ctx.run('증거금 추가', [...approvalSteps(account, [{ token: quote, spender: market.address, amount }]), addMargin(market.address, isLong, amount)]);
    } else {
      await ctx.run('증거금 인출', [removeMargin(market.address, isLong, amount)]);
    }
    setText('');
  };

  return (
    <article className="dx-perp-position">
      <header>
        <strong className={isLong ? 'dx-tone-up' : 'dx-tone-down'}>{isLong ? '롱' : '숏'} {formatAmount(side.sizeBase, base.decimals)} {base.symbol}</strong>
        <span className={pnl >= 0n ? 'dx-tone-up' : 'dx-tone-down'}>
          {pnl >= 0n ? '+' : ''}{formatAmount(pnl, quote.decimals)} {quote.symbol} ({side.marginQuote > 0n ? ratioPct(pnl, side.marginQuote, 1) : '—'})
        </span>
      </header>
      <dl>
        <div><dt>진입가</dt><dd>{formatPriceX18(entryPrice, base.decimals, quote.decimals)}</dd></div>
        <div><dt>마크</dt><dd>{formatPriceX18(mark, base.decimals, quote.decimals)}</dd></div>
        <div><dt>청산가</dt><dd>{liq ? formatPriceX18(liq, base.decimals, quote.decimals) : '—'}</dd></div>
        <div><dt>증거금</dt><dd>{formatAmount(side.marginQuote, quote.decimals)}</dd></div>
        <div><dt>자산 (펀딩 반영)</dt><dd>{formatAmount(side.equity, quote.decimals)}</dd></div>
        <div><dt>실효 레버리지</dt><dd>{effLev !== null ? `${effLev.toFixed(2)}x` : '—'}</dd></div>
      </dl>
      <Segmented size="sm" value={mode} onChange={(value) => { setMode(value); setText(''); }}
        options={[{ value: 'close', label: '축소/청산' }, { value: 'add', label: '증거금 추가' }, { value: 'remove', label: '증거금 인출' }]} />
      <div className="dx-input-group">
        <input className="dx-input" inputMode="decimal" placeholder={mode === 'close' ? `수량 (${base.symbol})` : `금액 (${quote.symbol})`} value={text} onChange={(event) => setText(event.target.value)} />
        {mode === 'close' && <button type="button" onClick={() => setText(toInputString(side.sizeBase, base.decimals, base.decimals))}>전량</button>}
        <button type="button" className="dx-input-group__go" disabled={!amount || !!ctx.busy || (mode === 'add' && ctx.paused)} onClick={() => void submit()}>실행</button>
      </div>
    </article>
  );
}

// ─────────────────── create ───────────────────

function CreatePerpModal({ ctx, onClose }: { ctx: DexCtx; onClose: () => void }) {
  const candidates = ctx.pairs.filter((pair) => pair.spotPools.length > 0);
  const [pairAddress, setPairAddress] = useState(candidates[0]?.address ?? '');
  const pair: PairInfo | null = candidates.find((entry) => entry.address === pairAddress) ?? null;
  const [spotPool, setSpotPool] = useState('');
  const [quoteIsQuote, setQuoteIsQuote] = useState(true);
  const [feePct, setFeePct] = useState('0.1');
  const [maxLev, setMaxLev] = useState('10');
  const [mmBps, setMmBps] = useState('500');
  const [liqBps, setLiqBps] = useState('100');
  const [utilBps, setUtilBps] = useState('8000');
  const [funding, setFunding] = useState('100');

  const pool = pair?.spotPools.find((entry) => entry.address === spotPool) ?? pair?.spotPools[0] ?? null;
  const quoteToken = pair ? (quoteIsQuote ? pair.quote : pair.base) : null;
  const num = (text: string) => (/^\d+$/.test(text.trim()) ? BigInt(text.trim()) : null);
  const feePpm = /^\d*(\.\d{0,4})?$/.test(feePct.trim()) && feePct.trim() !== '' ? BigInt(Math.round(Number(feePct) * 10_000)) : null;
  const params = { maxLeverageX: num(maxLev), maintenanceMarginBps: num(mmBps), liquidationFeeBps: num(liqBps), maxUtilizationBps: num(utilBps), fundingCoeffPpmPerHour: num(funding) };
  const errors: string[] = [];
  if (feePpm === null || feePpm < 1n || feePpm > 10_000n) errors.push('수수료는 0.0001% ~ 1% 입니다.');
  if (!params.maxLeverageX || params.maxLeverageX > BigInt(LIMITS.maxLeverageCap)) errors.push(`최대 레버리지는 1 ~ ${LIMITS.maxLeverageCap}x 입니다.`);
  if (params.maintenanceMarginBps === null || params.maintenanceMarginBps < BigInt(LIMITS.minMaintenanceBps) || params.maintenanceMarginBps > BigInt(LIMITS.maxMaintenanceBps)) errors.push('유지증거금은 100 ~ 2000 bps 입니다.');
  if (params.liquidationFeeBps === null || params.liquidationFeeBps > BigInt(LIMITS.maxLiquidationFeeBps)) errors.push('청산 수수료는 0 ~ 500 bps 입니다.');
  if (!params.maxUtilizationBps || params.maxUtilizationBps > 10_000n) errors.push('사용률 상한은 1 ~ 10000 bps 입니다.');
  if (params.fundingCoeffPpmPerHour === null || params.fundingCoeffPpmPerHour > BigInt(LIMITS.maxFundingCoeffPpmPerHour)) errors.push('펀딩 계수는 0 ~ 10000 ppm/h 입니다.');
  if (params.maxLeverageX && params.maintenanceMarginBps !== null && params.liquidationFeeBps !== null &&
    BPS / params.maxLeverageX <= params.maintenanceMarginBps + params.liquidationFeeBps) {
    errors.push('최대 레버리지의 초기증거금이 유지증거금 + 청산 수수료보다 커야 합니다 (열자마자 청산 방지).');
  }

  const submit = async () => {
    if (!pair || !pool || !quoteToken || feePpm === null || errors.length > 0) return;
    const ok = await ctx.run('선물 시장 생성', [createPerpPool(pair.address, quoteToken.address, pool.address, feePpm, {
      maxLeverageX: params.maxLeverageX!, maintenanceMarginBps: params.maintenanceMarginBps!, liquidationFeeBps: params.liquidationFeeBps!,
      maxUtilizationBps: params.maxUtilizationBps!, fundingCoeffPpmPerHour: params.fundingCoeffPpmPerHour!,
    })]);
    if (ok) onClose();
  };

  return (
    <Modal title="선물 시장 만들기" onClose={onClose} wide>
      {candidates.length === 0 ? <Empty title="현물 풀이 있는 페어가 필요합니다" /> : (
        <>
          <div className="dx-create-grid">
            <label className="dx-field"><span>페어</span>
              <select className="dx-input" value={pairAddress} onChange={(event) => { setPairAddress(event.target.value); setSpotPool(''); }}>
                {candidates.map((entry) => <option key={entry.address} value={entry.address}>{entry.base.symbol}/{entry.quote.symbol}</option>)}
              </select>
            </label>
            <label className="dx-field"><span>마크 소스 현물 풀</span>
              <select className="dx-input" value={pool?.address ?? ''} onChange={(event) => setSpotPool(event.target.value)}>
                {pair?.spotPools.map((entry) => <option key={entry.address} value={entry.address}>{formatPpm(entry.feePpm)} 풀</option>)}
              </select>
            </label>
            <div className="dx-field"><span>마진 토큰</span>
              {pair && <Segmented size="sm" value={quoteIsQuote ? 'q' : 'b'} onChange={(value) => setQuoteIsQuote(value === 'q')}
                options={[{ value: 'q', label: pair.quote.symbol }, { value: 'b', label: pair.base.symbol }]} />}
            </div>
            <label className="dx-field"><span>거래 수수료 (%)</span><input className="dx-input" value={feePct} onChange={(event) => setFeePct(event.target.value)} /></label>
            <label className="dx-field"><span>최대 레버리지 (x)</span><input className="dx-input" value={maxLev} onChange={(event) => setMaxLev(event.target.value)} /></label>
            <label className="dx-field"><span>유지증거금 (bps)</span><input className="dx-input" value={mmBps} onChange={(event) => setMmBps(event.target.value)} /></label>
            <label className="dx-field"><span>청산 수수료 (bps)</span><input className="dx-input" value={liqBps} onChange={(event) => setLiqBps(event.target.value)} /></label>
            <label className="dx-field"><span>방향별 사용률 상한 (bps)</span><input className="dx-input" value={utilBps} onChange={(event) => setUtilBps(event.target.value)} /></label>
            <label className="dx-field"><span>펀딩 계수 (ppm/h)</span><input className="dx-input" value={funding} onChange={(event) => setFunding(event.target.value)} /></label>
          </div>
          {errors.map((error) => <p key={error} className="dx-error-text">{error}</p>)}
          <p className="dx-fine">같은 마진 토큰 안에서는 수수료율당 하나의 선물 풀만 만들 수 있습니다. 생성 후 파라미터는 바꿀 수 없습니다.</p>
          <button type="button" className="dx-button dx-button--solid dx-button--block" disabled={errors.length > 0 || !!ctx.busy || ctx.paused} onClick={() => void submit()}>
            {ctx.busy ?? '선물 시장 생성'}
          </button>
        </>
      )}
    </Modal>
  );
}
