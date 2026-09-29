/**
 * Unit and price arithmetic in bigint. Prices on this DEX are `priceX18`:
 * raw quote units per raw base unit, scaled by 1e18. A human price
 * ("1 SER9 = 0.42 USDC") therefore differs from priceX18 by
 * 10^(quoteDecimals - baseDecimals) as well as by 1e18.
 */
import { LIMITS } from './config.ts';

export const E18 = 10n ** 18n;
export const PPM = 1_000_000n;
export const BPS = 10_000n;

const DECIMAL_PATTERN = /^\d*(?:\.\d*)?$/;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** "1,234.5" → raw units. Rejects more fractional digits than the token has. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const normalized = text.trim().replace(/,/g, '');
  if (!DECIMAL_PATTERN.test(normalized) || normalized === '' || normalized === '.') return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) return null;
  return BigInt(whole || '0') * pow10(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Parse an arbitrary-precision decimal into (numerator, fractionDigits). */
function parseDecimal(text: string): { value: bigint; scale: number } | null {
  const normalized = text.trim().replace(/,/g, '');
  if (!DECIMAL_PATTERN.test(normalized) || normalized === '' || normalized === '.') return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  return { value: BigInt(`${whole || '0'}${fraction}`), scale: fraction.length };
}

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Truncating fixed-point formatter: `value / 10^scale` with at most `precision` decimals. */
export function formatFixed(value: bigint, scale: number, precision = 4): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = pow10(scale);
  const whole = abs / base;
  const fraction = abs % base;
  let text = groupThousands(whole.toString());
  if (precision > 0 && fraction > 0n) {
    const digits = fraction.toString().padStart(scale, '0').slice(0, precision).replace(/0+$/, '');
    if (digits) text += `.${digits}`;
  }
  return negative ? `-${text}` : text;
}

/**
 * Show `value / 10^scale` with `sig` significant digits, so both 0.00001234
 * and 12,345.6 read naturally. Truncates, never rounds up.
 */
export function formatSig(value: bigint, scale: number, sig = 6): string {
  if (value === 0n) return '0';
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const integerDigits = abs.toString().length - scale;
  let precision: number;
  if (integerDigits >= sig) precision = 0;
  else if (integerDigits > 0) precision = sig - integerDigits;
  else precision = -integerDigits + sig; // leading fractional zeros, then `sig` digits
  const text = formatFixed(abs, scale, Math.min(precision, scale));
  return negative ? `-${text}` : text;
}

export function formatAmount(value: bigint | null | undefined, decimals: number, sig = 6): string {
  if (value === null || value === undefined) return '—';
  return formatSig(value, decimals, sig);
}

/** Raw amount → string suitable for an input box (no grouping, full precision trimmed). */
export function toInputString(value: bigint, decimals: number, maxDecimals = 8): string {
  return formatFixed(value, decimals, Math.min(decimals, maxDecimals)).replace(/,/g, '');
}

// ─────────────────── prices ───────────────────

/** priceX18 → human quote-per-base, as a bigint scaled by 1e18. */
export function priceX18ToHumanE18(priceX18: bigint, baseDecimals: number, quoteDecimals: number): bigint {
  const shift = baseDecimals - quoteDecimals;
  return shift >= 0 ? priceX18 * pow10(shift) : priceX18 / pow10(-shift);
}

export function formatPriceX18(priceX18: bigint | null | undefined, baseDecimals: number, quoteDecimals: number, sig = 6): string {
  if (priceX18 === null || priceX18 === undefined || priceX18 === 0n) return '—';
  return formatSig(priceX18ToHumanE18(priceX18, baseDecimals, quoteDecimals), 18, sig);
}

/** Human price text → priceX18 (floored). */
export function parsePriceToX18(text: string, baseDecimals: number, quoteDecimals: number): bigint | null {
  const parsed = parseDecimal(text);
  if (!parsed || parsed.value === 0n) return null;
  const exponent = 18 + quoteDecimals - baseDecimals - parsed.scale;
  return exponent >= 0 ? parsed.value * pow10(exponent) : parsed.value / pow10(-exponent);
}

/** Smallest legal price step at this magnitude (`Pair.tickSizeAt`). */
export function tickSizeAt(priceX18: bigint): bigint {
  let tick = 1n;
  const ceiling = pow10(LIMITS.priceSigDigits);
  let price = priceX18;
  while (price >= ceiling) {
    price /= 10n;
    tick *= 10n;
  }
  return tick;
}

/** `Pair.priceIsValid`: at most six significant decimal digits. */
export function priceIsValid(priceX18: bigint): boolean {
  if (priceX18 <= 0n) return false;
  return priceX18 % tickSizeAt(priceX18) === 0n;
}

/**
 * Snap to the six-significant-digit grid the Pair accepts. Buys round down and
 * sells round up, so snapping never makes an order worse for its maker.
 */
export function snapPriceToGrid(priceX18: bigint, direction: 'down' | 'up'): bigint {
  if (priceX18 <= 0n) return 0n;
  const tick = tickSizeAt(priceX18);
  const floor = priceX18 - (priceX18 % tick);
  if (direction === 'down' || floor === priceX18) return floor === 0n ? tick : floor;
  return floor + tick;
}

/** Quote escrowed by a BUY: ceil(amountBase * priceX18 / 1e18), exactly as `placeOrder` pulls it. */
export function buyEscrow(amountBase: bigint, priceX18: bigint): bigint {
  const product = amountBase * priceX18;
  return (product + E18 - 1n) / E18;
}

export function quoteNotional(amountBase: bigint, priceX18: bigint): bigint {
  return (amountBase * priceX18) / E18;
}

/** Pool mid price as priceX18 for token0 (base) in token1 (quote). */
export function reservePriceX18(reserve0: bigint, reserve1: bigint): bigint | null {
  return reserve0 > 0n ? (reserve1 * E18) / reserve0 : null;
}

// ─────────────────── fees & percentages ───────────────────

export function formatPpm(ppm: bigint | number | null | undefined): string {
  if (ppm === null || ppm === undefined) return '—';
  const value = BigInt(ppm);
  // ppm / 1e4 = percent
  return `${formatFixed(value, 4, 4)}%`;
}

export function formatBps(bps: bigint | number): string {
  return `${formatFixed(BigInt(bps), 2, 2)}%`;
}

export function applySlippage(amount: bigint, slippageBps: bigint): bigint {
  return (amount * (BPS - slippageBps)) / BPS;
}

export function parseSlippageBps(text: string): bigint | null {
  const parsed = parseAmount(text, 2);
  if (parsed === null || parsed > 5000n) return null;
  return parsed;
}

/** Price impact of `amountIn` → `amountOut` against a pre-trade mid, in bps. */
export function priceImpactBps(amountIn: bigint, amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint | null {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return null;
  const ideal = (amountIn * reserveOut) / reserveIn;
  if (ideal === 0n) return null;
  return amountOut >= ideal ? 0n : ((ideal - amountOut) * BPS) / ideal;
}

export function ratioPct(part: bigint, total: bigint, decimals = 2): string {
  if (total === 0n) return '—';
  return `${formatFixed((part * 100n * pow10(decimals)) / total, decimals, decimals)}%`;
}

export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}
