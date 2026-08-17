import { useMemo } from "react";
import { useStore } from "../store/useStore";
import { fmtMoney } from "../lib/money";
import type { Purchase, PurchaseItem } from "../db";

interface Props {
  p: Purchase;
  items: PurchaseItem[];
  onClose(): void;
}

const th = "border border-black px-2 py-1 text-left text-[11px] font-bold uppercase tracking-wide";
const td = "border border-black px-2 py-1 text-[12px]";

/** Print an A4 purchase order / requisition form — the artifact to send or read
 * out to the supplier when placing the order by phone/WhatsApp. Black-on-white
 * and print-safe: only #po-area survives @media print (see styles.css). */
export function PrintPOModal({ p, items, onClose }: Props) {
  const pharmacyName = useStore((s) => s.pharmacyName);
  const subtotal = useMemo(() => items.reduce((s, it) => s + it.line_total, 0), [items]);
  const statusLabel =
    p.status === "Received"
      ? "Received — record of delivery"
      : p.status === "Ordered"
        ? "Ordered — awaiting delivery"
        : "Draft — not yet sent";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-6 py-4">
          <div>
            <h3 className="text-headline-md font-headline-md text-on-surface">Print Order</h3>
            <p className="text-body-sm font-body-sm text-on-surface-variant">
              A4 purchase order for {p.reference_no ?? p.id}. Send it, read it out,
              or keep it as the signed record.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-variant"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto bg-surface-container-lowest p-6">
          <div id="po-area" className="mx-auto bg-white p-8 text-black shadow-sm">
            {/* Header */}
            <div className="mb-6 flex items-start justify-between">
              <div>
                <p className="text-[20px] font-black uppercase tracking-tight">{pharmacyName}</p>
                <p className="text-[12px] text-black/70">Purchase order / requisition</p>
              </div>
              <div className="text-right">
                <p className="text-[16px] font-bold uppercase tracking-wider">Purchase Order</p>
                <p className="font-mono text-[13px] font-semibold">{p.reference_no ?? p.id}</p>
                <p className="text-[12px]">Date: {p.purchase_date}</p>
                <p className="text-[12px]">Pay term: {p.pay_term ?? "Cash"}</p>
                <p className="text-[12px]">Status: {statusLabel}</p>
              </div>
            </div>

            {/* Supplier */}
            <div className="mb-6 rounded border border-black/40 p-3">
              <p className="text-[11px] font-bold uppercase tracking-wide">Supplier</p>
              <p className="text-[15px] font-semibold">{p.supplier_name ?? "— no supplier —"}</p>
              {(p.supplier_phone || p.supplier_location) && (
                <p className="text-[12px] text-black/70">
                  {[p.supplier_phone, p.supplier_location].filter(Boolean).join(" · ")}
                </p>
              )}
              <p className="mt-2 text-[11px] italic">
                Please supply the items listed below and deliver with an invoice / delivery note.
              </p>
            </div>

            {/* Lines */}
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={`${th} w-6`}>#</th>
                  <th className={th}>Product</th>
                  <th className={`${th} w-16`}>Unit</th>
                  <th className={`${th} w-12 text-right`}>Qty</th>
                  <th className={`${th} w-20 text-right`}>Unit cost</th>
                  <th className={`${th} w-12 text-right`}>Disc %</th>
                  <th className={`${th} w-20 text-right`}>Net cost</th>
                  <th className={`${th} w-24 text-right`}>Line total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={it.id}>
                    <td className={`${td} text-right`}>{i + 1}</td>
                    <td className={td}>{it.product_name}</td>
                    <td className={td}>{it.unit_type}</td>
                    <td className={`${td} text-right`}>{it.quantity}</td>
                    <td className={`${td} text-right`}>{fmtMoney(it.unit_cost_net)}</td>
                    <td className={`${td} text-right`}>
                      {it.discount_percent > 0 ? `${it.discount_percent}%` : "—"}
                    </td>
                    <td className={`${td} text-right`}>{fmtMoney(it.unit_cost_net)}</td>
                    <td className={`${td} text-right font-semibold`}>{fmtMoney(it.line_total)}</td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td className={td} colSpan={8}>
                      No lines.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* Totals */}
            <div className="mt-4 flex justify-end">
              <div className="w-64 space-y-1 text-[13px]">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span>{fmtMoney(subtotal)}</span>
                </div>
                {p.discount_type !== "None" && (
                  <div className="flex justify-between">
                    <span>
                      Discount
                      {p.discount_type === "Fixed"
                        ? ""
                        : ` (${p.discount_amount}%)`}
                    </span>
                    <span>
                      {p.discount_type === "Fixed" ? `− ${fmtMoney(p.discount_amount)}` : "—"}
                    </span>
                  </div>
                )}
                <div className="flex justify-between border-t border-black pt-1 text-[15px] font-bold">
                  <span>Net total</span>
                  <span>{fmtMoney(p.total_amount)}</span>
                </div>
              </div>
            </div>

            {/* Signatures */}
            <div className="mt-10 grid grid-cols-3 gap-6">
              {["Prepared by", "Approved (Pharmacist-in-charge)", "Received by"].map((s) => (
                <div key={s}>
                  <p className="mb-6 text-[11px]">{s}: ______________________</p>
                  <p className="text-[11px]">Date: ________________</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex gap-2 border-t border-outline-variant bg-surface-container px-6 py-4">
          <button
            onClick={onClose}
            className="rounded border border-outline px-4 py-2 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
          >
            Close
          </button>
          <button
            onClick={() => window.print()}
            className="flex flex-1 items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant"
          >
            <span className="material-symbols-outlined text-[18px]">print</span>
            Print order
          </button>
        </div>
      </div>
    </div>
  );
}
