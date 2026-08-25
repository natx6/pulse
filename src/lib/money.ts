/** Format cedis for display. NaN/Infinity render as "0.00" rather than
 * leaking "NaN" into a money column, and thousands are grouped (1,234.50). */
export function fmtMoney(n: number): string {
  const safe = Number.isFinite(n) ? n : 0;
  const grouped = safe.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `GH₵ ${grouped}`;
}
