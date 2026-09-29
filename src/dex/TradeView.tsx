import { useMemo, useState } from 'react';
import { MON_NATIVE_GAS_RESERVE } from '../chain.ts';
import { cancelOrder, matchOrders, placeOrder } from './actions.ts';
import { KEEPER_MAX_FILLS, LIMITS, sameAddress, type TokenInfo } from './config.ts';
import { approvalSteps, balanceOf, wrapFor, type DexCtx } from './context.ts';
import { useNow, usePolled } from './hooks.ts';
import {
  E18,
  buyEscrow,
  formatAmount,
  formatPriceX18,
  parseAmount,
  parsePriceToX18,
  priceX18ToHumanE18,
  quoteNotional,
  ratioPct,
  snapPriceToGrid,
  toInputString,
  formatFixed,
  nowSeconds,
} from './math.ts';
import { pairMidX18, readBook, readMyOrders, type BookLevel, type Order, type PairInfo } from './reads.ts';
import { AddressLink, AmountBox, Empty, Notice, PairIcons, Row, Segmented } from './ui.tsx';

const EXPIRY_PRESETS = [
  { seconds: 3600, label: '1시간' },
  { seconds: 86_400, label: '1일' },
  { seconds: 604_800, label: '7일' },
  { seconds: 2_592_000, label: '30일' },
];

function humanPriceInput(priceX18: bigint, pair: PairInfo): string {
  return formatFixed(priceX18ToHumanE18(priceX18, pair.base.decimals, pair.quote.decimals), 18, 10).replace(/,/g, '');
}

/**
 * The best active level the new one can be linked after, so `placeOrder`
 * starts its walk there instead of at the top of the book. Zero means
 * "walk from the best", which is always correct, just costlier.
 */
function priceHint(levels: BookLevel[], side: 'buy' | 'sell', priceX18: bigint): bigint {
  let hint = 0n;
  for (const level of levels) {
    const atOrBetter = side === 'buy' ? level.priceX18 >= priceX18 : level.priceX18 <= priceX18;
    if (atOrBetter) hint = level.priceX18;
  }
  return hint;
}

export default function TradeView({ ctx, pairAddress, onPair }: { ctx: DexCtx; pairAddress: string | null; onPair: (pair: string) => void }) {
  const pair = ctx.pairs.find((entry) => sameAddress(entry.address, pairAddress)) ?? ctx.pairs[0] ?? null;

  if (!pair) {
    return (
      <section className="dx-card">
        {ctx.marketsLoading ? <Empty title="마켓을 불러오는 중…" /> : <Empty title="거래할 페어가 없습니다">유동성 탭에서 페어와 풀을 먼저 만들어 주세요.</Empty>}
      </section>
    );
  }
  return <TradeMarket key={pair.address} ctx={ctx} pair={pair} onPair={onPair} />;
}

function TradeMarket({ ctx, pair, onPair }: { ctx: DexCtx; pair: PairInfo; onPair: (pair: string) => void }) {
  const now = useNow();
  const book = usePolled(`book:${pair.address}`, (signal) => readBook(pair.address, 14, signal), ctx.refreshSignal);
  const orders = usePolled(ctx.account ? `orders:${pair.address}:${ctx.account}` : null, (signal) => readMyOrders(pair.address, ctx.account!, 40, signal), ctx.refreshSignal);

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [priceText, setPriceText] = useState('');
  const [amountText, setAmountText] = useState('');
  const [expiry, setExpiry] = useState(86_400);
  const [showClosed, setShowClosed] = useState(false);

  const { base, quote } = pair;
  const mid = pairMidX18(pair);
  const rawPrice = parsePriceToX18(priceText, base.decimals, quote.decimals);
  const priceX18 = rawPrice ? snapPriceToGrid(rawPrice, side === 'buy' ? 'down' : 'up') : null;
  const snapped = rawPrice !== null && priceX18 !== null && rawPrice !== priceX18;
  const amountBase = parseAmount(amountText, base.decimals);
  const escrowToken: TokenInfo = side === 'buy' ? quote : base;
  const escrow = priceX18 && amountBase ? (side === 'buy' ? buyEscrow(amountBase, priceX18) : amountBase) : null;
  const notional = priceX18 && amountBase ? quoteNotional(amountBase, priceX18) : null;
  const tooSmall = notional !== null && notional < LIMITS.minQuoteNotional;
  const escrowBalance = balanceOf(ctx, escrowToken);
  const wrapPlan = escrow !== null && escrowBalance !== null ? wrapFor(escrowToken, escrow, escrowBalance, ctx.nativeBalance, MON_NATIVE_GAS_RESERVE) : [];
  const insufficient = escrow !== null && escrowBalance !== null && wrapPlan === null;

  const bids = useMemo(() => book.data?.bids ?? [], [book.data]);
  const asks = useMemo(() => book.data?.asks ?? [], [book.data]);
  const bestBid = book.data?.bestBid ?? 0n;
  const bestAsk = book.data?.bestAsk ?? 0n;
  const crossed = bestBid > 0n && bestAsk > 0n && bestBid >= bestAsk;
  const maxLevel = useMemo(() => [...bids, ...asks].reduce((max, level) => (level.totalBase > max ? level.totalBase : max), 1n), [bids, asks]);

  // A limit that already crosses the pool or the opposite side fills (partly) on the next match.
  const marketable = priceX18 !== null && amountBase !== null && ((side === 'buy' && ((bestAsk > 0n && priceX18 >= bestAsk) || (mid !== null && priceX18 > mid))) ||
    (side === 'sell' && ((bestBid > 0n && priceX18 <= bestBid) || (mid !== null && priceX18 < mid))));

  const fillFromBalance = (pct: bigint) => {
    if (side === 'sell') {
      const balance = balanceOf(ctx, base);
      if (balance) setAmountText(toInputString((balance * pct) / 100n, base.decimals, 8));
    } else if (priceX18) {
      const balance = balanceOf(ctx, quote);
      if (balance) setAmountText(toInputString(((balance * pct) / 100n) * E18 / priceX18, base.decimals, 8));
    }
  };

  const submit = async () => {
    if (!ctx.account) {
      await ctx.wallet.connect();
      return;
    }
    if (!priceX18 || !amountBase || escrow === null || wrapPlan === null) return;
    const account = ctx.account;
    const hint = priceHint(side === 'buy' ? bids : asks, side, priceX18);
    const expiryTs = nowSeconds() + BigInt(expiry);
    const ok = await ctx.run(side === 'buy' ? '매수 주문' : '매도 주문', [
      ...wrapPlan,
      ...approvalSteps(account, [{ token: escrowToken, spender: pair.address, amount: escrow }]),
      placeOrder(pair.address, side, priceX18, amountBase, expiryTs, hint),
    ]);
    if (ok) setAmountText('');
  };

  let cta = side === 'buy' ? `${base.symbol} 매수 주문` : `${base.symbol} 매도 주문`;
  let disabled = false;
  if (!ctx.account) cta = '지갑 연결';
  else if (ctx.paused) { cta = 'DEX 일시정지 중'; disabled = true; }
  else if (!priceX18) { cta = '가격 입력'; disabled = true; }
  else if (!amountBase) { cta = '수량 입력'; disabled = true; }
  else if (tooSmall) { cta = '주문 금액이 너무 작습니다'; disabled = true; }
  else if (insufficient) { cta = `${escrowToken.symbol} 잔액 부족`; disabled = true; }
  if (ctx.busy) disabled = true;

  const myOrders = orders.data ?? [];
  const openOrders = myOrders.filter((order) => order.status === 'open');
  const visibleOrders = showClosed ? myOrders : openOrders;

  return (
    <div className="dx-trade-layout">
      <section className="dx-card dx-book">
        <header className="dx-card__head">
          <label className="dx-pair-select">
            <PairIcons a={base} b={quote} size={22} />
            <select value={pair.address} onChange={(event) => onPair(event.target.value)} aria-label="페어 선택">
              {ctx.pairs.map((entry) => <option key={entry.address} value={entry.address}>{entry.base.symbol}/{entry.quote.symbol}</option>)}
            </select>
          </label>
          <span className="dx-muted">가격 = {quote.symbol} / {base.symbol}</span>
        </header>

        <div className="dx-book__cols"><span>가격 ({quote.symbol})</span><span>수량 ({base.symbol})</span></div>
        <div className="dx-book__side dx-book__side--asks">
          {asks.length === 0 && <p className="dx-book__empty">매도 호가 없음</p>}
          {[...asks].reverse().map((level) => (
            <BookRow key={`a${level.priceX18}`} level={level} pair={pair} max={maxLevel} tone="down" onPick={() => { setPriceText(humanPriceInput(level.priceX18, pair)); setSide('buy'); }} />
          ))}
        </div>
        <div className={`dx-book__mid${crossed ? ' is-crossed' : ''}`}>
          <span>
            <small>AMM</small>
            <strong>{formatPriceX18(mid, base.decimals, quote.decimals)}</strong>
          </span>
          <span className="dx-muted">
            {bestBid > 0n && bestAsk > 0n
              ? crossed ? '호가 교차됨' : `스프레드 ${ratioPct(bestAsk - bestBid, bestAsk)}`
              : '호가 한쪽 비어 있음'}
          </span>
          {crossed && (
            <button type="button" className="dx-button dx-button--ghost dx-button--sm" disabled={!!ctx.busy || ctx.paused}
              onClick={() => void ctx.run('호가 매칭', [matchOrders(pair.address, BigInt(KEEPER_MAX_FILLS))])}>
              매칭 실행
            </button>
          )}
        </div>
        <div className="dx-book__side dx-book__side--bids">
          {bids.length === 0 && <p className="dx-book__empty">매수 호가 없음</p>}
          {bids.map((level) => (
            <BookRow key={`b${level.priceX18}`} level={level} pair={pair} max={maxLevel} tone="up" onPick={() => { setPriceText(humanPriceInput(level.priceX18, pair)); setSide('sell'); }} />
          ))}
        </div>
        <p className="dx-fine">
          호가창은 <AddressLink address={pair.address} label="Pair 컨트랙트" />에 온체인으로 저장됩니다. 교차된 주문끼리는 두 지정가의 중간값에 수수료 없이 체결되고,
          현물 풀이 더 유리하면 풀에서 먼저 체결됩니다.
        </p>
      </section>

      <section className="dx-card dx-order-form">
        <Segmented value={side} onChange={setSide} options={[{ value: 'buy', label: `${base.symbol} 매수`, tone: 'up' }, { value: 'sell', label: `${base.symbol} 매도`, tone: 'down' }]} />
        <label className="dx-field">
          <span>지정가 ({quote.symbol} / 1 {base.symbol})</span>
          <div className="dx-input-group">
            <input className="dx-input" inputMode="decimal" placeholder="0.0" value={priceText} onChange={(event) => setPriceText(event.target.value.replace(/[^\d.]/g, ''))} />
            {mid && <button type="button" onClick={() => setPriceText(humanPriceInput(mid, pair))}>AMM</button>}
          </div>
          {snapped && priceX18 && (
            <small className="dx-hint">유효숫자 6자리 그리드에 맞춰 {formatPriceX18(priceX18, base.decimals, quote.decimals, 8)}로 {side === 'buy' ? '내림' : '올림'}됩니다.</small>
          )}
        </label>
        <AmountBox
          label={`수량 (${base.symbol})`}
          value={amountText}
          onChange={setAmountText}
          token={base}
          balance={side === 'sell' ? balanceOf(ctx, base) : undefined}
          onMax={side === 'sell' ? () => fillFromBalance(100n) : undefined}
        />
        <div className="dx-chips">
          {[25n, 50n, 75n, 100n].map((pct) => <button key={pct.toString()} type="button" onClick={() => fillFromBalance(pct)}>{pct.toString()}%</button>)}
        </div>
        <div className="dx-field">
          <span>만료</span>
          <div className="dx-chips dx-chips--wide">
            {EXPIRY_PRESETS.map((preset) => (
              <button key={preset.seconds} type="button" className={expiry === preset.seconds ? 'is-active' : ''} onClick={() => setExpiry(preset.seconds)}>{preset.label}</button>
            ))}
          </div>
        </div>
        <div className="dx-details">
          <Row label="에스크로">{escrow !== null ? `${formatAmount(escrow, escrowToken.decimals)} ${escrowToken.symbol}` : '—'}</Row>
          <Row label="주문 금액">{notional !== null ? `${formatAmount(notional, quote.decimals)} ${quote.symbol}` : '—'}</Row>
          <Row label={`보유 ${escrowToken.symbol}`}>{formatAmount(escrowBalance, escrowToken.decimals)}</Row>
          {wrapPlan && wrapPlan.length > 0 && <Row label="자동 래핑">부족분을 MON에서 래핑합니다</Row>}
        </div>
        {marketable && <Notice tone="warn">현재 시장가보다 유리한 지정가라 다음 매칭에서 즉시(일부) 체결될 수 있습니다.</Notice>}
        {tooSmall && <Notice tone="error">주문 금액이 최소 기준(원시 단위 {LIMITS.minQuoteNotional.toString()})보다 작습니다.</Notice>}
        <button type="button" className={`dx-button dx-button--solid dx-button--block${side === 'sell' ? ' dx-button--sell' : ''}`} disabled={disabled} onClick={() => void submit()}>
          {ctx.busy ?? cta}
        </button>
        <p className="dx-fine">주문은 에스크로가 Pair로 이동한 상태로 대기합니다. 언제든 취소하면 남은 에스크로가 돌아옵니다(일시정지 중에도 가능).</p>
      </section>

      <section className="dx-card dx-my-orders">
        <header className="dx-card__head">
          <h2>내 주문 <span className="dx-muted">({openOrders.length} 대기)</span></h2>
          <label className="dx-toggle"><input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} /> 종료된 주문 포함</label>
        </header>
        {!ctx.account && <Empty title="지갑을 연결하면 주문 내역이 보입니다" />}
        {ctx.account && visibleOrders.length === 0 && <Empty title={orders.loading ? '불러오는 중…' : '표시할 주문이 없습니다'} />}
        {visibleOrders.length > 0 && (
          <div className="dx-table-wrap">
            <table className="dx-table">
              <thead><tr><th>#</th><th>구분</th><th>가격</th><th>수량</th><th>체결</th><th>상태</th><th>만료</th><th /></tr></thead>
              <tbody>
                {visibleOrders.map((order) => <OrderRow key={order.id.toString()} order={order} pair={pair} ctx={ctx} now={now} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function BookRow({ level, pair, max, tone, onPick }: { level: BookLevel; pair: PairInfo; max: bigint; tone: 'up' | 'down'; onPick: () => void }) {
  const width = Number((level.totalBase * 1000n) / max) / 10;
  return (
    <button type="button" className={`dx-book__row dx-tone-${tone}`} onClick={onPick}>
      <i style={{ width: `${width}%` }} aria-hidden="true" />
      <span>{formatPriceX18(level.priceX18, pair.base.decimals, pair.quote.decimals)}</span>
      <span>{formatAmount(level.totalBase, pair.base.decimals)}</span>
    </button>
  );
}

const STATUS_LABEL: Record<Order['status'], string> = { open: '대기', filled: '체결', cancelled: '취소', expired: '만료' };

function OrderRow({ order, pair, ctx, now }: { order: Order; pair: PairInfo; ctx: DexCtx; now: bigint }) {
  const expired = order.status === 'open' && order.expiry <= now;
  const remaining = order.expiry > now ? order.expiry - now : 0n;
  const left = remaining > 86_400n ? `${remaining / 86_400n}일` : remaining > 3600n ? `${remaining / 3600n}시간` : `${remaining / 60n}분`;
  return (
    <tr>
      <td>{order.id.toString()}</td>
      <td className={order.side === 'buy' ? 'dx-tone-up' : 'dx-tone-down'}>{order.side === 'buy' ? '매수' : '매도'}</td>
      <td>{formatPriceX18(order.priceX18, pair.base.decimals, pair.quote.decimals)}</td>
      <td>{formatAmount(order.amountBase, pair.base.decimals)}</td>
      <td>{ratioPct(order.filledBase, order.amountBase, 1)}</td>
      <td>{expired ? '만료됨' : STATUS_LABEL[order.status]}</td>
      <td>{order.status === 'open' ? (expired ? '—' : left) : '—'}</td>
      <td>
        {order.status === 'open' && (
          <button type="button" className="dx-link-button" disabled={!!ctx.busy} onClick={() => void ctx.run('주문 취소', [cancelOrder(pair.address, order.id)])}>
            {expired ? '회수' : '취소'}
          </button>
        )}
      </td>
    </tr>
  );
}
