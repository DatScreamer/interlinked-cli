// Unit tests for nan-coercion.ts
//
// Covers:
//   Positive (MUST fire):
//     P1  inline Date.parse → relational (no guard)
//     P2  two-step Number() → if comparison (no guard)
//     P3  inline parseInt → relational (no guard)
//     P4  inline parseFloat → relational (no guard)
//     P5  two-step Date.parse → comparison on different line
//   Negative (MUST NOT fire):
//     N1  Number.isFinite guard present before comparison
//     N2  equality operator (=== / !==) — not a relational op
//     N3  coercion result only used in arithmetic (no comparison)
//     N4  isNaN guard present
//     N5  Number.isNaN guard present
//     N6  non-JS file (.py) — out of scope

import { describe, expect, it } from "vitest";
import { detectNaNCoercionGuards } from "./nan-coercion.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function lines(src: string): number[] {
	return detectNaNCoercionGuards(src, "src/util.ts").map((m) => m.line);
}

function fires(src: string): boolean {
	return detectNaNCoercionGuards(src, "src/util.ts").length > 0;
}

// ─── Positive cases ───────────────────────────────────────────────────────────

describe("detectNaNCoercionGuards — positive (must fire)", () => {
	it("P1: inline Date.parse() <= now with no guard", () => {
		const src = `
function isExpired(rec: { expires_at: string }): boolean {
  const now = Date.now();
  if (Date.parse(rec.expires_at) <= now) return true;
  return false;
}
`;
		expect(fires(src)).toBe(true);
		// Line 4 is the comparison
		const found = detectNaNCoercionGuards(src, "file.ts");
		expect(found.length).toBeGreaterThan(0);
		expect(found[0]?.text).toMatch(/nan_coercion_guard/);
	});

	it("P2: two-step Number() assignment then relational in if-statement", () => {
		const src = `
function checkLimit(input: string, limit: number): void {
  const n = Number(input);
  // do some other work
  if (n > limit) {
    throw new Error("exceeded");
  }
}
`;
		expect(fires(src)).toBe(true);
		const found = detectNaNCoercionGuards(src, "check.ts");
		expect(found.length).toBeGreaterThan(0);
	});

	it("P3: inline parseInt() < max with no guard", () => {
		const src = `const ok = parseInt(raw, 10) < MAX_RETRIES;`;
		expect(fires(src)).toBe(true);
	});

	it("P4: inline parseFloat() >= threshold with no guard", () => {
		const src = `if (parseFloat(value) >= THRESHOLD) doWork();`;
		expect(fires(src)).toBe(true);
	});

	it("P5: two-step Date.parse assignment then comparison on later line", () => {
		const src = `
function processEvent(ts: string, cutoff: number): boolean {
  const parsed = Date.parse(ts);
  const label = "event";
  return parsed < cutoff;
}
`;
		expect(fires(src)).toBe(true);
		const found = detectNaNCoercionGuards(src, "events.ts");
		// Should flag the return line, not the assignment
		const lineNos = found.map((m) => m.line);
		// The comparison is on line 5
		expect(lineNos.some((l) => l >= 4)).toBe(true);
	});

	it("P6: Number() > comparison (RHS coerce form)", () => {
		const src = `if (score > Number(raw)) { pass(); }`;
		expect(fires(src)).toBe(true);
	});
});

// ─── Negative cases ───────────────────────────────────────────────────────────

describe("detectNaNCoercionGuards — negative (must NOT fire)", () => {
	it("N1: Number.isFinite guard wrapping the comparison — should not fire", () => {
		const src = `
function inRange(raw: string, limit: number): boolean {
  const exp = Number(raw);
  if (Number.isFinite(exp) && exp <= limit) return true;
  return false;
}
`;
		expect(fires(src)).toBe(false);
	});

	it("N2: equality operator === not relational — should not fire", () => {
		const src = `const isZero = Number(x) === 0;`;
		expect(fires(src)).toBe(false);
	});

	it("N3: coercion result only used in arithmetic, no relational comparison", () => {
		const src = `
function offset(raw: string): number {
  const n = Number(raw);
  return n + 1;
}
`;
		expect(fires(src)).toBe(false);
	});

	it("N4: isNaN guard before comparison — should not fire", () => {
		const src = `
function lessThanMax(raw: string, max: number): boolean {
  const n = Number(raw);
  if (isNaN(n)) return false;
  return n < max;
}
`;
		expect(fires(src)).toBe(false);
	});

	it("N5: Number.isNaN guard before comparison — should not fire", () => {
		const src = `
function check(s: string, threshold: number): boolean {
  const v = parseFloat(s);
  if (!Number.isNaN(v) && v < threshold) return true;
  return false;
}
`;
		expect(fires(src)).toBe(false);
	});

	it("N6: non-JS file (.py) — out of scope, should not fire", () => {
		const src = `expiry = Date.parse(ts) <= now`;
		const found = detectNaNCoercionGuards(src, "script.py");
		expect(found).toHaveLength(0);
	});

	it("N7: !== operator not relational — should not fire", () => {
		const src = `const changed = parseInt(a, 10) !== parseInt(b, 10);`;
		expect(fires(src)).toBe(false);
	});

	it("N8: coercion in return without relational op — should not fire", () => {
		const src = `function parse(s: string): number { return Number(s); }`;
		expect(fires(src)).toBe(false);
	});
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("detectNaNCoercionGuards — edge cases", () => {
	it("does not fire on inline Number.isFinite wrapping the whole expression", () => {
		const src = `if (Number.isFinite(Date.parse(s)) && Date.parse(s) <= now) {}`;
		// Guard is present — should not fire
		expect(fires(src)).toBe(false);
	});

	it("counts multiple unguarded comparisons in one file", () => {
		const src = `
if (Date.parse(a) < Date.now()) {}
if (parseInt(b, 10) > 100) {}
`;
		const found = detectNaNCoercionGuards(src, "multi.ts");
		expect(found.length).toBeGreaterThanOrEqual(2);
	});

	it("caps results at 10 per file", () => {
		// Repeat the flagged pattern 15 times
		const lines15 = Array.from({ length: 15 }, (_, i) =>
			`if (Number(raw${i}) > 0) {}`,
		).join("\n");
		const found = detectNaNCoercionGuards(lines15, "cap.ts");
		expect(found.length).toBeLessThanOrEqual(10);
	});
});
