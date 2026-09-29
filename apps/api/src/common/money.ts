/** All money is integer cents (BRL). Never use floats for currency. */

export function calcCommission(totalCents: number, takeRateBps: number): number {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new RangeError('totalCents must be a non-negative integer');
  if (!Number.isInteger(takeRateBps) || takeRateBps < 0 || takeRateBps > 10_000) {
    throw new RangeError('takeRateBps must be an integer in [0, 10000]');
  }
  // BigInt avoids float error and overflow; rounds half up.
  return Number((BigInt(totalCents) * BigInt(takeRateBps) + 5_000n) / 10_000n);
}

export interface PriceTier { minQty: number; priceCents: number }

/** Picks the tier with the highest minQty <= qty; falls back to the base wholesale price. */
export function resolveUnitPrice(baseCents: number, tiers: PriceTier[], qty: number): number {
  if (!Number.isInteger(qty) || qty < 1) throw new RangeError('qty must be a positive integer');
  let best: PriceTier | undefined;
  for (const t of tiers) {
    if (t.minQty <= qty && (!best || t.minQty > best.minQty)) best = t;
  }
  return best ? best.priceCents : baseCents;
}
