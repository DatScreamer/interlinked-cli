import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkHardcodedTimeoutInTests,
	checkRealIoInTests,
	checkTestNondeterminism,
	checkTestSubprocessDefaultTimeout,
} from "./test-hygiene-isolation.js";

const TEST = "src/lib/foo.test.ts";
const SRC = "src/lib/foo.ts";

describe("checkRealIoInTests", () => {
	it("flags fetch to a real URL", () => {
		const code = `await fetch("https://api.example.com/users");`;
		const matches = checkRealIoInTests(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("api.example.com");
	});

	it("does not fire on localhost / 127.0.0.1", () => {
		expect(
			checkRealIoInTests(`fetch("http://127.0.0.1:3000");`, TEST),
		).toEqual([]);
		expect(
			checkRealIoInTests(`fetch("http://localhost:8080/x");`, TEST),
		).toEqual([]);
	});

	it("flags writeFileSync to a real path", () => {
		const code = `writeFileSync("/etc/passwd", data);`;
		expect(checkRealIoInTests(code, TEST).length).toBe(1);
	});

	it("does not fire on writeFileSync to /tmp or __fixtures__", () => {
		expect(
			checkRealIoInTests(`writeFileSync("/tmp/test.txt", data);`, TEST),
		).toEqual([]);
		expect(
			checkRealIoInTests(`writeFileSync("__fixtures__/snap.txt", d);`, TEST),
		).toEqual([]);
	});

	it("does not fire in production source", () => {
		expect(
			checkRealIoInTests(`fetch("https://api.example.com/users");`, SRC),
		).toEqual([]);
	});

	it("does not flag a fetch() call that only appears inside a string literal", () => {
		// Test files routinely embed example code as string fixtures. A
		// fetch(...) inside a string is data, not a network call — the // in
		// its URL must not break string-stripping and expose the call.
		const code = `const fixture = "await fetch('https://api.example.com/x');";`;
		expect(checkRealIoInTests(code, TEST)).toEqual([]);
	});

	it("does not flag a writeFileSync that only appears inside a string literal", () => {
		// A detector's own test embeds writeFileSync(...) as a string fixture to
		// exercise the checker. The quoted write is sample data, not real I/O.
		const code = `const sample = 'writeFileSync("/etc/passwd", data);';`;
		expect(checkRealIoInTests(code, TEST)).toEqual([]);
	});

	it("does not flag a writeFileSync inside a template-literal fixture", () => {
		const code = ["const code = `", `  writeFileSync("/etc/passwd", data);`, "`;"].join("\n");
		expect(checkRealIoInTests(code, TEST)).toEqual([]);
	});

	it("does not flag calls to a locally-defined write helper (tmpdir wrapper)", () => {
		const code = [
			"function writeFile(name, bytes) { writeFileSync(join(dir, name), bytes); }",
			`it("x", () => { const p = writeFile("foo.log", 100); expect(p).toBeTruthy(); });`,
		].join("\n");
		expect(checkRealIoInTests(code, TEST)).toEqual([]);
	});

	it("still flags a raw writeFileSync to a real relative path", () => {
		const code = `it("x", () => { writeFileSync("out.txt", data); });`;
		expect(checkRealIoInTests(code, TEST).length).toBe(1);
	});
});

describe("checkTestNondeterminism", () => {
	it("flags Date.now() in test bodies", () => {
		expect(checkTestNondeterminism(`it("a", () => { const t = Date.now(); });`, TEST).length).toBe(1);
	});

	it("flags Math.random()", () => {
		expect(
			checkTestNondeterminism(`it("a", () => { const r = Math.random(); });`, TEST).length,
		).toBe(1);
	});

	it("does not fire when the file uses vi.useFakeTimers", () => {
		const code = `
beforeAll(() => { vi.useFakeTimers(); });
it("a", () => { const t = Date.now(); });
`;
		expect(checkTestNondeterminism(code, TEST)).toEqual([]);
	});

	it("does not fire on vi.setSystemTime call sites themselves", () => {
		expect(
			checkTestNondeterminism(`vi.setSystemTime(new Date(2024, 1, 1));`, TEST),
		).toEqual([]);
	});

	it("does not fire in non-test files", () => {
		expect(checkTestNondeterminism(`Date.now();`, SRC)).toEqual([]);
	});

	// --- FP refinements (2026-07): elapsed-time pairs, setSystemTime files,
	// --- unique fixture-name building.

	it("does not fire on the elapsed-time benchmark pair (Date.now() - start)", () => {
		const code = [
			'it("handles long strings efficiently", () => {',
			"  const start = Date.now();",
			"  const trigrams = extractTrigrams(longString);",
			"  const elapsed = Date.now() - start;",
			"  expect(elapsed).toBeLessThan(500);",
			"});",
		].join("\n");
		expect(checkTestNondeterminism(code, TEST)).toEqual([]);
	});

	it("does not fire on a performance.now() elapsed pair either", () => {
		const code = [
			"const t0 = performance.now();",
			"run();",
			"expect(performance.now() - t0).toBeLessThan(100);",
		].join("\n");
		expect(checkTestNondeterminism(code, TEST)).toEqual([]);
	});

	it("does not fire anywhere in a file that installs vi.setSystemTime", () => {
		const code = [
			"beforeAll(() => { vi.setSystemTime(new Date(2026, 1, 1)); });",
			'it("a", () => { const t = Date.now(); expect(fmt(t)).toBe("2026-02-01"); });',
		].join("\n");
		expect(checkTestNondeterminism(code, TEST)).toEqual([]);
	});

	it("does not fire on Date.now() concatenated into a unique fixture path", () => {
		const code = `const dir = join(tmpdir(), "fixture-" + Date.now()); mkdirSync(dir, { recursive: true });`;
		expect(checkTestNondeterminism(code, TEST)).toEqual([]);
	});

	it("does not fire on randomUUID() interpolated into a fixture name", () => {
		// Single-line template interpolations are blanked by the stripper, so
		// build a concat form + an interpolated form; neither may fire.
		const code = [
			'const sessionId = "sess-" + crypto.randomUUID();',
			"const file = join(dir, `run-${Date.now()}.jsonl`);",
		].join("\n");
		expect(checkTestNondeterminism(code, TEST)).toEqual([]);
	});

	it("STILL flags a lone Date.now() with no elapsed subtraction", () => {
		expect(
			checkTestNondeterminism(`it("a", () => { const t = Date.now(); use(t); });`, TEST).length,
		).toBe(1);
	});

	it("STILL flags Date.now() flowing into an asserted value", () => {
		const code = `it("a", () => { expect(Date.now()).toBeGreaterThan(record.ts); });`;
		expect(checkTestNondeterminism(code, TEST).length).toBe(1);
	});

	it("STILL flags a string-built id that is asserted on the same line", () => {
		const code = `expect(makeKey("k-" + Math.random())).toBe(expected);`;
		expect(checkTestNondeterminism(code, TEST).length).toBe(1);
	});
});

describe("checkHardcodedTimeoutInTests", () => {
	it("flags setTimeout(_, 1000) in tests", () => {
		const code = `await new Promise(r => setTimeout(r, 1000));`;
		expect(checkHardcodedTimeoutInTests(code, TEST).length).toBe(1);
	});

	it("does not fire on setTimeout(_, 0) microtask flush", () => {
		expect(
			checkHardcodedTimeoutInTests(`await new Promise(r => setTimeout(r, 0));`, TEST),
		).toEqual([]);
	});

	it("does not fire in non-test files", () => {
		expect(checkHardcodedTimeoutInTests(`setTimeout(fn, 5000);`, SRC)).toEqual([]);
	});
});

describe("checkTestSubprocessDefaultTimeout", () => {
	// --- positive: must fire ---
	it("flags an it() that runs tsc via execSync with no timeout", () => {
		const code = [
			'import { execSync } from "node:child_process";',
			'it("typechecks the fixture", () => {',
			'  const out = execSync("npx tsc --noEmit fixture.ts", { encoding: "utf8" });',
			'  expect(out).toBe("");',
			"});",
		].join("\n");
		const matches = checkTestSubprocessDefaultTimeout(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("known-slow subprocess");
		expect(nonNull(matches[0]).line).toBe(2);
	});

	it("flags a test() that spawnSyncs biome with no timeout", () => {
		const code = [
			'import { spawnSync } from "node:child_process";',
			'test("biome lints clean", async () => {',
			'  const r = spawnSync("biome", ["check", "src"]);',
			"  expect(r.status).toBe(0);",
			"});",
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST).length).toBe(1);
	});

	it("flags an it() spawning the project CLI via execFileSync with no timeout", () => {
		const code = [
			'import { execFileSync } from "node:child_process";',
			'it("interlinked verify exits clean", () => {',
			'  execFileSync("interlinked", ["verify", "--json"]);',
			"});",
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST).length).toBe(1);
	});

	// --- negative: must NOT fire ---
	it("does not fire when the it() already declares { timeout: N }", () => {
		const code = [
			'import { execSync } from "node:child_process";',
			'it("typechecks", { timeout: 60_000, retry: 2 }, () => {',
			'  execSync("npx tsc --noEmit");',
			"});",
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST)).toEqual([]);
	});

	it("does not fire when the it() passes a trailing numeric timeout", () => {
		const code = [
			'import { execSync } from "node:child_process";',
			'it("typechecks", () => {',
			'  execSync("npx tsc --noEmit");',
			"}, 60000);",
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST)).toEqual([]);
	});

	it("does not fire when the spawned command is trivially fast (echo)", () => {
		const code = [
			'import { execSync } from "node:child_process";',
			'it("echoes", () => {',
			'  expect(execSync("echo hello").toString()).toContain("hello");',
			"});",
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST)).toEqual([]);
	});

	it("does not fire when the test spawns no subprocess at all", () => {
		const code = [
			'import { add } from "./foo.js";',
			'it("adds", () => { expect(add(1, 2)).toBe(3); });',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST)).toEqual([]);
	});

	it("does not fire in production (non-test) source", () => {
		const code = [
			'import { execSync } from "node:child_process";',
			'export function build() { execSync("npx tsc --noEmit"); }',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, SRC)).toEqual([]);
	});

	it("does not fire when the slow command only appears inside a string fixture", () => {
		// A test that embeds example code as a string fixture must not be
		// mistaken for one that actually shells out — the execSync token is
		// data here, not a real call.
		const code = [
			'import { execSync } from "node:child_process";',
			'it("documents the command", () => {',
			'  const example = "execSync(npx tsc --noEmit)";',
			'  expect(example).toContain("tsc");',
			"});",
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST)).toEqual([]);
	});
});
