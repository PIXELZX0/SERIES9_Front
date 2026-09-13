import { useCallback, useEffect, useState } from 'react';
import { rpcBatch } from './chain.ts';
import {
  DEX_CONTRACTS,
  DEX_SELECTOR,
  dexCall,
  decodeDexAddressArray,
  decodeDexReserves,
  decodeDexUint,
  decodeDexUint32,
  encodeDexNoArgs,
  encodeGetSpotPools,
  encodeSharesOf,
  normalizeDexAddress,
} from './dex.ts';
import { computePairId, sortTokenPair } from './keccak.ts';
import type { DexToken } from './useDex.ts';

export type PoolPosition = {
  poolAddress: string;
  token0: DexToken;
  token1: DexToken;
  reserve0: bigint;
  reserve1: bigint;
  totalShares: bigint;
  feePpm: bigint | null;
  walletShares: bigint;
  /** USD value of the wallet's share of this pool, or null when neither token has a known USD price yet. */
  valueUsd: number | null;
  distribution0Pct: number | null;
  /**
   * Fee accrued since this position was first observed in this browser, estimated as the
   * growth in the position's USD value while its share count is unchanged. This DEX compounds
   * swap fees straight into pool reserves (no separate per-LP fee ledger, no indexed history),
   * so there is no exact on-chain source for "fees earned" — this is the closest local proxy.
   */
  feeEstimateUsd: number | null;
  aprEstimatePct: number | null;
  /** When this browser first saw the current share count for this pool — not the pool's real creation time. */
  firstSeenAt: number | null;
};

export type PoolOverview = {
  loading: boolean;
  error: string | null;
  positions: PoolPosition[];
  totalValueUsd: number | null;
  totalFeeUsd: number | null;
  refresh: () => void;
};

const BASELINE_PREFIX = 'series9:pool-baseline';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const BASELINE_MIN_AGE_MS = 60 * 60 * 1000;

type Baseline = { shares: string; valueUsd: number; firstSeenAt: number };

function baselineKey(wallet: string, pool: string): string {
  return `${BASELINE_PREFIX}:${wallet.toLowerCase()}:${pool.toLowerCase()}`;
}

function readBaseline(wallet: string, pool: string): Baseline | null {
  try {
    const raw = window.localStorage.getItem(baselineKey(wallet, pool));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Baseline>;
    if (typeof parsed.shares !== 'string' || typeof parsed.valueUsd !== 'number' || typeof parsed.firstSeenAt !== 'number') return null;
    return parsed as Baseline;
  } catch {
    return null;
  }
}

function writeBaseline(wallet: string, pool: string, baseline: Baseline): void {
  try {
    window.localStorage.setItem(baselineKey(wallet, pool), JSON.stringify(baseline));
  } catch {
    // Private mode / full quota: fee estimate just degrades to "just opened" every visit.
  }
}

function toDecimal(value: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  return Number(whole) + Number(fraction) / Number(scale);
}

type PairEntry = { pair: [DexToken, DexToken]; pairId: string };

function knownPairs(tokens: DexToken[]): PairEntry[] {
  const pairs: PairEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    for (let j = i + 1; j < tokens.length; j += 1) {
      const pairId = computePairId(tokens[i].address, tokens[j].address);
      if (pairId) pairs.push({ pair: [tokens[i], tokens[j]], pairId });
    }
  }
  return pairs;
}

/** Enumerates every SpotPool among `tokens`' pairwise combinations and the wallet's LP position in each. */
export function usePoolPositions(wallet: string | null, tokens: DexToken[]): PoolOverview {
  const [state, setState] = useState<Omit<PoolOverview, 'refresh'>>({
    loading: true,
    error: null,
    positions: [],
    totalValueUsd: null,
    totalFeeUsd: null,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function run() {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const pairs = knownPairs(tokens);
        const poolListResults = await rpcBatch(
          pairs.map(({ pairId }) => dexCall(DEX_CONTRACTS.registry, encodeGetSpotPools(pairId))),
          controller.signal,
        );

        const poolEntries: Array<{ address: string; token0: DexToken; token1: DexToken }> = [];
        poolListResults.forEach((result, index) => {
          const addresses = decodeDexAddressArray(result) ?? [];
          if (addresses.length === 0) return;
          const [tokenA, tokenB] = pairs[index].pair;
          const sorted = sortTokenPair(tokenA.address, tokenB.address);
          if (!sorted) return;
          const [addr0] = sorted;
          const token0 = addr0.toLowerCase() === tokenA.address.toLowerCase() ? tokenA : tokenB;
          const token1 = token0 === tokenA ? tokenB : tokenA;
          addresses.forEach((address) => poolEntries.push({ address, token0, token1 }));
        });

        if (poolEntries.length === 0) {
          if (!cancelled) setState({ loading: false, error: null, positions: [], totalValueUsd: null, totalFeeUsd: null });
          return;
        }

        const walletAddress = normalizeDexAddress(wallet);
        const perPool = walletAddress ? 4 : 3;
        const calls = poolEntries.flatMap((entry) => [
          dexCall(entry.address, encodeDexNoArgs(DEX_SELECTOR.getReserves)),
          dexCall(entry.address, encodeDexNoArgs(DEX_SELECTOR.lpFeeRatePpm)),
          dexCall(entry.address, encodeDexNoArgs(DEX_SELECTOR.totalShares)),
          ...(walletAddress ? [dexCall(entry.address, encodeSharesOf(walletAddress))] : []),
        ]);
        const results = await rpcBatch(calls, controller.signal);

        const raw = poolEntries.map((entry, index) => {
          const base = index * perPool;
          return {
            entry,
            reserves: decodeDexReserves(results[base]),
            feePpm: decodeDexUint32(results[base + 1]),
            totalShares: decodeDexUint(results[base + 2]) ?? 0n,
            walletShares: walletAddress ? decodeDexUint(results[base + 3]) ?? 0n : 0n,
          };
        });

        // USD pricing: USDC pegs at $1; every other known token prices off whichever pool quotes
        // it against a token whose price is already known (a second pass lets MON price through
        // SER9 when only SER9/MON and SER9/USDC exist, not a direct MON/USDC pool).
        const priceUsd = new Map<string, number>();
        const usdc = tokens.find((token) => token.symbol === 'USDC');
        if (usdc) priceUsd.set(usdc.address.toLowerCase(), 1);

        const derivePrices = () => {
          raw.forEach(({ entry, reserves }) => {
            if (!reserves || reserves.reserve0 === 0n || reserves.reserve1 === 0n) return;
            const key0 = entry.token0.address.toLowerCase();
            const key1 = entry.token1.address.toLowerCase();
            const price0 = priceUsd.get(key0);
            const price1 = priceUsd.get(key1);
            if (price0 === undefined && price1 === undefined) return;
            const amount0 = toDecimal(reserves.reserve0, entry.token0.decimals ?? 18);
            const amount1 = toDecimal(reserves.reserve1, entry.token1.decimals ?? 18);
            if (price0 !== undefined && price1 === undefined && amount1 > 0) {
              priceUsd.set(key1, (amount0 * price0) / amount1);
            } else if (price1 !== undefined && price0 === undefined && amount0 > 0) {
              priceUsd.set(key0, (amount1 * price1) / amount0);
            }
          });
        };
        derivePrices();
        derivePrices();

        const positions: PoolPosition[] = [];
        raw.forEach(({ entry, reserves, feePpm, totalShares, walletShares }) => {
          if (walletShares === 0n) return;
          const dec0 = entry.token0.decimals ?? 18;
          const dec1 = entry.token1.decimals ?? 18;
          const reserve0 = reserves?.reserve0 ?? 0n;
          const reserve1 = reserves?.reserve1 ?? 0n;
          const walletAmount0 = totalShares > 0n ? toDecimal((reserve0 * walletShares) / totalShares, dec0) : 0;
          const walletAmount1 = totalShares > 0n ? toDecimal((reserve1 * walletShares) / totalShares, dec1) : 0;
          const price0 = priceUsd.get(entry.token0.address.toLowerCase());
          const price1 = priceUsd.get(entry.token1.address.toLowerCase());
          const value0 = price0 !== undefined ? walletAmount0 * price0 : null;
          const value1 = price1 !== undefined ? walletAmount1 * price1 : null;
          const valueUsd = value0 !== null && value1 !== null ? value0 + value1 : null;
          const distribution0Pct = valueUsd !== null && valueUsd > 0 ? ((value0 ?? 0) / valueUsd) * 100 : null;

          let feeEstimateUsd: number | null = null;
          let aprEstimatePct: number | null = null;
          let firstSeenAt: number | null = null;
          if (walletAddress && valueUsd !== null) {
            const baseline = readBaseline(walletAddress, entry.address);
            const sharesText = walletShares.toString();
            if (!baseline || baseline.shares !== sharesText) {
              const fresh: Baseline = { shares: sharesText, valueUsd, firstSeenAt: Date.now() };
              writeBaseline(walletAddress, entry.address, fresh);
              feeEstimateUsd = 0;
              firstSeenAt = fresh.firstSeenAt;
            } else {
              feeEstimateUsd = Math.max(0, valueUsd - baseline.valueUsd);
              firstSeenAt = baseline.firstSeenAt;
              const ageMs = Date.now() - baseline.firstSeenAt;
              if (ageMs >= BASELINE_MIN_AGE_MS && baseline.valueUsd > 0) {
                aprEstimatePct = (feeEstimateUsd / baseline.valueUsd) * (YEAR_MS / ageMs) * 100;
              }
            }
          }

          positions.push({
            poolAddress: entry.address,
            token0: entry.token0,
            token1: entry.token1,
            reserve0,
            reserve1,
            totalShares,
            feePpm,
            walletShares,
            valueUsd,
            distribution0Pct,
            feeEstimateUsd,
            aprEstimatePct,
            firstSeenAt,
          });
        });

        const totalValueUsd = positions.some((p) => p.valueUsd !== null)
          ? positions.reduce((sum, p) => sum + (p.valueUsd ?? 0), 0)
          : null;
        const totalFeeUsd = positions.some((p) => p.feeEstimateUsd !== null)
          ? positions.reduce((sum, p) => sum + (p.feeEstimateUsd ?? 0), 0)
          : null;

        if (!cancelled) setState({ loading: false, error: null, positions, totalValueUsd, totalFeeUsd });
      } catch (error) {
        if (!cancelled) {
          setState((prev) => ({ ...prev, loading: false, error: error instanceof Error ? error.message : 'Failed to read pools.' }));
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `tokens` is a stable module-level catalog from the caller; only wallet/refresh should retrigger reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { ...state, refresh };
}
