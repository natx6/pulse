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

  // Expired batches are never pickable: the warning names no batch, and only
  // sellable batches get pick lines. All-expired means warning alone; mixed
  // means warning plus the good remainder to hand over.
  const good = parts.filter((p) => !(p.expiry && isExpired(p.expiry)));
  const anyExpired = good.length !== parts.length;
  if (good.length === 0) {
    return (
      <div className="mt-0.5 font-data-mono text-data-mono">
        <p className="font-bold text-error">EXPIRED — do not sell</p>
      </div>
    );
  }
  const undatedOnly = good.length === 1 && !good[0].expiry;

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
        good.map((p, i) => (
          <p
            key={i}
            className="pl-2 text-primary"
          >
            {p.batch || "no-batch"}
            {p.expiry ? ` · exp ${formatExpiryDate(p.expiry)}` : ""}
            {good.length > 1 || p.qty !== qty ? ` ×${p.qty}` : ""}
          </p>
        ))
      )}
    </div>
  );
}
