import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkDuplicateTestNames,
	checkHappyPathOnlyTest,
	checkHardcodedTimeoutInTests,
	checkMockingTheSutSelf,
	checkMockOnlyTest,
	checkRealIoInTests,
	checkTestMissingSutImport,
	checkTestNondeterminism,
	checkTestSubprocessDefaultTimeout,
} from "./test-hygiene.js";

const TEST = "src/lib/foo.test.ts";
const SRC = "src/lib/foo.ts";

describe("checkDuplicateTestNames", () => {
	it("flags two it() blocks with identical names", () => {
		const code = `
it("returns 404 when missing", () => { expect(a).toBe(1); });
it("returns 404 when missing", () => { expect(b).toBe(2); });
`;
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("returns 404 when missing");
	});

	it("flags duplicate test() and specify() too", () => {
		const code = `
test("foo", () => {});
specify("foo", () => {});
`;
		expect(checkDuplicateTestNames(code, TEST).length).toBe(1);
	});

	it("does not fire on unique names", () => {
		const code = `it("foo", () => {}); it("bar", () => {});`;
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("does not fire on non-test files", () => {
		expect(checkDuplicateTestNames(`it("a"); it("a");`, SRC)).toEqual([]);
	});

	// Refinement (2026-05): parent-describe-aware deduplication.
	// Sibling describes can reuse a test name because the reporter shows the
	// full path (`describe > it`). Only flag when two `it()`s sit inside the
	// SAME enclosing describe body.
	it("does NOT fire on sibling describes that reuse the same it() name", () => {
		const code = `
describe("checkA", () => {
  it("does NOT fire for test files", () => {});
});
describe("checkB", () => {
  it("does NOT fire for test files", () => {});
});
describe("checkC", () => {
  it("does NOT fire for test files", () => {});
});
`;
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("STILL fires when two it()s share a name inside the SAME describe", () => {
		const code = `
describe("checkA", () => {
  it("works", () => {});
  it("works", () => {});
});
`;
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("same describe scope");
	});

	it("STILL fires when a nested describe duplicates a name from its own scope", () => {
		// The inner describe has two `it("inner")` — that's a real dup
		// inside the inner scope. The outer "inner" name is in a different
		// scope and shouldn't entangle the count.
		const code = `
describe("outer", () => {
  it("inner", () => {});
  describe("nested", () => {
    it("inner", () => {});
    it("inner", () => {});
  });
});
`;
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches.length).toBe(1);
	});
});

describe("checkDuplicateTestNames — comment / string / data-file FP regression", () => {
	it("does not read it() examples inside a line comment as declarations", () => {
		const code = `describe("d", () => {\n\t// docs: it("x") then again it("x")\n\tit("real", () => {});\n});`;
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("does not read it() examples inside a block comment as declarations", () => {
		const code = `describe("d", () => {\n\t/* it("y"); it("y"); */\n\tit("real", () => {});\n});`;
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("does not read it() inside a string-literal fixture as a declaration", () => {
		// The behavioral-checks.test.ts case: writeFileSync(f, "it('x')") test data.
		const code = [
			`describe("d", () => {`,
			`\twriteFileSync(a, "it('x', () => {});");`,
			`\twriteFileSync(b, "it('x', () => {});");`,
			`\tit("real", () => {});`,
			`});`,
		].join("\n");
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("still flags a genuine duplicate in real code (no over-suppression)", () => {
		const code = `describe("d", () => {\n\tit("dup", () => {});\n\tit("dup", () => {});\n});`;
		expect(checkDuplicateTestNames(code, TEST)).toHaveLength(1);
	});

	it("does not run on a content-scan-exempt source path (strict gate, not broad)", () => {
		// An absolute path under the package's own /harness/checks/ tree is
		// isTestFile-true (content-scan exemption) but isStrictTestFile-false, so a
		// test-hygiene check must skip it — the duplicate_test_names FP on
		// verification-stop-checks.ts.
		const code = `it("dup", () => {});\nit("dup", () => {});`;
		expect(checkDuplicateTestNames(code, resolve("src/harness/checks/some-detector.ts"))).toEqual(
			[],
		);
	});
});

describe("checkRealIoInTests", () => {
	it("flags fetch to a real URL", () => {
		const code = `await fetch("https://api.example.com/users");`;
		const matches = checkRealIoInTests(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("api.example.com");
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

describe("checkTestMissingSutImport", () => {
	it("flags a foo.test.ts that does not import ./foo", () => {
		const code = `
import { something } from "./bar.js";
it("does a thing", () => {});
`;
		const matches = checkTestMissingSutImport(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("does not fire when the SUT is imported", () => {
		const code = `
import { foo } from "./foo.js";
it("works", () => { expect(foo()).toBe(1); });
`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("does not fire when the SUT is imported via ../", () => {
		const code = `import { foo } from "../foo.js";`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("does not fire when the SUT is imported via require()", () => {
		const code = `const { foo } = require("./foo");`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("does not fire on index.test.ts (barrel file)", () => {
		expect(checkTestMissingSutImport(`it("a")`, "src/lib/index.test.ts")).toEqual([]);
	});

	it("does not fire in __fixtures__ paths", () => {
		expect(
			checkTestMissingSutImport(`it("a")`, "src/__fixtures__/foo.test.ts"),
		).toEqual([]);
	});

	// Tier 2 fallback (added 2026-05): the canonical multi-SUT grouping
	// pattern — a __tests__/-housed test file that imports its real SUT
	// from a parent directory under a different name.
	it("does not fire when the test imports a parent-directory source (multi-SUT grouping)", () => {
		const code = `import { foo, bar } from "../behavioral-checks.js";`;
		// File path mimics the real one from the FP report: tdd-cycle.test.ts
		// lives in __tests__/ and groups behavioral-checks-related TDD tests.
		const filePath = "src/harness/__tests__/tdd-cycle.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("STILL fires on a same-directory sibling import (misnamed test)", () => {
		// The original "performative test" bug class — a foo.test.ts that
		// imports something else from the same directory is still flagged.
		const code = `import { bar } from "./bar.js";`;
		expect(checkTestMissingSutImport(code, TEST)).not.toEqual([]);
	});

	it("STILL fires on a test that only imports __mocks__ / fixtures via parent dir", () => {
		const code = `import { mockFs } from "../__mocks__/fs.js";`;
		const filePath = "src/harness/__tests__/foo.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).not.toEqual([]);
	});
});

describe("checkMockingTheSutSelf", () => {
	it("flags vi.mock(\"./foo\") inside foo.test.ts", () => {
		const code = `vi.mock("./foo");`;
		const matches = checkMockingTheSutSelf(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("flags jest.mock(\"./foo\")", () => {
		expect(checkMockingTheSutSelf(`jest.mock("./foo.js");`, TEST).length).toBe(1);
	});

	it("does not fire when mocking a different module", () => {
		expect(checkMockingTheSutSelf(`vi.mock("./bar");`, TEST)).toEqual([]);
	});

	it("does not fire in production source", () => {
		expect(checkMockingTheSutSelf(`vi.mock("./foo");`, SRC)).toEqual([]);
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
		expect(matches[0].text).toContain("known-slow subprocess");
		expect(matches[0].line).toBe(2);
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

describe("checkMockOnlyTest", () => {
	// --- positive: must fire ---
	it("flags a block whose only assertion is toHaveBeenCalledWith", () => {
		const code = `it("calls the API", async () => {
			await run();
			expect(client.fetch).toHaveBeenCalledWith("/users", { page: 1 });
		});`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("mock interactions");
	});

	it("flags a block with multiple positive call assertions and no value check", () => {
		const code = `it("invokes the logger twice", () => {
			act();
			expect(log).toHaveBeenCalled();
			expect(log).toHaveBeenCalledTimes(2);
		});`;
		expect(checkMockOnlyTest(code, TEST).length).toBe(1);
	});

	it("flags a block mixing a negated and a positive call assertion", () => {
		const code = `it("logs but does not retry", () => {
			act();
			expect(retry).not.toHaveBeenCalled();
			expect(log).toHaveBeenCalledOnce();
		});`;
		expect(checkMockOnlyTest(code, TEST).length).toBe(1);
	});

	// --- negative: must NOT fire ---
	it("does not fire when the block also asserts a value", () => {
		const code = `it("returns the parsed result", async () => {
			const out = await run();
			expect(client.fetch).toHaveBeenCalledWith("/users");
			expect(out).toEqual({ ok: true });
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire when a named node:assert import asserts a value", () => {
		const code = `
		import { strictEqual, deepStrictEqual as sameShape } from "node:assert";

		it("returns the parsed result", async () => {
			const out = await run();
			expect(client.fetch).toHaveBeenCalledWith("/users");
			strictEqual(out.status, 200);
			sameShape(out.body, { ok: true });
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire when a destructured node:assert require asserts a value", () => {
		const code = `
		const { ok, deepStrictEqual: sameShape } = require("node:assert/strict");

		it("returns the parsed result", async () => {
			const out = await run();
			expect(client.fetch).toHaveBeenCalledWith("/users");
			ok(out.status === 200);
			sameShape(out.body, { ok: true });
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire on a pure not.toHaveBeenCalled() guard test", () => {
		const code = `it("does nothing when unauthenticated", async () => {
			await run({ authed: false });
			expect(client.fetch).not.toHaveBeenCalled();
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire on a zero call-count guard test", () => {
		const code = `it("does not call the API when unauthenticated", async () => {
			await run({ authed: false });
			expect(client.fetch).toHaveBeenCalledTimes(0);
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire on a block with only value assertions", () => {
		const code = `it("sums two values", () => { expect(add(1, 2)).toBe(3); });`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire on an assertion-free block", () => {
		const code = `it("just executes", () => { doThing(); });`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire in non-test source", () => {
		expect(checkMockOnlyTest(`expect(log).toHaveBeenCalled();`, SRC)).toEqual([]);
	});
});

describe("checkHappyPathOnlyTest", () => {
	// --- positive: must fire ---
	it("flags a 3-case file that only ever asserts success", () => {
		const code = `
		it("adds two numbers", () => { expect(add(1, 2)).toBe(3); });
		it("adds a larger pair", () => { expect(add(10, 5)).toBe(15); });
		it("concatenates", () => { expect(join("a", "b")).toBe("ab"); });
		`;
		const matches = checkHappyPathOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("never asserts a failure path");
	});

	it("flags a happy-only file using toEqual / toContain", () => {
		const code = `
		it("builds the list", () => { expect(build()).toEqual([1, 2]); });
		it("includes the head", () => { expect(build()).toContain(1); });
		it("has a length", () => { expect(build()).toHaveLength(2); });
		`;
		expect(checkHappyPathOnlyTest(code, TEST).length).toBe(1);
	});

	// --- negative: must NOT fire ---
	it("does not fire when a case uses .not", () => {
		const code = `
		it("sums alpha", () => { expect(x()).toBe(1); });
		it("sums beta", () => { expect(y()).toBe(2); });
		it("sums gamma", () => { expect(z()).not.toBe(9); });
		`;
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire when a case asserts a thrown error", () => {
		const code = `
		it("sums delta", () => { expect(x()).toBe(1); });
		it("sums epsilon", () => { expect(y()).toBe(2); });
		it("sums zeta", () => { expect(() => parse("")).toThrow(); });
		`;
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire when a test is named for a failure path", () => {
		const code = `
		it("returns the value", () => { expect(get()).toBe(1); });
		it("returns a second value", () => { expect(get2()).toBe(2); });
		it("handles invalid input", () => { expect(get3()).toBe(3); });
		`;
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire on a file with fewer than 3 cases", () => {
		const code = `
		it("sums theta", () => { expect(x()).toBe(1); });
		it("sums iota", () => { expect(y()).toBe(2); });
		`;
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not count todo cases toward the happy-path threshold", () => {
		const code = `
		it("sums theta", () => { expect(x()).toBe(1); });
		it("sums iota", () => { expect(y()).toBe(2); });
		test.todo("adds the failure path");
		`;
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("ignores skipped failure-path names when deciding whether to warn", () => {
		const code = `
		it("sums theta", () => { expect(x()).toBe(1); });
		it("sums iota", () => { expect(y()).toBe(2); });
		it("sums kappa", () => { expect(z()).toBe(3); });
		it.skip("rejects invalid input", () => { expect(() => parse("")).toThrow(); });
		`;
		const matches = checkHappyPathOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("never asserts a failure path");
	});

	it("does not count test-looking fixture strings or comments as real cases", () => {
		const code = [
			'it("sums theta", () => { expect(x()).toBe(1); });',
			"const fixture = `",
			'it("fixture alpha", () => { expect(alpha()).toBe(1); });',
			'it("fixture beta", () => { expect(beta()).toBe(2); });',
			'it("fixture gamma", () => { expect(gamma()).toBe(3); });',
			"`;",
			'// it("commented fixture", () => { expect(delta()).toBe(4); });',
			'it("sums iota", () => { expect(y()).toBe(2); });',
		].join("\n");
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire when a promise rejection is asserted", () => {
		const code = `
		it("sums kappa", () => { expect(x()).toBe(1); });
		it("sums omega", () => { expect(y()).toBe(2); });
		it("sums sigma", async () => { await expect(run()).rejects.toThrow(); });
		`;
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire in non-test source", () => {
		const code = `
		it("sums tau", () => { expect(x()).toBe(1); });
		it("sums phi", () => { expect(y()).toBe(2); });
		it("sums chi", () => { expect(z()).toBe(3); });
		`;
		expect(checkHappyPathOnlyTest(code, SRC)).toEqual([]);
	});
});
