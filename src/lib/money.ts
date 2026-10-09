/**
 * Money helpers. BistroBuddies is single-currency: every amount stored by
 * this API is Philippine Peso (PHP) and clients format it with ₱.
 */

/** The only currency this backend ever writes or returns. */
export const CURRENCY = 'PHP';

/** True for a finite number greater than 0 (a usable price in PHP). */
export function isPositivePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Returns the first candidate that is a usable PHP price, else null. */
export function resolvePrice(candidates: readonly unknown[]): number | null {
  for (const candidate of candidates) {
    if (isPositivePrice(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Rounds a monetary amount to 2 decimal places (PHP centavos). */
export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
