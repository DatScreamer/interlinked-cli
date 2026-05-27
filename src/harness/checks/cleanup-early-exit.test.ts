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

// Effect-TS lessons port (docs/design/effect-ts-harness-additions.md §2.5):
// extend NAMED_ACQUISITIONS to cover file/socket/process handles. Same
// semantic — cleanup line exists but an early-exit bypasses it.
describe("checkCleanupSkippedOnEarlyExit — file/socket/process handles (Effect §2.5)", () => {
	it("flags fs.openSync acquisition with throw before fs.closeSync", () => {
		const code = [
			"import fs from 'node:fs';",
			"function bug() {",
			"  const fd = fs.openSync('a.txt', 'r');",
			"  if (corrupted) throw new Error('bad');",
			"  fs.closeSync(fd);",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags fs.createReadStream acquisition with early return before close", () => {
		const code = [
			"import fs from 'node:fs';",
			"function bug() {",
			"  const stream = fs.createReadStream('a.txt');",
			"  if (!ready) return;",
			"  stream.close();",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags fs.createWriteStream acquisition with early return before .destroy()", () => {
		const code = [
			"import fs from 'node:fs';",
			"function bug() {",
			"  const ws = fs.createWriteStream('out.txt');",
			"  if (failed) return;",
			"  ws.destroy();",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags child_process.spawn with throw before .kill()", () => {
		const code = [
			"import { spawn } from 'node:child_process';",
			"function bug() {",
			"  const child = spawn('ls');",
			"  if (cond) throw new Error('bad');",
			"  child.kill();",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag fs.openSync wrapped in try/finally", () => {
		const code = [
			"import fs from 'node:fs';",
			"function ok() {",
			"  const fd = fs.openSync('a.txt', 'r');",
			"  try {",
			"    if (corrupted) throw new Error('bad');",
			"  } finally {",
			"    fs.closeSync(fd);",
			"  }",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS)).toEqual([]);
	});

	it("does NOT flag fs.createReadStream returned from the function", () => {
		const code = [
			"import fs from 'node:fs';",
			"function ok() {",
			"  const stream = fs.createReadStream('a.txt');",
			"  return stream;",
			"}",
		].join("\n");
		// `return stream` precedes any cleanup line, so cleanup is genuinely
		// absent and this is a different bug class (lifecycle_cleanup), not
		// this one. Must not fire here.
		expect(checkCleanupSkippedOnEarlyExit(code, TS)).toEqual([]);
	});
});
