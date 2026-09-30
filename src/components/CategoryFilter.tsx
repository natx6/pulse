import { useEffect, useMemo, useRef, useState } from "react";

export interface CategoryCount {
  name: string;
  count: number;
}

/** Searchable category picker for the counter: type to narrow, Enter takes
 * the top match, Escape backs out. Counts come along so workers can see
 * at a glance where the shelf is. */
export function CategoryFilter({
  categories,
  value,
  onChange,
}: {
  categories: CategoryCount[];
  value: string;
  onChange(v: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const total = categories.reduce((s, c) => s + c.count, 0);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = needle
      ? categories.filter((c) => c.name.toLowerCase().includes(needle))
      : categories;
    return [{ name: "All Categories", count: total }, ...rows];
  }, [categories, q, total]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open ]);

  useEffect(() => setActive(0), [q]);

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Filter by category — type to search"
        className="flex h-10 max-w-56 items-center gap-2 rounded border border-outline-variant bg-surface px-3 text-body-sm text-on-surface hover:bg-surface-variant focus:border-primary focus:outline-none"
      >
        <span className="material-symbols-outlined text-[18px] text-on-surface-variant">category</span>
        <span className="truncate">{value}</span>
        <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-64 overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg">
          <div className="border-b border-outline-variant/50 p-2">
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setOpen(false);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const target = list[Math.min(active, list.length - 1)];
                  if (target) pick(target.name);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, list.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                }
              }}
              placeholder="Search categories…"
              className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-sm text-on-surface focus:border-primary focus:outline-none"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {list.length === 0 && (
              <li className="px-4 py-3 text-center text-body-sm text-on-surface-variant">
                No categories match.
              </li>
            )}
            {list.map((c, i) => (
              <li key={c.name}>
                <button
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(c.name)}
                  className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-body-sm ${
                    i === active ? "bg-primary/10 text-on-surface" : "text-on-surface"
                  } ${c.name === value ? "font-bold" : ""}`}
                >
                  <span className="truncate">{c.name}</span>
                  <span className="shrink-0 rounded bg-surface-container px-1.5 text-[11px] text-on-surface-variant">
                    {c.count}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
