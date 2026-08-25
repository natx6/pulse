import { useState } from "react";
import type { CartLine, PaymentLine, SaleResult } from "../types";
import { useStore } from "../store/useStore";
import { fmtMoney } from "../lib/money";
import { getSettings, printThermalReceipt } from "../db";

interface Props {
  result: SaleResult;
  lines: CartLine[];
  subtotal: number;
  discountPct?: number;
  discountAmt?: number;
  tax: number;
  paymentMethod: string;
  payments?: PaymentLine[];
  onClose(): void;
}

export function ReceiptModal({ result, lines, subtotal, discountPct, discountAmt, tax, paymentMethod, payments, onClose }: Props) {
  const pharmacyName = useStore((s) => s.pharmacyName);
  const footer = useStore((s) => s.receiptFooter);
  const momoNumber = useStore((s) => s.momoNumber);
  const paidByMoMo =
    paymentMethod === "MoMo" || (payments ?? []).some((p) => p.method === "MoMo");

  // Direct-to-thermal printing state ("idle" | "busy" | "ok" | "err").
  const [thermal, setThermal] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [thermalMsg, setThermalMsg] = useState("");

  /** Send the receipt straight to the ESC/POS printer configured in
   * Settings — raw bytes over the LAN, no print dialog. Money is rendered
   * without the cedi sign here because thermal fonts are ASCII-only. */
  const doThermal = async () => {
    setThermal("busy");
    setThermalMsg("");
    try {
      const st = await getSettings();
      if (!st.printerHost.trim()) {
        throw new Error("No printer configured — set its address in Settings");
      }
      const ghs = (n: number) => n.toFixed(2);
      await printThermalReceipt({
        host: st.printerHost.trim(),
        port: st.printerPort,
        pharmacy_name: pharmacyName,
        receipt_no: result.receipt_no,
        timestamp: new Date().toLocaleString(),
        lines: lines.map((l) => ({
          name: l.name,
          detail: [l.unit ?? null, `${l.qty} x ${ghs(l.unitPrice)}`].filter(Boolean).join(" · "),
          amount: ghs(l.qty * l.unitPrice),
        })),
        subtotal: ghs(subtotal),
        discount:
          discountAmt && discountAmt > 0
            ? `-${ghs(discountAmt)} (${discountPct ?? 0}%)`
            : null,
        tax: tax > 0 ? ghs(tax) : null,
        total: ghs(result.total),
        payments: (payments ?? []).map(
          (p) => `${p.method} ${ghs(p.amount)}${p.reference ? ` ref ${p.reference}` : ""}`,
        ),
        change: result.change > 0 ? ghs(result.change) : null,
        footer: footer || null,
      });
      setThermal("ok");
    } catch (e) {
      setThermal("err");
      setThermalMsg(String(e).replace(/^Error: /, ""));
    }
  };

  return (
    <div
      data-modal-open className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]"
      onKeyDown={(e) => {
        // stopPropagation matters here specifically: this modal is sometimes
        // rendered nested inside another (e.g. PatientModal's reprint), and
        // without it one Escape press would bubble up and close both at once.
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="w-full max-w-sm rounded-xl border border-outline-variant bg-surface shadow-lg">
        <div id="receipt-area" className="p-6">
          <div className="text-center">
            <h3 className="text-headline-md font-headline-md font-bold text-on-surface">
              {pharmacyName}
            </h3>
            <p className="font-data-mono text-data-mono text-on-surface-variant">
              {result.receipt_no}
            </p>
            <p className="font-data-mono text-data-mono text-on-surface-variant">
              {new Date().toLocaleString()}
            </p>
          </div>
          <div className="my-4 border-t border-dashed border-outline-variant" />
          <div className="flex flex-col gap-1.5">
            {lines.map((l) => (
              <div key={l.productId} className="flex justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-body-sm font-body-sm font-semibold text-on-surface">
                    {l.name}
                  </p>
                  <p className="font-data-mono text-data-mono text-on-surface-variant">
                    {l.unit ? `${l.unit} · ` : ""}
                    {l.qty} × {fmtMoney(l.unitPrice)}
                  </p>
                </div>
                <span className="shrink-0 font-data-mono text-data-mono text-on-surface">
                  {fmtMoney(l.qty * l.unitPrice)}
                </span>
              </div>
            ))}
          </div>
          <div className="my-4 border-t border-dashed border-outline-variant" />
          <div className="flex flex-col gap-1 font-data-mono text-data-mono">
            <div className="flex justify-between text-on-surface-variant">
              <span>Subtotal</span>
              <span>{fmtMoney(subtotal)}</span>
            </div>
            {discountPct && discountPct > 0 && discountAmt && discountAmt > 0 && (
              <div className="flex justify-between text-primary">
                <span>Discount ({discountPct}%)</span>
                <span>−{fmtMoney(discountAmt)}</span>
              </div>
            )}
            {tax > 0 && (
              <div className="flex justify-between text-on-surface-variant">
                <span>Tax</span>
                <span>{fmtMoney(tax)}</span>
              </div>
            )}
            <div className="flex justify-between pt-1 border-t border-outline-variant pt-2">
              <span className="text-headline-md font-headline-md font-bold text-on-surface">Total</span>
              <span className="text-headline-md font-headline-md font-bold text-on-surface">{fmtMoney(result.total)}</span>
            </div>
            {payments && payments.length > 0 && (
              <div className="flex justify-between text-on-surface-variant">
                <span>Amount Paid</span>
                <span className="font-bold">{fmtMoney(payments.reduce((s, p) => s + p.amount, 0))}</span>
              </div>
            )}
            <div className="flex justify-between text-on-surface-variant">
              <span>Payment</span>
              <span>{paymentMethod}</span>
            </div>
            {payments && payments.length > 1 && (
              <div className="flex flex-col items-end gap-0.5 text-on-surface-variant">
                {payments.map((p) => (
                  <span key={p.method} className="font-data-mono text-data-mono">
                    {p.method} {fmtMoney(p.amount)}
                    {p.reference ? ` · ${p.reference}` : ""}
                  </span>
                ))}
              </div>
            )}
            {payments && payments.length === 1 && payments[0].reference && (
              <div className="flex justify-between text-on-surface-variant">
                <span>Ref</span>
                <span>{payments[0].reference}</span>
              </div>
            )}
            {paidByMoMo && momoNumber && (
              <div className="flex justify-between text-on-surface-variant">
                <span>MoMo number</span>
                <span>{momoNumber}</span>
              </div>
            )}
            {result.change > 0 && (
              <div className="flex items-center justify-between rounded-lg bg-primary/10 px-3 py-2 -mx-3">
                <span className="text-headline-md font-headline-md font-bold text-primary">Give back</span>
                <span className="text-headline-lg font-headline-lg font-black text-primary">{fmtMoney(result.change)}</span>
              </div>
            )}
          </div>
          {footer && (
            <>
              <div className="my-4 border-t border-dashed border-outline-variant" />
              <p className="text-center text-body-sm font-body-sm text-on-surface-variant">
                {footer}
              </p>
            </>
          )}
        </div>
        <div className="border-t border-outline-variant bg-surface-container px-6 py-4">
          {thermal !== "idle" && (
            <p
              className={`mb-2 text-center text-body-sm font-body-sm ${
                thermal === "ok" ? "text-primary" : thermal === "err" ? "text-error" : "text-on-surface-variant"
              }`}
            >
              {thermal === "busy"
                ? "Printing…"
                : thermal === "ok"
                  ? "Sent to the printer."
                  : thermalMsg}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => void doThermal()}
              disabled={thermal === "busy"}
              title="Print straight to the thermal printer (set its address in Settings)"
              className="flex flex-1 items-center justify-center gap-1 rounded border border-outline px-3 py-2 text-on-surface hover:bg-surface-variant disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">receipt_long</span>
              <span className="text-label-md font-label-md">Thermal</span>
            </button>
            <button
              onClick={() => window.print()}
              className="flex flex-1 items-center justify-center gap-2 rounded border border-outline px-4 py-2 text-on-surface hover:bg-surface-variant"
            >
              <span className="material-symbols-outlined text-[18px]">print</span>
              <span className="text-label-md font-label-md">Print</span>
            </button>
            <button
              onClick={onClose}
              autoFocus
              className="flex-1 rounded bg-primary px-4 py-2 text-on-primary shadow-sm hover:bg-on-primary-fixed-variant"
            >
              <span className="text-label-md font-label-md">Done</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
