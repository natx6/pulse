import type { Operator } from "../db";

/** "HH:MM" current time as a zero-padded string (lexicographically sortable). */
export function nowHm(d: Date = new Date()): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The single operator whose shift window covers the given time, or null when
 * none (or more than one — ambiguous) does. Handles overnight shifts where
 * shift_end < shift_start.
 */
export function activeOperatorAt(operators: Operator[], d: Date = new Date()): Operator | null {
  const cur = nowHm(d);
  const active = operators.filter((op) => {
    if (!op.shift_start || !op.shift_end) return false;
    if (op.shift_start <= op.shift_end) return cur >= op.shift_start && cur <= op.shift_end;
    return cur >= op.shift_start || cur <= op.shift_end; // overnight
  });
  return active.length === 1 ? active[0] : null;
}
