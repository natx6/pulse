import type { ReactNode } from "react";

/**
 * Minimal tooltip: renders ABOVE the wrapped element (or below with dir),
 * never covering it, pointer-events-none, instant on hover.
 * align="right"/"left" pins the tooltip edge to the button edge so buttons
 * near the window edge don't clip. For icon-only and ambiguous buttons only.
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
  const pos =
    align === "right" ? "right-0" : align === "left" ? "left-0" : "left-1/2 -translate-x-1/2";
  return (
    <span className="group/tip relative inline-block">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 whitespace-nowrap rounded bg-inverse-surface px-2 py-1 text-[11px] font-semibold text-inverse-on-surface opacity-0 shadow transition-opacity duration-100 group-hover/tip:opacity-100 ${pos} ${
          dir === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
        }`}
      >
        {label}
      </span>
    </span>
  );
}
