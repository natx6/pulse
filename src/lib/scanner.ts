/**
 * Global USB barcode scanner listener.
 * HID scanners behave like a fast keyboard: a burst of characters ending
 * with Enter. We buffer keystrokes and only treat the buffer as a scan when
 * the gap between keys is tiny (<80ms), so a human typing normally never
 * triggers it. Focused text inputs handle their own Enter (search etc.).
 */
export function initScanner(handler: (code: string) => void): () => void {
  let buf = "";
  let last = 0;

  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    // OS key auto-repeat fires ~30ms apart — inside the scan-burst window.
    // Without this, holding a letter builds a junk "barcode".
    if (e.repeat) return;

    if (e.key === "Enter") {
      if (buf.length >= 6) {
        e.preventDefault();
        const code = buf;
        buf = "";
        handler(code);
      } else {
        buf = "";
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;

    const now = performance.now();
    if (now - last > 80) buf = ""; // slow typing → start a fresh buffer
    last = now;
    buf += e.key;
    if (buf.length > 48) buf = "";
  };

  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
