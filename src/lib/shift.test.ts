import { describe, expect, it } from "vitest";
import { activeOperatorAt, nowHm } from "./shift";
import type { Operator } from "../db";

function op(name: string, start: string | null, end: string | null): Operator {
  return { id: 1, name, shift_start: start, shift_end: end };
}

function at(hm: string): Date {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date(2026, 0, 1, h, m);
  return d;
}

describe("nowHm", () => {
  it("formats as zero-padded HH:MM", () => {
    expect(nowHm(at("09:05"))).toBe("09:05");
    expect(nowHm(at("23:59"))).toBe("23:59");
  });
});

describe("activeOperatorAt", () => {
  it("finds the operator whose normal (same-day) shift covers the time", () => {
    const ops = [op("Ama", "08:00", "16:00"), op("Kofi", "16:00", "23:00")];
    expect(activeOperatorAt(ops, at("10:00"))?.name).toBe("Ama");
    expect(activeOperatorAt(ops, at("18:00"))?.name).toBe("Kofi");
  });

  it("handles an overnight shift (end time before start time)", () => {
    const ops = [op("Nightguard", "22:00", "06:00")];
    expect(activeOperatorAt(ops, at("23:30"))?.name).toBe("Nightguard");
    expect(activeOperatorAt(ops, at("02:00"))?.name).toBe("Nightguard");
    expect(activeOperatorAt(ops, at("12:00"))).toBeNull();
  });

  it("returns null when nobody's shift covers the time", () => {
    const ops = [op("Ama", "08:00", "16:00")];
    expect(activeOperatorAt(ops, at("20:00"))).toBeNull();
  });

  it("returns null when operators have no shift set", () => {
    const ops = [op("NoShift", null, null)];
    expect(activeOperatorAt(ops, at("10:00"))).toBeNull();
  });

  it("returns null when shifts overlap ambiguously", () => {
    const ops = [op("Ama", "08:00", "16:00"), op("Efo", "09:00", "17:00")];
    expect(activeOperatorAt(ops, at("10:00"))).toBeNull();
  });
});
