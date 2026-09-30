import type { BatchRow } from "../types";

export interface BatchPart {
  batch: string;
  expiry: string;
  qty: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2027-03-15" -> "15 Mar 2027". Falls back to the raw string when unparseable. */
export function formatExpiryDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return iso;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** True when a YYYY-MM-DD expiry is before today (lexicographic compare is safe). */
export function isExpired(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso.trim())) return false;
  return iso.slice(0, 10) < todayIso();
}

export function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse a sale_items.batches breakdown ("AX8821@2027-03-15x2;CT-2301x1"). */
export function parseBatchBreakdown(s: string): BatchPart[] {
  const out: BatchPart[] = [];
  for (const raw of s.split(";")) {
    const part = raw.trim();
    if (!part) continue;
    const x = part.lastIndexOf("x");
    if (x < 0) continue;
    const qty = Number(part.slice(x + 1));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const head = part.slice(0, x);
    const at = head.indexOf("@");
    out.push({
      batch: at < 0 ? head : head.slice(0, at),
      expiry: at < 0 ? "" : head.slice(at + 1),
      qty,
    });
  }
  return out;
}

/** "AX8821@2027-03-15x2;CT-2301x1" -> "AX8821 exp 15 Mar 2027 x2 + CT-2301 x1".
 * ASCII-only so it survives thermal (CP437) printing. */
export function formatBatchBreakdown(s: string | null | undefined): string {
  if (!s?.trim()) return "";
  return parseBatchBreakdown(s)
    .map((p) => {
      const b = p.batch || "no-batch";
      const e = p.expiry ? ` exp ${formatExpiryDate(p.expiry)}` : "";
      return `${b}${e} x${p.qty}`;
    })
    .join(" + ");
}

/** Greedy FEFO allocation mirroring the Rust fefo_deduct order: `batches`
 * must already be nearest-expiry-first (as loadBatches returns them).
 * Skips zero-qty rows. Pure preview — the sale transaction stays authoritative. */
export function allocatePick(batches: BatchRow[], qty: number): BatchPart[] {
  const out: BatchPart[] = [];
  let remaining = qty;
  for (const b of batches) {
    if (remaining <= 0) break;
    const have = Number(b.quantity) || 0;
    if (have <= 0) continue;
    const take = Math.min(have, remaining);
    remaining -= take;
    out.push({ batch: b.batch_no ?? "", expiry: b.expiry_date ?? "", qty: take });
  }
  return out;
}
