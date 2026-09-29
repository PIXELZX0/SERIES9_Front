import { CONTRACTS, TOKENS } from '../chain.ts';

const env: Record<string, string | undefined> = import.meta.env ?? {};
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function normalizeAddress(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return ADDRESS_PATTERN.test(trimmed) ? trimmed : null;
}

export function sameAddress(left: string | null | undefined, right: string | null | undefined): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

/**
 * Series9 DEX on Monad mainnet, deployed 2026-09-19 (SERIES9DEX `docs/DEPLOYMENTS.md`).
 * Integrations talk to the proxies; pairs and pools are created at runtime and
 * discovered through the registry, so they are not listed here.
 */
export const DEX = {
  registry: env.VITE_DEX_REGISTRY_ADDRESS ?? '0xE8249f2626605c7E063acf90f8E356a93c2968AC',
  treasury: env.VITE_DEX_TREASURY_ADDRESS ?? '0xc660d7E0d72bF75B6D37156AD2395b6E45a75f21',
  treasuryTimelock: env.VITE_DEX_TIMELOCK_ADDRESS ?? '0x622C3FC5EeCDf03eF3a7436d86Dd27379b75C6E3',
  spotPoolFactory: env.VITE_DEX_SPOT_POOL_FACTORY_ADDRESS ?? '0x24B9a7b864e26a5f04d5Db4d668b2067345173aE',
  perpPoolFactory: env.VITE_DEX_PERP_POOL_FACTORY_ADDRESS ?? '0x0E8555e82c90306180ed768E55a5103F4432D411',
  positionManager: env.VITE_DEX_POSITION_MANAGER_ADDRESS ?? '0x2D3C06bCa14c06Bf35763CA6bEBBb80C84B70374',
  router: env.VITE_DEX_ROUTER_ADDRESS ?? '0x7149bBC0e7530Cd881841C5C6918f12911150C88',
} as const;

/** Pseudo-address for native MON. Never sent on-chain: it is wrapped into WMON first. */
export const NATIVE_MON = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export type TokenInfo = {
  address: string;
  symbol: string;
  decimals: number;
  name?: string;
  logo?: string | null;
  native?: boolean;
};

export const MON: TokenInfo = { address: NATIVE_MON, symbol: 'MON', decimals: 18, name: 'Monad', logo: '/token-logos/mon.svg', native: true };

/** Tokens offered everywhere without having to paste an address. */
export const DEFAULT_TOKENS: TokenInfo[] = [
  { address: CONTRACTS.ser9, symbol: 'SER9', decimals: 18, name: 'Series9', logo: '/token-logos/ser9.svg' },
  { address: TOKENS.wmon, symbol: 'WMON', decimals: 18, name: 'Wrapped MON', logo: '/token-logos/mon.svg' },
  { address: TOKENS.usdc, symbol: 'USDC', decimals: 6, name: 'USD Coin', logo: null },
];

export const FEE_TIERS = [
  { ppm: 100, label: '0.01%', note: '스테이블 페어' },
  { ppm: 500, label: '0.05%', note: '상관관계 높은 페어' },
  { ppm: 3000, label: '0.30%', note: '일반 페어' },
  { ppm: 10000, label: '1.00%', note: '변동성 높은 페어' },
] as const;

/** Mirrors of the on-chain constants in `Pair.sol` / `PerpPool.sol`. */
export const LIMITS = {
  minLpFeePpm: 1,
  maxLpFeePpm: 10_000,
  maxCustomSpotPools: 12,
  priceSigDigits: 6,
  minQuoteNotional: 10_000n,
  maxLeverageCap: 50,
  minMaintenanceBps: 100,
  maxMaintenanceBps: 2000,
  maxLiquidationFeeBps: 500,
  maxFundingCoeffPpmPerHour: 10_000,
  minTwapWindow: 300,
  maxTwapWindow: 3600,
} as const;

export const POLL_MS = 10_000;
/** Deadline added to router / position-manager calls. */
export const DEADLINE_SECONDS = 20 * 60;
/** Matching budget used by the "match book" keeper button. */
export const KEEPER_MAX_FILLS = 20;
/** Newest position-NFT ids scanned for ownership (the manager is not enumerable). */
export const POSITION_SCAN_LIMIT = 400;
