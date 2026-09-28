import { useState } from 'react';
import { MON_NATIVE_GAS_RESERVE, TOKENS } from '../chain.ts';
import { asAddress, asUint } from './abi.ts';
import {
  burnPosition,
  createPair,
  createSpotPool,
  decreasePerp,
  decreaseSpot,
  increasePerp,
  increaseSpot,
  mintPerp,
  mintSpot,
  unwrapMon,
} from './actions.ts';
import { DEFAULT_TOKENS, DEX, FEE_TIERS, LIMITS, sameAddress, type TokenInfo } from './config.ts';
import { approvalSteps, balanceOf, wrapFor, type DexCtx } from './context.ts';
import { usePolled } from './hooks.ts';
import {
  applySlippage,
  formatAmount,
  formatPpm,
  formatPriceX18,
  parseAmount,
  parseSlippageBps,
  ratioPct,
  reservePriceX18,
  toInputString,
} from './math.ts';
import { batch, call, readPairAddress, readPositions, type LpPosition, type PairInfo, type SpotPoolInfo } from './reads.ts';
import type { AnyStep, TxStep } from './useTxRunner.ts';
import { AddressLink, AmountBox, Empty, Modal, Notice, PairIcons, Row, Segmented, TokenButton, TokenSelectModal } from './ui.tsx';

type Flow =
  | { kind: 'add'; pool: SpotPoolInfo; position: LpPosition | null }
  | { kind: 'remove'; position: LpPosition }
  | { kind: 'perp-add'; pool: string; position: LpPosition | null }
  | { kind: 'create' };

function asErc20(token: TokenInfo): TokenInfo {
  return token.native ? DEFAULT_TOKENS[1] : token;
}

export default function PoolsView({ ctx }: { ctx: DexCtx }) {
  const positions = usePolled(ctx.account ? `positions:${ctx.account}` : null, (signal) => readPositions(ctx.account!, signal), ctx.refreshSignal);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [filter, setFilter] = useState<'all' | 'spot' | 'perp'>('all');
  const mine = (positions.data ?? []).filter((position) => filter === 'all' || (filter === 'spot') === position.isSpot);
  const allPools = ctx.pairs.flatMap((pair) => pair.spotPools.map((pool) => ({ pair, pool })));

  return (
    <div className="dx-pools">
      <header className="dx-hero">
        <div>
          <h2>유동성을 공급하고<br /><em>수수료를 받으세요</em></h2>
          <p>LP 지분은 ERC-721 포지션 NFT(S9-POS)로 발행됩니다. 수수료는 풀에 자동 복리되어 지분 가치로 쌓입니다.</p>
        </div>
        <div className="dx-hero__actions">
          <button type="button" className="dx-button dx-button--solid" onClick={() => setFlow({ kind: 'create' })}>+ 새 풀 / 포지션</button>
        </div>
      </header>

      <section className="dx-card">
        <header className="dx-card__head">
          <h2>내 포지션</h2>
          <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: '전체' }, { value: 'spot', label: '현물' }, { value: 'perp', label: '선물 LP' }]} />
        </header>
        {!ctx.account && <Empty title="지갑을 연결하면 포지션 NFT가 보입니다" />}
        {ctx.account && mine.length === 0 && <Empty title={positions.loading ? '포지션을 찾는 중…' : '보유한 포지션이 없습니다'}>아래 풀 목록에서 공급을 시작하세요.</Empty>}
        <div className="dx-position-grid">
          {mine.map((position) => (
            <PositionCard
              key={position.tokenId.toString()}
              ctx={ctx}
              position={position}
              onAdd={() => {
                if (!position.isSpot) setFlow({ kind: 'perp-add', pool: position.pool, position });
                else {
                  const pool = allPools.find((entry) => sameAddress(entry.pool.address, position.pool))?.pool;
                  if (pool) setFlow({ kind: 'add', pool, position });
                }
              }}
              onRemove={() => setFlow({ kind: 'remove', position })}
            />
          ))}
        </div>
      </section>

      <section className="dx-card">
        <header className="dx-card__head">
          <h2>전체 현물 풀</h2>
          <span className="dx-muted">{allPools.length}개</span>
        </header>
        {allPools.length === 0 && <Empty title={ctx.marketsLoading ? '불러오는 중…' : '아직 풀이 없습니다'} />}
        {allPools.length > 0 && (
          <div className="dx-table-wrap">
            <table className="dx-table dx-table--pools">
              <thead><tr><th>풀</th><th>수수료</th><th>가격</th><th>예치량</th><th /></tr></thead>
              <tbody>
                {allPools.map(({ pair, pool }) => (
                  <tr key={pool.address}>
                    <td><span className="dx-cell-pair"><PairIcons a={pair.base} b={pair.quote} size={20} />{pair.base.symbol}/{pair.quote.symbol}</span></td>
                    <td>{formatPpm(pool.feePpm)}</td>
                    <td>{formatPriceX18(reservePriceX18(pool.reserve0, pool.reserve1), pair.base.decimals, pair.quote.decimals)}</td>
                    <td className="dx-muted">{formatAmount(pool.reserve0, pair.base.decimals, 4)} / {formatAmount(pool.reserve1, pair.quote.decimals, 4)}</td>
                    <td><button type="button" className="dx-link-button" onClick={() => setFlow({ kind: 'add', pool, position: null })}>공급</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {flow?.kind === 'add' && <AddSpotModal ctx={ctx} pool={flow.pool} position={flow.position} onClose={() => setFlow(null)} />}
      {flow?.kind === 'remove' && <RemoveModal ctx={ctx} position={flow.position} onClose={() => setFlow(null)} />}
      {flow?.kind === 'perp-add' && <PerpLpModal ctx={ctx} pool={flow.pool} position={flow.position} onClose={() => setFlow(null)} />}
      {flow?.kind === 'create' && <CreatePoolModal ctx={ctx} onClose={() => setFlow(null)} onPickPool={(pool) => setFlow({ kind: 'add', pool, position: null })} />}
    </div>
  );
}

function PositionCard({ ctx, position, onAdd, onRemove }: { ctx: DexCtx; position: LpPosition; onAdd: () => void; onRemove: () => void }) {
  const token0 = ctx.tokenFor(position.token0);
  const token1 = ctx.tokenFor(position.token1);
  const quote = ctx.tokenFor(position.quoteToken);
  const empty = position.liquidity === 0n;
  return (
    <article className="dx-position">
      <header>
        <PairIcons a={token0} b={token1} size={24} />
        <div>
          <strong>{token0?.symbol ?? '?'}/{token1?.symbol ?? '?'}</strong>
          <small>#{position.tokenId.toString()} · {position.isSpot ? '현물' : `선물 LP (${quote?.symbol ?? '?'} 금고)`} · {formatPpm(position.feePpm)}</small>
        </div>
      </header>
      {position.isSpot ? (
        <dl>
          <div><dt>{token0?.symbol}</dt><dd>{formatAmount(position.amount0, token0?.decimals ?? 18)}</dd></div>
          <div><dt>{token1?.symbol}</dt><dd>{formatAmount(position.amount1, token1?.decimals ?? 18)}</dd></div>
          <div><dt>풀 지분</dt><dd>{ratioPct(position.liquidity, position.totalShares, 3)}</dd></div>
        </dl>
      ) : (
        <dl>
          <div><dt>지분 가치</dt><dd>{formatAmount(position.quoteValue, quote?.decimals ?? 18)} {quote?.symbol}</dd></div>
          <div><dt>금고 지분</dt><dd>{ratioPct(position.liquidity, position.totalShares, 3)}</dd></div>
        </dl>
      )}
      <footer>
        <button type="button" className="dx-button dx-button--ghost dx-button--sm" disabled={ctx.paused} onClick={onAdd}>추가</button>
        {!empty && <button type="button" className="dx-button dx-button--ghost dx-button--sm" onClick={onRemove}>회수</button>}
        {empty && (
          <button type="button" className="dx-button dx-button--ghost dx-button--sm" disabled={!!ctx.busy} onClick={() => void ctx.run('포지션 소각', [burnPosition(position.tokenId)])}>NFT 소각</button>
        )}
        <AddressLink address={position.pool} label="풀" />
      </footer>
    </article>
  );
}

// ─────────────────── add spot liquidity ───────────────────

function AddSpotModal({ ctx, pool, position, onClose }: { ctx: DexCtx; pool: SpotPoolInfo; position: LpPosition | null; onClose: () => void }) {
  const token0 = ctx.tokenFor(pool.token0);
  const token1 = ctx.tokenFor(pool.token1);
  const [text0, setText0] = useState('');
  const [text1, setText1] = useState('');
  const [tolerance, setTolerance] = useState('1');
  if (!token0 || !token1) return null;
  const seeded = pool.reserve0 > 0n && pool.reserve1 > 0n;

  const sync = (which: 0 | 1, text: string) => {
    if (which === 0) setText0(text);
    else setText1(text);
    if (!seeded) return;
    const amount = parseAmount(text, which === 0 ? token0.decimals : token1.decimals);
    if (amount === null) return;
    if (which === 0) setText1(toInputString((amount * pool.reserve1) / pool.reserve0, token1.decimals, 8));
    else setText0(toInputString((amount * pool.reserve0) / pool.reserve1, token0.decimals, 8));
  };

  const amount0 = parseAmount(text0, token0.decimals);
  const amount1 = parseAmount(text1, token1.decimals);
  const bps = parseSlippageBps(tolerance) ?? 100n;
  const plan0 = amount0 !== null ? wrapFor(token0, amount0, balanceOf(ctx, token0) ?? 0n, ctx.nativeBalance, MON_NATIVE_GAS_RESERVE) : [];
  const plan1 = amount1 !== null ? wrapFor(token1, amount1, balanceOf(ctx, token1) ?? 0n, ctx.nativeBalance, MON_NATIVE_GAS_RESERVE) : [];
  const short0 = plan0 === null;
  const short1 = plan1 === null;
  const wrapBoth = (plan0 ?? []).length > 0 && (plan1 ?? []).length > 0;
  const ready = amount0 && amount1 && !short0 && !short1 && !wrapBoth;

  const submit = async () => {
    if (!ctx.account) {
      await ctx.wallet.connect();
      return;
    }
    if (!amount0 || !amount1 || plan0 === null || plan1 === null) return;
    const account = ctx.account;
    const min0 = seeded ? applySlippage(amount0, bps) : 0n;
    const min1 = seeded ? applySlippage(amount1, bps) : 0n;
    const ok = await ctx.run(position ? '유동성 추가' : '유동성 공급', [
      ...plan0,
      ...plan1,
      ...approvalSteps(account, [
        { token: token0, spender: DEX.positionManager, amount: amount0 },
        { token: token1, spender: DEX.positionManager, amount: amount1 },
      ]),
      position ? increaseSpot(position.tokenId, amount0, amount1, min0, min1) : mintSpot(pool.address, amount0, amount1, min0, min1, account),
    ]);
    if (ok) onClose();
  };

  return (
    <Modal title={position ? `포지션 #${position.tokenId} 유동성 추가` : `${token0.symbol}/${token1.symbol} ${formatPpm(pool.feePpm)} 풀에 공급`} onClose={onClose}>
      {!seeded && <Notice tone="warn">빈 풀입니다. 처음 넣는 두 수량의 비율이 곧 시작 가격이 됩니다.</Notice>}
      {seeded && <Row label="현재 가격">1 {token0.symbol} = {formatPriceX18(reservePriceX18(pool.reserve0, pool.reserve1), token0.decimals, token1.decimals)} {token1.symbol}</Row>}
      <AmountBox label={token0.symbol} value={text0} onChange={(value) => sync(0, value)} token={token0} balance={balanceOf(ctx, token0)}
        onMax={() => { const balance = balanceOf(ctx, token0); if (balance) sync(0, toInputString(balance, token0.decimals, 8)); }} invalid={short0} />
      <AmountBox label={token1.symbol} value={text1} onChange={(value) => sync(1, value)} token={token1} balance={balanceOf(ctx, token1)}
        onMax={() => { const balance = balanceOf(ctx, token1); if (balance) sync(1, toInputString(balance, token1.decimals, 8)); }} invalid={short1} />
      {!seeded && amount0 && amount1 && (
        <Row label="시작 가격">1 {token0.symbol} = {formatPriceX18((amount1 * 10n ** 18n) / amount0, token0.decimals, token1.decimals)} {token1.symbol}</Row>
      )}
      {seeded && (
        <label className="dx-field dx-field--inline">
          <span>슬리피지 허용 (%)</span>
          <input className="dx-input dx-input--sm" value={tolerance} onChange={(event) => setTolerance(event.target.value)} inputMode="decimal" />
        </label>
      )}
      {((plan0 ?? []).length > 0 || (plan1 ?? []).length > 0) && <Notice>부족한 WMON은 네이티브 MON에서 자동으로 래핑합니다.</Notice>}
      <p className="dx-fine">풀 비율에 맞는 만큼만 들어가고 나머지는 지갑에 남습니다. 수수료는 자동 복리되며 별도 수령이 없습니다.</p>
      <button type="button" className="dx-button dx-button--solid dx-button--block" disabled={!ready || ctx.paused || !!ctx.busy} onClick={() => void submit()}>
        {ctx.busy ?? (ctx.paused ? 'DEX 일시정지 중' : short0 || short1 ? '잔액 부족' : position ? '유동성 추가' : '공급하고 포지션 NFT 받기')}
      </button>
    </Modal>
  );
}

// ─────────────────── remove ───────────────────

function RemoveModal({ ctx, position, onClose }: { ctx: DexCtx; position: LpPosition; onClose: () => void }) {
  const [pct, setPct] = useState(100);
  const [tolerance, setTolerance] = useState('1');
  const [toNative, setToNative] = useState(true);
  const token0 = ctx.tokenFor(position.token0);
  const token1 = ctx.tokenFor(position.token1);
  const quote = ctx.tokenFor(position.quoteToken);
  const bps = parseSlippageBps(tolerance) ?? 100n;
  const liquidity = (position.liquidity * BigInt(pct)) / 100n;
  const out0 = (position.amount0 * BigInt(pct)) / 100n;
  const out1 = (position.amount1 * BigInt(pct)) / 100n;
  const outQuote = (position.quoteValue * BigInt(pct)) / 100n;
  const hasWmon = position.isSpot
    ? sameAddress(position.token0, TOKENS.wmon) || sameAddress(position.token1, TOKENS.wmon)
    : sameAddress(position.quoteToken, TOKENS.wmon);

  const submit = async () => {
    if (!ctx.account || liquidity === 0n) return;
    const account = ctx.account;
    const steps: AnyStep[] = [position.isSpot
      ? decreaseSpot(position.tokenId, liquidity, applySlippage(out0, bps), applySlippage(out1, bps), account)
      : decreasePerp(position.tokenId, liquidity, applySlippage(outQuote, bps), account)];
    if (hasWmon && toNative) {
      const [before] = await batch([call(TOKENS.wmon, 'balanceOf(address)', [account])]);
      const wmonBefore = asUint(before) ?? 0n;
      steps.push({
        label: 'WMON → MON 언래핑',
        build: async (): Promise<TxStep | null> => {
          const [after] = await batch([call(TOKENS.wmon, 'balanceOf(address)', [account])]);
          const received = (asUint(after) ?? 0n) - wmonBefore;
          return received > 0n ? unwrapMon(received) : null;
        },
      });
    }
    if (pct === 100) steps.push(burnPosition(position.tokenId));
    const ok = await ctx.run('유동성 회수', steps);
    if (ok) onClose();
  };

  return (
    <Modal title={`포지션 #${position.tokenId} 회수`} onClose={onClose}>
      <div className="dx-percent">
        <strong>{pct}%</strong>
        <input type="range" min={1} max={100} value={pct} onChange={(event) => setPct(Number(event.target.value))} aria-label="회수 비율" />
        <div className="dx-chips">{[25, 50, 75, 100].map((value) => <button key={value} type="button" className={pct === value ? 'is-active' : ''} onClick={() => setPct(value)}>{value}%</button>)}</div>
      </div>
      <div className="dx-details">
        {position.isSpot ? (
          <>
            <Row label={`${token0?.symbol} 예상`}>{formatAmount(out0, token0?.decimals ?? 18)}</Row>
            <Row label={`${token1?.symbol} 예상`}>{formatAmount(out1, token1?.decimals ?? 18)}</Row>
          </>
        ) : (
          <Row label={`${quote?.symbol} 예상`}>{formatAmount(outQuote, quote?.decimals ?? 18)}</Row>
        )}
      </div>
      <label className="dx-field dx-field--inline">
        <span>슬리피지 허용 (%)</span>
        <input className="dx-input dx-input--sm" value={tolerance} onChange={(event) => setTolerance(event.target.value)} inputMode="decimal" />
      </label>
      {hasWmon && <label className="dx-toggle"><input type="checkbox" checked={toNative} onChange={(event) => setToNative(event.target.checked)} /> 받은 WMON을 MON으로 언래핑</label>}
      {pct === 100 && <p className="dx-fine">전량 회수 후 빈 포지션 NFT는 소각합니다.</p>}
      {!position.isSpot && <p className="dx-fine">선물 LP 인출은 실현 유동성 한도와 풀 사용률 상한 안에서만 가능합니다.</p>}
      <p className="dx-fine">회수는 DEX가 일시정지된 상태에서도 항상 가능합니다.</p>
      <button type="button" className="dx-button dx-button--solid dx-button--block" disabled={!!ctx.busy || liquidity === 0n} onClick={() => void submit()}>
        {ctx.busy ?? '회수하기'}
      </button>
    </Modal>
  );
}

// ─────────────────── perp LP ───────────────────

export function PerpLpModal({ ctx, pool, position, onClose }: { ctx: DexCtx; pool: string; position: LpPosition | null; onClose: () => void }) {
  const info = usePolled(`perp-lp:${pool}`, async (signal) => {
    const results = await batch([call(pool, 'quoteToken()'), call(pool, 'lpEquity()'), call(pool, 'totalShares()')], signal);
    return { quote: asAddress(results[0]), equity: asUint(results[1]) ?? 0n, shares: asUint(results[2]) ?? 0n };
  }, ctx.refreshSignal);
  const [text, setText] = useState('');
  const quote = ctx.tokenFor(info.data?.quote ?? position?.quoteToken ?? null);
  if (!quote) return <Modal title="선물 LP 예치" onClose={onClose}><Empty title="불러오는 중…" /></Modal>;
  const amount = parseAmount(text, quote.decimals);
  const plan = amount !== null ? wrapFor(quote, amount, balanceOf(ctx, quote) ?? 0n, ctx.nativeBalance, MON_NATIVE_GAS_RESERVE) : [];
  const expectedShares = amount && info.data && info.data.shares > 0n && info.data.equity > 0n ? (amount * info.data.shares) / info.data.equity : null;

  const submit = async () => {
    if (!ctx.account) {
      await ctx.wallet.connect();
      return;
    }
    if (!amount || plan === null) return;
    const account = ctx.account;
    const minShares = expectedShares ? applySlippage(expectedShares, 100n) : 0n;
    const ok = await ctx.run('선물 LP 예치', [
      ...plan,
      ...approvalSteps(account, [{ token: quote, spender: DEX.positionManager, amount }]),
      position ? increasePerp(position.tokenId, amount, minShares) : mintPerp(pool, amount, minShares, account),
    ]);
    if (ok) onClose();
  };

  return (
    <Modal title={position ? `포지션 #${position.tokenId} 예치 추가` : '선물 LP 금고 예치'} onClose={onClose}>
      <p className="dx-fine">선물 LP 금고는 모든 트레이더 포지션의 상대방입니다. 트레이더 손실·수수료·펀딩이 수익이 되고, 트레이더 이익은 손실이 됩니다.</p>
      {info.data && <Row label="금고 LP 자산">{formatAmount(info.data.equity, quote.decimals)} {quote.symbol}</Row>}
      <AmountBox label={`예치 (${quote.symbol})`} value={text} onChange={setText} token={quote} balance={balanceOf(ctx, quote)}
        onMax={() => { const balance = balanceOf(ctx, quote); if (balance) setText(toInputString(balance, quote.decimals, 8)); }} invalid={plan === null} />
      <button type="button" className="dx-button dx-button--solid dx-button--block" disabled={!amount || plan === null || ctx.paused || !!ctx.busy} onClick={() => void submit()}>
        {ctx.busy ?? (ctx.paused ? 'DEX 일시정지 중' : plan === null ? '잔액 부족' : '예치하고 포지션 NFT 받기')}
      </button>
    </Modal>
  );
}

// ─────────────────── create ───────────────────

function CreatePoolModal({ ctx, onClose, onPickPool }: { ctx: DexCtx; onClose: () => void; onPickPool: (pool: SpotPoolInfo) => void }) {
  const [tokenA, setTokenA] = useState<TokenInfo | null>(DEFAULT_TOKENS[0]);
  const [tokenB, setTokenB] = useState<TokenInfo | null>(null);
  const [picker, setPicker] = useState<'a' | 'b' | null>(null);
  const [fee, setFee] = useState<number>(3000);
  const [customFee, setCustomFee] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [textA, setTextA] = useState('');
  const [textB, setTextB] = useState('');

  const erc20A = tokenA ? asErc20(tokenA) : null;
  const erc20B = tokenB ? asErc20(tokenB) : null;
  const same = !!erc20A && !!erc20B && sameAddress(erc20A.address, erc20B.address);
  const pair: PairInfo | null = erc20A && erc20B && !same
    ? ctx.pairs.find((entry) => (sameAddress(entry.base.address, erc20A.address) && sameAddress(entry.quote.address, erc20B.address)) ||
      (sameAddress(entry.base.address, erc20B.address) && sameAddress(entry.quote.address, erc20A.address))) ?? null
    : null;
  const customPpm = customFee.trim() === '' ? null : Math.round(Number(customFee) * 10_000);
  const feePpm = useCustom ? customPpm : fee;
  const feeValid = feePpm !== null && Number.isInteger(feePpm) && feePpm >= LIMITS.minLpFeePpm && feePpm <= LIMITS.maxLpFeePpm;
  const existing = pair && feePpm !== null ? pair.spotPools.find((pool) => pool.feePpm === BigInt(feePpm)) ?? null : null;
  const customLeft = LIMITS.maxCustomSpotPools - Number(pair?.customSpotPools ?? 0n);
  const isCanonical = FEE_TIERS.some((tier) => tier.ppm === feePpm);
  const slotsExhausted = useCustom && !isCanonical && customLeft <= 0;

  const amountA = erc20A ? parseAmount(textA, erc20A.decimals) : null;
  const amountB = erc20B ? parseAmount(textB, erc20B.decimals) : null;
  const planA = erc20A && amountA !== null ? wrapFor(erc20A, amountA, balanceOf(ctx, erc20A) ?? 0n, ctx.nativeBalance, MON_NATIVE_GAS_RESERVE) : [];
  const planB = erc20B && amountB !== null ? wrapFor(erc20B, amountB, balanceOf(ctx, erc20B) ?? 0n, ctx.nativeBalance, MON_NATIVE_GAS_RESERVE) : [];
  const ready = !!erc20A && !!erc20B && !same && feeValid && !existing && !slotsExhausted && !!amountA && !!amountB && planA !== null && planB !== null;

  const submit = async () => {
    if (!ctx.account) {
      await ctx.wallet.connect();
      return;
    }
    if (!ready || !erc20A || !erc20B || !amountA || !amountB || feePpm === null || planA === null || planB === null) return;
    const account = ctx.account;
    const [token0, token1] = erc20A.address.toLowerCase() < erc20B.address.toLowerCase() ? [erc20A, erc20B] : [erc20B, erc20A];
    const [amount0, amount1] = token0 === erc20A ? [amountA, amountB] : [amountB, amountA];
    const resolvePair = async () => pair?.address ?? await readPairAddress(erc20A.address, erc20B.address);
    const steps: AnyStep[] = [];
    if (!pair) steps.push(createPair(erc20A.address, erc20B.address));
    steps.push({
      label: '현물 풀 생성',
      build: async () => {
        const address = await resolvePair();
        if (!address) throw new Error('페어 주소를 찾지 못했습니다.');
        ctx.trackPair(address);
        return createSpotPool(address, BigInt(feePpm));
      },
    });
    steps.push(...planA, ...planB, ...approvalSteps(account, [
      { token: token0, spender: DEX.positionManager, amount: amount0 },
      { token: token1, spender: DEX.positionManager, amount: amount1 },
    ]));
    steps.push({
      label: '초기 유동성 공급',
      build: async () => {
        const address = await resolvePair();
        if (!address) return null;
        const [lengthResult] = await batch([call(address, 'spotPoolsLength()')]);
        const length = Number(asUint(lengthResult) ?? 0n);
        const listed = await batch(Array.from({ length }, (_, index) => call(address, 'spotPools(uint256)', [BigInt(index)])));
        const fees = await batch(listed.map((result) => call(asAddress(result) ?? DEX.registry, 'lpFeeRatePpm()')));
        const index = fees.findIndex((result) => asUint(result) === BigInt(feePpm));
        const pool = index >= 0 ? asAddress(listed[index]) : null;
        if (!pool) throw new Error('새 풀 주소를 찾지 못했습니다.');
        return mintSpot(pool, amount0, amount1, 0n, 0n, account);
      },
    });
    const ok = await ctx.run('풀 생성', steps);
    if (ok) onClose();
  };

  return (
    <Modal title="새 풀 만들기" onClose={onClose} wide>
      <div className="dx-create-grid">
        <div className="dx-field">
          <span>토큰 페어</span>
          <div className="dx-pair-pick">
            <TokenButton token={tokenA} onClick={() => setPicker('a')} />
            <span>+</span>
            <TokenButton token={tokenB} onClick={() => setPicker('b')} />
          </div>
          {same && <p className="dx-error-text">서로 다른 두 토큰을 고르세요.</p>}
          {erc20A && erc20B && !same && (
            <small className="dx-hint">{pair ? <>페어가 이미 있습니다 · <AddressLink address={pair.address} /></> : '새 페어가 함께 생성됩니다 (CREATE2).'}</small>
          )}
        </div>

        <div className="dx-field">
          <span>수수료 티어</span>
          <div className="dx-fee-grid">
            {FEE_TIERS.map((tier) => {
              const taken = pair?.spotPools.some((pool) => pool.feePpm === BigInt(tier.ppm));
              return (
                <button key={tier.ppm} type="button" className={!useCustom && fee === tier.ppm ? 'is-active' : ''} onClick={() => { setUseCustom(false); setFee(tier.ppm); }}>
                  <strong>{tier.label}</strong>
                  <small>{taken ? '이미 존재' : tier.note}</small>
                </button>
              );
            })}
            <button type="button" className={useCustom ? 'is-active' : ''} onClick={() => setUseCustom(true)}>
              <strong>커스텀</strong>
              <small>남은 슬롯 {pair ? customLeft : LIMITS.maxCustomSpotPools}/12</small>
            </button>
          </div>
          {useCustom && (
            <label className="dx-field dx-field--inline">
              <span>수수료 (%) 0.0001 ~ 1</span>
              <input className="dx-input dx-input--sm" inputMode="decimal" value={customFee} onChange={(event) => setCustomFee(event.target.value)} placeholder="0.25" />
            </label>
          )}
          {!feeValid && useCustom && customFee !== '' && <p className="dx-error-text">0.0001% ~ 1% 사이, 0.0001% 단위로 입력하세요.</p>}
          {slotsExhausted && <p className="dx-error-text">커스텀 슬롯 12개가 모두 찼습니다. 기본 티어 4개는 항상 만들 수 있습니다.</p>}
          <p className="dx-fine">풀 수수료 중 0.1%가 프로토콜 금고로, 99.9%가 LP에게 갑니다. 풀은 수수료율당 하나입니다.</p>
        </div>
      </div>

      {existing ? (
        <Notice>
          이 수수료의 풀이 이미 있습니다.{' '}
          <button type="button" className="dx-link-button" onClick={() => onPickPool(existing)}>이 풀에 공급하기 →</button>
        </Notice>
      ) : erc20A && erc20B && !same && (
        <>
          <Notice tone="warn">초기 공급 비율이 시작 가격입니다. 시장가와 다르면 곧바로 차익거래로 손실을 볼 수 있습니다.</Notice>
          <div className="dx-create-grid">
            <AmountBox label={erc20A.symbol} value={textA} onChange={setTextA} token={erc20A} balance={balanceOf(ctx, erc20A)} invalid={planA === null} />
            <AmountBox label={erc20B.symbol} value={textB} onChange={setTextB} token={erc20B} balance={balanceOf(ctx, erc20B)} invalid={planB === null} />
          </div>
          {amountA && amountB && (
            <Row label="시작 가격">1 {erc20A.symbol} = {formatPriceX18((amountB * 10n ** 18n) / amountA, erc20A.decimals, erc20B.decimals)} {erc20B.symbol}</Row>
          )}
        </>
      )}

      <button type="button" className="dx-button dx-button--solid dx-button--block" disabled={!ready || ctx.paused || !!ctx.busy} onClick={() => void submit()}>
        {ctx.busy ?? (ctx.paused ? 'DEX 일시정지 중' : pair ? '풀 생성 + 초기 유동성 공급' : '페어·풀 생성 + 초기 유동성 공급')}
      </button>

      {picker && (
        <TokenSelectModal
          tokens={ctx.withNative}
          balances={ctx.balances}
          onSelect={(token) => { if (picker === 'a') setTokenA(token); else setTokenB(token); setPicker(null); }}
          onImport={ctx.importToken}
          onClose={() => setPicker(null)}
        />
      )}
    </Modal>
  );
}
