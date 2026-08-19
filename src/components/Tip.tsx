import { type ReactNode, useRef, useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

// Stable portal container — created once, reused by all tooltips.
let _container: HTMLDivElement | null = null;
function getContainer(): HTMLDivElement {
  if (!_container) {
    _container = document.createElement("div");
    _container.id = "tip-portal";
    document.body.appendChild(_container);
  }
  return _container;
}

/**
 * Tooltip that renders via a portal at the document body with fixed
 * positioning, so it is never clipped by overflow:hidden ancestors.
 * Falls back to dir="bottom" when there isn't enough space above.
 */
export function Tip({
  label,
  dir = "top",
  align = "center",
  children,
}: {
  label: string;
  dir?: "top" | "bottom";
  align?: "center" | "left" | "right";
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; actual: "top" | "bottom" } | null>(null);

  const update = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 8;
    const tooltipH = 28;
    const spaceAbove = r.top;
    const spaceBelow = window.innerHeight - r.bottom;

    let actualDir = dir;
    if (dir === "top" && spaceAbove < tooltipH + gap) actualDir = "bottom";
    if (dir === "bottom" && spaceBelow < tooltipH + gap) actualDir = "top";

    let x: number;
    if (align === "right") x = r.right;
    else if (align === "left") x = r.left;
    else x = r.left + r.width / 2;

    const y = actualDir === "top" ? r.top - gap : r.bottom + gap;

    setPos({ x, y, actual: actualDir });
  }, [dir, align]);

  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!hovered) { setPos(null); return; }
    update();
    const onScroll = () => update();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [hovered, update]);

  return (
    <span
      ref={triggerRef}
      className="group/tip relative inline-block"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
      {hovered && pos && label && createPortal(
        <span
          role="tooltip"
          className="pointer-events-none fixed z-[200] whitespace-nowrap rounded bg-inverse-surface px-2 py-1 text-[11px] font-semibold text-inverse-on-surface shadow"
          style={{
            left: pos.x,
            top: pos.actual === "top" ? undefined : pos.y,
            bottom: pos.actual === "top" ? window.innerHeight - pos.y : undefined,
            transform: align === "center" ? "translateX(-50%)" : align === "right" ? "translateX(-100%)" : undefined,
          }}
        >
          {label}
        </span>,
        getContainer(),
      )}
    </span>
  );
}
