import { describe, expect, it } from "vitest";
import { checkCleanupSkippedOnEarlyExit } from "./cleanup-early-exit.js";

const TS = "src/lib/foo.ts";

describe("checkCleanupSkippedOnEarlyExit — positive cases", () => {
	it("flags setInterval acquisition with throw before clearInterval", () => {
		const code = [
			"function bug() {",
			"  const id = setInterval(() => tick(), 1000);",
			"  if (cond) throw new Error('bad');",
			"  clearInterval(id);",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags addEventListener with early return before removeEventListener", () => {
		const code = [
			"function bug(target: EventTarget, handler: () => void) {",
			"  target.addEventListener('click', handler);",
			"  if (!enabled) return;",
			"  target.removeEventListener('click', handler);",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags setTimeout acquisition with throw before clearTimeout", () => {
		const code = [
			"function bug() {",
			"  const tid = setTimeout(fire, 100);",
			"  if (failed) throw new Error('boom');",
			"  clearTimeout(tid);",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags subscribe acquisition with early return before unsubscribe", () => {
		const code = [
			"function bug(stream: any) {",
			"  const sub = stream.subscribe((x: number) => handle(x));",
			"  if (!ready) return null;",
			"  sub.unsubscribe();",
			"  return ok();",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkCleanupSkippedOnEarlyExit — negative cases (must NOT fire)", () => {
	it("ignores acquisition wrapped in try/finally", () => {
		const code = [
			"function ok() {",
			"  const id = setInterval(tick, 1000);",
			"  try {",
			"    if (cond) throw new Error('bad');",
			"  } finally {",
			"    clearInterval(id);",
			"  }",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS)).toEqual([]);
	});

	it("ignores when cleanup runs BEFORE the throw on the same path", () => {
		const code = [
			"function ok() {",
			"  const id = setInterval(tick, 1000);",
			"  if (cond) {",
			"    clearInterval(id);",
			"    throw new Error('bad');",
			"  }",
			"  clearInterval(id);",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS)).toEqual([]);
	});

	it("ignores function with no early throw/return between acquire and release", () => {
		const code = [
			"function ok() {",
			"  const id = setInterval(tick, 1000);",
			"  doStuff();",
			"  clearInterval(id);",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS)).toEqual([]);
	});

	it("ignores acquisition with no paired cleanup in the function (different bug class)", () => {
		// If there's no cleanup at all in the same function, that's the
		// `lifecycle_cleanup` bug class, not this one. We only fire when
		// cleanup IS present but skipped on an early-exit path.
		const code = [
			"function fireAndForget() {",
			"  setInterval(tick, 1000);",
			"  if (cond) throw new Error('bad');",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS)).toEqual([]);
	});

	it("ignores throw/return that PRECEDES the acquisition", () => {
		const code = [
			"function ok(input: number) {",
			"  if (input < 0) throw new Error('bad');",
			"  const id = setInterval(tick, 1000);",
			"  clearInterval(id);",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS)).toEqual([]);
	});
});
