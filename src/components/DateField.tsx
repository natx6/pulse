import { useEffect, useRef, useState } from "react";

/**
 * Drop-in replacement for <input type="date"> on WebKitGTK.
 *
 * The GTK native date-picker popup GRABS all input: clicks outside it never
 * reach the page at all, so no JS listener can dismiss it — only Esc works.
 * This component renders our own calendar instead, so click-out behaves like
 * everywhere else in the app. Value format is identical ("YYYY-MM-DD"), so
 * it's a swap-in for every existing date input.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function DateField({
  value,
  onChange,
  className = "",
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  // Flip the popup to right-aligned when there isn't room to open it to the
  // right (e.g. an end-of-range date near the screen edge).
  const [alignRight, setAlignRight] = useState(false);
  // Month shown in the popup; defaults to the value's month (or today's).
  const [view, setView] = useState(() => {
    const base = value && /^\d{4}-\d{2}/.test(value) ? new Date(value + "T00:00:00") : new Date();
    return { y: base.getFullYear(), m: base.getMonth() };
  });
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-away closes the popup. The popup itself is inside the root div,
  // so its own clicks are excluded by the contains() check.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const pick = (day: number) => {
    onChange(fmt(new Date(view.y, view.m, day)));
    setOpen(false);
  };

  // Grid: leading blanks for the weekday of the 1st, then the month's days.
  const first = new Date(view.y, view.m, 1).getDay();
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: first }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];

  const shift = (n: number) =>
    setView((v) => {
      const m = v.m + n;
      return { y: v.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 };
    });

  const display = value
    ? (() => {
        const d = new Date(value + "T00:00:00");
        return isNaN(d.getTime()) ? value : `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
      })()
    : "";
  const selected = value || "";

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        title={title}
        onClick={() => {
          // Decide alignment at open time from the viewport.
          const r = rootRef.current?.getBoundingClientRect();
          setAlignRight(!!r && window.innerWidth - r.left < 280);
          if (!open && selected && /^\d{4}-\d{2}/.test(selected)) {
            const d = new Date(selected + "T00:00:00");
            setView({ y: d.getFullYear(), m: d.getMonth() });
          }
          setOpen((o) => !o);
        }}
        className="h-full w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-left text-body-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      >
        {display || <span className="text-on-surface-variant">dd/mm/yyyy</span>}
      </button>
      {open && (
        <div className={`absolute top-full z-50 mt-1 w-64 rounded-lg border border-outline-variant bg-surface p-2 shadow-lg ${alignRight ? "right-0" : "left-0"}`}>
          <div className="mb-1 flex items-center justify-between px-1">
            <button type="button" onClick={() => shift(-1)} className="rounded px-1 text-on-surface hover:bg-surface-variant" aria-label="Previous month">‹</button>
            <span className="text-label-md font-label-md text-on-surface">
              {MONTHS[view.m]} {view.y}
            </span>
            <button type="button" onClick={() => shift(1)} className="rounded px-1 text-on-surface hover:bg-surface-variant" aria-label="Next month">›</button>
          </div>
          <div className="grid grid-cols-7 gap-y-0.5">
            {DOW.map((d) => (
              <span key={d} className="text-center text-[10px] text-on-surface-variant">{d}</span>
            ))}
            {cells.map((c, i) =>
              c === null ? (
                <span key={`b${i}`} />
              ) : (
                <button
                  key={c}
                  type="button"
                  onClick={() => pick(c)}
                  className={
                    "rounded py-0.5 text-center text-body-sm transition-colors " +
                    (selected === fmt(new Date(view.y, view.m, c))
                      ? "bg-primary text-on-primary"
                      : selected && c === new Date().getDate() && false
                        ? ""
                        : "text-on-surface hover:bg-surface-variant")
                  }
                >
                  {c}
                </button>
              ),
            )}
          </div>
          <div className="mt-1 flex justify-end border-t border-outline-variant/50 pt-1">
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                setView({ y: now.getFullYear(), m: now.getMonth() });
                pick(now.getDate());
              }}
              className="text-label-md font-label-md text-primary hover:underline"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
