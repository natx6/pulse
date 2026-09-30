import { useEffect, useState } from "react";
import { loadBatches } from "../db";
import type { BatchRow } from "../types";
import { allocatePick, formatExpiryDate, isExpired } from "../lib/batches";

/** Which physical boxes the worker should hand over for this cart line —
 * a read-only FEFO preview (nearest expiry first). The sale transaction in
 * Rust stays authoritative; this just keeps the hand off the shelf matched
 * to what the ledger will deduct. */
export function PickHint({ productId, qty }: { productId: number; qty: number }) {
  const [rows, setRows] = useState<BatchRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    void loadBatches(productId)
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch(() => {
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, [productId]);

  if (!rows) return null;
  const parts = allocatePick(rows, qty);
  if (parts.length === 0) return null;

  const dated = parts.filter((p) => p.expiry);
  const anyExpired = parts.some((p) => p.expiry && isExpired(p.expiry));

  const text =
    parts.length === 1 && !dated.length
      ? "Pick: any box (no expiry tracked)"
      : `Pick: ${parts
          .map((p) => {
            const b = p.batch || "no-batch";
            const e = p.expiry ? ` · exp ${formatExpiryDate(p.expiry)}` : "";
            const n = parts.length > 1 || p.qty !== qty ? ` ×${p.qty}` : "";
            return `${b}${e}${n}`;
          })
          .join(" + ")}`;

  return (
    <p
      className={`mt-0.5 font-data-mono text-data-mono ${
        anyExpired ? "font-bold text-error" : "text-primary"
      }`}
    >
      {anyExpired && "EXPIRED — do not sell · "}
      {text}
    </p>
  );
}
