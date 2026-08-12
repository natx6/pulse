import type { CartLine, PaymentLine, SaleResult } from "../types";
import { useStore } from "../store/useStore";
import { fmtMoney } from "../lib/money";

interface Props {
  result: SaleResult;
  lines: CartLine[];
  subtotal: number;
  tax: number;
  paymentMethod: string;
  payments?: PaymentLine[];
  onClose(): void;
}

export function ReceiptModal({ result, lines, subtotal, tax, paymentMethod, payments, onClose }: Props) {
  const pharmacyName = useStore((s) => s.pharmacyName);
  const footer = useStore((s) => s.receiptFooter);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-background/30 p-4 backdrop-blur-[2px]">
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
            {tax > 0 && (
              <div className="flex justify-between text-on-surface-variant">
                <span>Tax</span>
                <span>{fmtMoney(tax)}</span>
              </div>
            )}
            <div className="flex justify-between pt-1 text-headline-md font-headline-md font-bold text-on-surface">
              <span>Total</span>
              <span>{fmtMoney(result.total)}</span>
            </div>
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
            {result.change > 0 && (
              <div className="flex justify-between text-primary">
                <span>Change</span>
                <span>{fmtMoney(result.change)}</span>
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
        <div className="flex gap-2 border-t border-outline-variant bg-surface-container px-6 py-4">
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
  );
}
