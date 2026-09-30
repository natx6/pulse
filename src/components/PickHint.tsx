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

  const anyExpired = parts.some((p) => p.expiry && isExpired(p.expiry));
  const undatedOnly = parts.length === 1 && !parts[0].expiry;

  return (
    <div className="mt-0.5 font-data-mono text-data-mono">
      {anyExpired ? (
        <p className="font-bold text-error">EXPIRED — do not sell</p>
      ) : (
        <p className="text-primary">Pick:</p>
      )}
      {undatedOnly ? (
        <p className="pl-2 text-primary">any box (no expiry tracked)</p>
      ) : (
        parts.map((p, i) => (
          <p
            key={i}
            className={`pl-2 ${p.expiry && isExpired(p.expiry) ? "font-bold text-error" : "text-primary"}`}
          >
            {p.batch || "no-batch"}
            {p.expiry ? ` · exp ${formatExpiryDate(p.expiry)}` : ""}
            {parts.length > 1 || p.qty !== qty ? ` ×${p.qty}` : ""}
          </p>
        ))
      )}
    </div>
  );
}
