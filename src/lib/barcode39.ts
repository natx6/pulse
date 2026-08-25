// Hand-rolled Code39 encoder (zero deps). Each symbol is 9 elements —
// 5 bars and 4 spaces, of which 3 are wide (1) and 6 narrow (0).
// Wide elements are 3× the narrow width. Returns bar rectangles in
// narrow-width units so the caller can scale freely.
const PATTERNS: Record<string, string> = {
  "0": "000110100", "1": "100100001", "2": "001100001", "3": "101100000",
  "4": "000110001", "5": "100110000", "6": "001110000", "7": "000100101",
  "8": "100100100", "9": "001100100",
  A: "100001001", B: "001001001", C: "101001000", D: "000011001",
  E: "100011000", F: "001011000", G: "000001101", H: "100001100",
  I: "001001100", J: "000011100",
  K: "100000011", L: "001000011", M: "101000010", N: "000010011",
  O: "100010010", P: "001010010", Q: "000000111", R: "100000110",
  S: "001000110", T: "000010110",
  U: "110000001", V: "011000001", W: "111000000", X: "010010001",
  Y: "110010000", Z: "011010000",
  "-": "010000101", ".": "110000100", " ": "011000100",
  $: "010101000", "/": "010100010", "+": "010001010", "%": "000101010",
  "*": "010010100", // start/stop
};

const VALID = new Set(Object.keys(PATTERNS));

/** Bars for `code`, wrapped in the * start/stop markers, in narrow units.
 * Throws on characters outside the Code39 charset — silently dropping them
 * would print a barcode that scans as different data. */
export function code39Bars(code: string): { x: number; width: number }[] {
  const src = `*${code.toUpperCase()}*`;
  const bars: { x: number; width: number }[] = [];
  let x = 0;
  for (const ch of src) {
    const pat = PATTERNS[ch];
    if (!pat) {
      throw new Error(`Code39 cannot encode "${ch}" — use A–Z, 0–9, - . space $ / + %`);
    }
    for (let i = 0; i < 9; i++) {
      if (i % 2 === 0) bars.push({ x, width: pat[i] === "1" ? 3 : 1 });
      x += pat[i] === "1" ? 3 : 1;
    }
    x += 1; // inter-character narrow gap
  }
  return bars;
}

/** Total width of the symbol in narrow units (0 if nothing encodable). */
export function code39Width(code: string): number {
  const bars = code39Bars(code);
  if (bars.length === 0) return 0;
  const last = bars[bars.length - 1];
  return last.x + last.width;
}

/** True when every character (after trimming) is encodable. */
export function code39Valid(code: string): boolean {
  const s = code.trim().toUpperCase();
  if (!s) return false;
  return s.split("").every((ch) => VALID.has(ch));
}
