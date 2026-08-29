import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { saveSetting } from "../db";
import { useStore } from "../store/useStore";
import type { PageId } from "../types";

interface Step {
  page?: PageId;
  /** data-tour anchor on the element to spotlight. Omit for a centered card. */
  target?: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    title: "Welcome to Pulse",
    body: "Here's a 30-second tour of the five things you'll use every day. You can skip anytime — and replay it later from the Support tab.",
  },
  {
    page: "pos",
    target: "tour-pos",
    title: "Make a sale",
    body: "Scan or search a product, then tap a payment method — Cash, Card or Mobile Money — to check out. The cart and totals are on the left.",
  },
  {
    page: "inventory",
    target: "tour-stock",
    title: "Your stock",
    body: "Every product and its batches live here, with reorder levels and expiry dates. Add new stock from the counter's “+” (Quick add), or import a supplier sheet.",
  },
  {
    page: "customers",
    target: "tour-customers",
    title: "Customers & credit",
    body: "Customers appear automatically after a sale. Open one to see their visit history and settle any outstanding credit.",
  },
  {
    page: "analytics",
    target: "tour-export",
    title: "Reports & tax",
    body: "See sales, VAT, discounts and the controlled-drug register. Export everything to CSV for your accountant or the auditor.",
  },
  {
    page: "settings",
    target: "tour-backup",
    title: "Back up",
    body: "Copy the database to a flash drive or second disk often — it's your insurance against theft, fire or a dead laptop.",
  },
  {
    title: "You're set",
    body: "That's the daily loop. Need help later? The Support tab has this tour, the keyboard shortcuts and contacts. Happy dispensing!",
  },
];

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** First-run product tour: a spotlight + tooltip that walks through the app. */
export function ProductTour() {
  const setPage = useStore((s) => s.setPage);
  const setTourOpen = useStore((s) => s.setTourOpen);
  const applySettings = useStore((s) => s.applySettings);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Box | null>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const cardRef = useRef<HTMLDivElement>(null);

  const finish = async () => {
    try {
      await saveSetting("tour_seen", "1");
    } catch {
      /* persistence is best-effort — the in-memory flag still hides the tour */
    }
    applySettings({ tourSeen: true });
    setTourOpen(false);
  };

  // Navigate to the step's page, scroll the anchor into view, then measure it.
  useLayoutEffect(() => {
    const s = STEPS[step];
    if (s.page) setPage(s.page);
    const measure = () => {
      const el = s.target ? document.querySelector<HTMLElement>(`[data-tour="${s.target}"]`) : null;
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        window.setTimeout(() => {
          const r = el.getBoundingClientRect();
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        }, 80);
      } else {
        setRect(null);
      }
    };
    // Give the (possibly new) page a beat to mount before measuring.
    const t = window.setTimeout(measure, s.page ? 240 : 80);
    return () => window.clearTimeout(t);
  }, [step, setPage]);

  // Position the tooltip card based on the spotlight rect (or center it).
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top: number;
    let left: number;
    if (rect) {
      const below = rect.top + rect.height + 12;
      const above = rect.top - 12 - ch;
      top = below + ch <= vh ? below : above > 12 ? above : Math.max(12, (vh - ch) / 2);
      left = rect.left + rect.width / 2 - cw / 2;
    } else {
      top = vh / 2 - ch / 2;
      left = vw / 2 - cw / 2;
    }
    left = Math.min(Math.max(12, left), vw - cw - 12);
    top = Math.min(Math.max(12, top), vh - ch - 12);
    setCardPos({ top, left });
  }, [rect, step]);

  // Recompute on resize and allow Escape to skip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void finish();
    };
    const onResize = () => {
      const s = STEPS[step];
      const el = s.target ? document.querySelector<HTMLElement>(`[data-tour="${s.target}"]`) : null;
      if (el) {
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [step, finish]);

  const last = step === STEPS.length - 1;
  const next = () => (last ? void finish() : setStep((i) => i + 1));
  const back = () => setStep((i) => Math.max(0, i - 1));

  return (
    <div className="fixed inset-0 z-[190]" role="dialog" aria-modal="true" aria-label="Product tour">
      {/* Click-block layer — keeps the app non-interactive during the tour. */}
      <div className="absolute inset-0" onClick={() => undefined} />

      {/* Spotlight: a transparent box whose huge shadow dims everything else. */}
      {rect && (
        <div
          className="pointer-events-none absolute rounded-xl ring-2 ring-primary"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.62)",
          }}
        />
      )}

      <div
        ref={cardRef}
        className="absolute z-[192] w-80 rounded-xl border border-outline-variant bg-surface p-4 shadow-2xl"
        style={{ top: cardPos.top, left: cardPos.left }}
      >
        <h3 className="text-title-md font-title-md font-medium text-on-surface">{STEPS[step].title}</h3>
        <p className="mt-1 text-body-sm font-body-sm text-on-surface-variant">{STEPS[step].body}</p>

        <div className="mt-3 flex items-center gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-4 bg-primary" : "w-1.5 bg-outline-variant"
              }`}
            />
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between">
          <button
            onClick={() => void finish()}
            className="rounded px-2 py-1 text-label-md font-label-md text-on-surface-variant hover:bg-surface-variant"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={back}
                className="rounded border border-outline-variant px-3 py-1 text-label-md font-label-md text-on-surface hover:bg-surface-variant"
              >
                Back
              </button>
            )}
            <button
              onClick={next}
              className="rounded bg-primary px-4 py-1 text-label-md font-label-md text-on-primary hover:bg-on-primary-fixed-variant"
            >
              {last ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
