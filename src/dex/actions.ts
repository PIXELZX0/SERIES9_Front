/** Calldata builders for every DEX write the UI sends. */
import { TOKENS } from '../chain.ts';
import { encodeFunction } from './abi.ts';
import { DEADLINE_SECONDS, DEX } from './config.ts';
import type { TxStep } from './useTxRunner.ts';

export function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
}

export const wrapMon = (amount: bigint): TxStep => ({
  label: 'MON → WMON 래핑', to: TOKENS.wmon, data: encodeFunction('deposit()'), value: amount,
});

export const unwrapMon = (amount: bigint): TxStep => ({
  label: 'WMON → MON 언래핑', to: TOKENS.wmon, data: encodeFunction('withdraw(uint256)', [amount]),
});

export const routerSwap = (pools: string[], tokenIn: string, amountIn: bigint, minOut: bigint, to: string): TxStep => ({
  label: '스왑',
  to: DEX.router,
  data: encodeFunction('swapExactTokensForTokens(address[],address,uint256,uint256,address,uint256)', [pools, tokenIn, amountIn, minOut, to, deadline()]),
});

// ─────────────────── creation ───────────────────

export const createPair = (tokenA: string, tokenB: string): TxStep => ({
  label: '페어 생성', to: DEX.registry, data: encodeFunction('createPair(address,address)', [tokenA, tokenB]),
});

export const createSpotPool = (pair: string, feePpm: bigint): TxStep => ({
  label: '현물 풀 생성', to: pair, data: encodeFunction('createSpotPool(uint32)', [feePpm]),
});

export type PerpParamsInput = {
  maxLeverageX: bigint;
  maintenanceMarginBps: bigint;
  liquidationFeeBps: bigint;
  maxUtilizationBps: bigint;
  fundingCoeffPpmPerHour: bigint;
};

export const createPerpPool = (pair: string, quoteToken: string, spotPool: string, feePpm: bigint, params: PerpParamsInput): TxStep => ({
  label: '선물 풀 생성',
  to: pair,
  data: encodeFunction('createPerpPool(address,address,uint32,(uint32,uint32,uint32,uint32,uint64))', [
    quoteToken, spotPool, feePpm,
    [params.maxLeverageX, params.maintenanceMarginBps, params.liquidationFeeBps, params.maxUtilizationBps, params.fundingCoeffPpmPerHour],
  ]),
});

// ─────────────────── order book ───────────────────

export const placeOrder = (pair: string, side: 'buy' | 'sell', priceX18: bigint, amountBase: bigint, expiry: bigint, priceHint: bigint): TxStep => ({
  label: side === 'buy' ? '매수 주문' : '매도 주문',
  to: pair,
  data: encodeFunction('placeOrder(uint8,uint256,uint256,uint64,uint256)', [side === 'buy' ? 0n : 1n, priceX18, amountBase, expiry, priceHint]),
});

export const cancelOrder = (pair: string, orderId: bigint): TxStep => ({
  label: `주문 #${orderId} 취소`, to: pair, data: encodeFunction('cancelOrder(uint256)', [orderId]),
});

export const matchOrders = (pair: string, maxFills: bigint): TxStep => ({
  label: '호가 매칭', to: pair, data: encodeFunction('matchOrders(uint256)', [maxFills]),
});

// ─────────────────── LP positions ───────────────────

export const mintSpot = (pool: string, amount0: bigint, amount1: bigint, min0: bigint, min1: bigint, to: string): TxStep => ({
  label: '유동성 공급 (포지션 NFT 발행)',
  to: DEX.positionManager,
  data: encodeFunction('mintSpot(address,uint256,uint256,uint256,uint256,address,uint256)', [pool, amount0, amount1, min0, min1, to, deadline()]),
});

export const increaseSpot = (tokenId: bigint, amount0: bigint, amount1: bigint, min0: bigint, min1: bigint): TxStep => ({
  label: `포지션 #${tokenId} 유동성 추가`,
  to: DEX.positionManager,
  data: encodeFunction('increaseSpot(uint256,uint256,uint256,uint256,uint256,uint256)', [tokenId, amount0, amount1, min0, min1, deadline()]),
});

export const decreaseSpot = (tokenId: bigint, liquidity: bigint, min0: bigint, min1: bigint, to: string): TxStep => ({
  label: `포지션 #${tokenId} 유동성 회수`,
  to: DEX.positionManager,
  data: encodeFunction('decreaseSpot(uint256,uint256,uint256,uint256,address,uint256)', [tokenId, liquidity, min0, min1, to, deadline()]),
});

export const mintPerp = (pool: string, quoteIn: bigint, minShares: bigint, to: string): TxStep => ({
  label: '선물 LP 예치 (포지션 NFT 발행)',
  to: DEX.positionManager,
  data: encodeFunction('mintPerp(address,uint256,uint256,address,uint256)', [pool, quoteIn, minShares, to, deadline()]),
});

export const increasePerp = (tokenId: bigint, quoteIn: bigint, minShares: bigint): TxStep => ({
  label: `포지션 #${tokenId} 예치 추가`,
  to: DEX.positionManager,
  data: encodeFunction('increasePerp(uint256,uint256,uint256,uint256)', [tokenId, quoteIn, minShares, deadline()]),
});

export const decreasePerp = (tokenId: bigint, shares: bigint, minQuoteOut: bigint, to: string): TxStep => ({
  label: `포지션 #${tokenId} 인출`,
  to: DEX.positionManager,
  data: encodeFunction('decreasePerp(uint256,uint256,uint256,address,uint256)', [tokenId, shares, minQuoteOut, to, deadline()]),
});

export const burnPosition = (tokenId: bigint): TxStep => ({
  label: `포지션 #${tokenId} NFT 소각`, to: DEX.positionManager, data: encodeFunction('burn(uint256)', [tokenId]),
});

// ─────────────────── perps ───────────────────

export const openPosition = (pool: string, isLong: boolean, marginQuote: bigint, sizeBase: bigint): TxStep => ({
  label: isLong ? '롱 진입' : '숏 진입', to: pool, data: encodeFunction('openPosition(bool,uint256,uint256)', [isLong, marginQuote, sizeBase]),
});

export const decreasePosition = (pool: string, isLong: boolean, sizeBase: bigint): TxStep => ({
  label: isLong ? '롱 축소/청산' : '숏 축소/청산', to: pool, data: encodeFunction('decreasePosition(bool,uint256)', [isLong, sizeBase]),
});

export const addMargin = (pool: string, isLong: boolean, amount: bigint): TxStep => ({
  label: '증거금 추가', to: pool, data: encodeFunction('addMargin(bool,uint256)', [isLong, amount]),
});

export const removeMargin = (pool: string, isLong: boolean, amount: bigint): TxStep => ({
  label: '증거금 인출', to: pool, data: encodeFunction('removeMargin(bool,uint256)', [isLong, amount]),
});

export const pokeMark = (pool: string): TxStep => ({
  label: '마크 가격 갱신', to: pool, data: encodeFunction('pokeMark()'),
});
