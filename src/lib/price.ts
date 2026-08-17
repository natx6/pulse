/**
 * Purchase pricing math — the ONLY place these formulas live on the frontend.
 * The Rust save_purchase command recomputes the same rules server-side; the
 * UI uses these for instant reactive feedback.
 */

/** Net unit cost after line discount: raw x (1 - discount%/100). */
export function netUnitCost(raw: number, discountPercent: number): number {
  return raw * (1 - (discountPercent || 0) / 100);
}

/** Line total: quantity x net unit cost. */
export function lineTotal(qty: number, net: number): number {
  return qty * net;
}

/** Profit margin % on selling price: (sp - net) / sp x 100. Null when the
 * selling price is 0 (undefined margin). */
export function profitMarginPct(selling: number, net: number): number | null {
  if (selling <= 0) return null;
  return ((selling - net) / selling) * 100;
}

/** Order net total: sum of line totals minus the overall discount
 * (Fixed = amount off, Percentage = % off). Never negative. */
export function orderTotal(
  lines: { line_total: number }[],
  discountType: string,
  discountAmount: number,
): number {
  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  const amt = discountAmount || 0;
  if (discountType === "Fixed") return Math.max(0, subtotal - amt);
  if (discountType === "Percentage") return subtotal * (1 - amt / 100);
  return subtotal;
}

/** Round to 2 decimals (currency). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
