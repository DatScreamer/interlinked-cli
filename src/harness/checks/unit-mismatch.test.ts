// Unit tests for unit-mismatch.ts (timeout_unit_mismatch)
//
// Covers:
//   Positive (MUST fire):
//     P1  setTimeout(fn, delaySeconds) — camelCase seconds name direct
//     P2  setInterval(fn, timeoutSec) — Sec suffix direct
//     P3  setTimeout(fn, retry_s) — snake _s suffix direct
//     P4  setTimeout(fn, delayMs * 1000) — inverse double-conversion
//     P5  setTimeout(fn, 1000 * intervalMillis) — inverse, reversed operands
//     P6  dotted path opts.timeoutSeconds direct; multi-line callback first arg
//   Negative (MUST NOT fire):
//     N1  setTimeout(fn, delaySeconds * 1000) — correct conversion
//     N2  setTimeout(fn, delayMs) — plain ms name direct
//     N3  setTimeout(fn, 5000) — numeric literal
//     N4  seconds-named var used elsewhere (not a timer delay)
//     N5  setTimeout(fn, timeoutMilliseconds) — "seconds" tail inside a ms name
//     N6  non-JS file (.py) — out of scope

import { describe, expect, it } from "vitest";
import { detectTimeoutUnitMismatch } from "./unit-mismatch.js";

function findings(src: string, path = "src/util.ts") {
	return detectTimeoutUnitMismatch(src, path);
}

function fires(src: string): boolean {
	return findings(src).length > 0;
}

// ─── Positive cases ───────────────────────────────────────────────────────────

describe("detectTimeoutUnitMismatch — positive (must fire)", () => {
	it("P1: setTimeout with a camelCase seconds-named identifier", () => {
		const src = `
const delaySeconds = 5;
setTimeout(() => retry(), delaySeconds);
`;
		const out = findings(src);
		expect(out.length).toBe(1);
		expect(out[0]?.line).toBe(3);
		expect(out[0]?.text).toContain("timeout_unit_mismatch");
		expect(out[0]?.text).toContain("delaySeconds");
	});

	it("P2: setInterval with a Sec-suffixed identifier", () => {
		const src = `setInterval(poll, timeoutSec);`;
		expect(fires(src)).toBe(true);
	});

	it("P3: setTimeout with a snake _s-suffixed identifier", () => {
		const src = `setTimeout(fn, retry_s);`;
		expect(fires(src)).toBe(true);
	});

	it("P4: inverse — ms-named identifier multiplied by 1000 inline", () => {
		const src = `setTimeout(fn, delayMs * 1000);`;
		const out = findings(src);
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("delayMs");
		expect(out[0]?.text).toContain("* 1000");
	});

	it("P5: inverse with reversed operands (1000 * intervalMillis)", () => {
		const src = `setInterval(tick, 1000 * intervalMillis);`;
		expect(fires(src)).toBe(true);
	});

	it("P6: dotted seconds path after a multi-line callback first arg", () => {
		const src = `
setTimeout(() => {
  cleanup();
  notify();
}, opts.timeoutSeconds);
`;
		const out = findings(src);
		expect(out.length).toBe(1);
		expect(out[0]?.line).toBe(5);
	});
});

// ─── Negative cases ───────────────────────────────────────────────────────────

describe("detectTimeoutUnitMismatch — negative (must NOT fire)", () => {
	it("N1: seconds-named identifier correctly multiplied by 1000", () => {
		const src = `setTimeout(fn, delaySeconds * 1000);`;
		expect(fires(src)).toBe(false);
	});

	it("N2: plain ms-named identifier passed directly", () => {
		const src = `
setTimeout(fn, delayMs);
setInterval(tick, poll_ms);
`;
		expect(fires(src)).toBe(false);
	});

	it("N3: numeric literal delay", () => {
		const src = `setTimeout(fn, 5000);`;
		expect(fires(src)).toBe(false);
	});

	it("N4: seconds-named variable used outside a timer delay", () => {
		const src = `
const waitSeconds = 30;
logger.info(waitSeconds);
sleep(waitSeconds);
`;
		expect(fires(src)).toBe(false);
	});

	it("N5: milliseconds name whose tail contains 'seconds'", () => {
		const src = `setTimeout(fn, timeoutMilliseconds);`;
		expect(fires(src)).toBe(false);
	});

	it("N6: non-JS file is out of scope", () => {
		const src = `setTimeout(fn, delaySeconds)`;
		expect(findings(src, "script.py").length).toBe(0);
	});

	it("N7: arithmetic other than the ms*1000 inverse never fires", () => {
		const src = `
setTimeout(fn, base + delaySeconds);
setTimeout(fn, delaySeconds / 2);
`;
		expect(fires(src)).toBe(false);
	});

	it("N8: identifier merely ending in 'ms' via a word (params) * 1000", () => {
		const src = `setTimeout(fn, params * 1000);`;
		expect(fires(src)).toBe(false);
	});
});
