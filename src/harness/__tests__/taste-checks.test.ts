import { describe, expect, it } from "vitest";
import {
	checkAssertionFreeTest,
	checkAssertionRoulette,
	checkCommentedOutCode,
	checkConditionalInTest,
	checkDataClump,
	checkDuplicateDescribe,
	checkDuplicateSwitchDiscriminant,
	checkElseIfChain,
	checkEmptyCatch,
	checkFlagArgument,
	checkFunctionArgCount,
	checkFuzzyResponsibilityName,
	checkHybridClass,
	checkLawOfDemeter,
	checkLoopNestingDepth,
	checkMagicNumber,
	checkMockingTheSUT,
	checkNonDeterministicTest,
	checkPrivateMemberTestAccess,
	checkTautologicalAssertion,
	checkTestWithoutDescription,
} from "../taste-checks.js";

describe("checkAssertionFreeTest", () => {
	it("flags a test block with no assertion", () => {
		const content = `
			it("does a thing", () => {
				const x = compute();
			});
		`;
		expect(checkAssertionFreeTest(content, "/x/foo.test.ts").length).toBe(1);
	});

	it("passes a test with expect()", () => {
		const content = `
			it("does a thing", () => {
				expect(compute()).toBe(42);
			});
		`;
		expect(checkAssertionFreeTest(content, "/x/foo.test.ts")).toEqual([]);
	});

	it("passes a test with assert.equal", () => {
		const content = `
			it("ok", () => { assert.equal(a, b); });
		`;
		expect(checkAssertionFreeTest(content, "/x/foo.test.ts")).toEqual([]);
	});

	it("ignores it.todo / it.skip", () => {
		const content = 'it.todo("later");\nit.skip("nope", () => {});';
		expect(checkAssertionFreeTest(content, "/x/foo.test.ts")).toEqual([]);
	});

	it("skips non-test files", () => {
		const content = 'it("x", () => {});';
		expect(checkAssertionFreeTest(content, "/src/foo.ts")).toEqual([]);
	});
});

describe("checkTautologicalAssertion", () => {
	it("flags expect(x).toBe(x)", () => {
		const content = 'it("x", () => { expect(foo).toBe(foo); });';
		expect(checkTautologicalAssertion(content, "/x/foo.test.ts").length).toBe(1);
	});

	it("flags assert.equal(x, x)", () => {
		const content = 'it("x", () => { assert.equal(a, a); });';
		expect(checkTautologicalAssertion(content, "/x/foo.test.ts").length).toBe(1);
	});

	it("does not flag non-tautological asserts", () => {
		const content = 'it("x", () => { expect(foo).toBe(bar); });';
		expect(checkTautologicalAssertion(content, "/x/foo.test.ts")).toEqual([]);
	});
});

describe("checkMockingTheSUT", () => {
	it("flags foo.test.ts mocking ./foo", () => {
		const content = 'vi.mock("./foo");\nimport { foo } from "./foo";';
		expect(checkMockingTheSUT(content, "/x/foo.test.ts").length).toBe(1);
	});

	it("allows mocking a different module", () => {
		const content = 'vi.mock("./bar");';
		expect(checkMockingTheSUT(content, "/x/foo.test.ts")).toEqual([]);
	});

	it("flags jest.mock of the SUT", () => {
		const content = 'jest.mock("./bar");';
		expect(checkMockingTheSUT(content, "/x/bar.spec.ts").length).toBe(1);
	});
});

describe("checkPrivateMemberTestAccess", () => {
	it("flags (x as any).privateMethod()", () => {
		const content = "(obj as any).internal();";
		expect(checkPrivateMemberTestAccess(content, "/x/foo.test.ts").length).toBe(1);
	});

	it("ignores non-test files", () => {
		const content = "(x as any).y";
		expect(checkPrivateMemberTestAccess(content, "/src/foo.ts")).toEqual([]);
	});
});

describe("checkLoopNestingDepth", () => {
	it("flags triple-nested loops", () => {
		const content = `
			function f() {
				for (const a of xs) {
					for (const b of ys) {
						for (const c of zs) { g(a, b, c); }
					}
				}
			}
		`;
		expect(checkLoopNestingDepth(content, "/x/foo.ts").length).toBeGreaterThan(0);
	});

	it("allows double-nested loops", () => {
		const content = `
			for (const a of xs) {
				for (const b of ys) { g(a, b); }
			}
		`;
		expect(checkLoopNestingDepth(content, "/x/foo.ts")).toEqual([]);
	});
});

describe("checkElseIfChain", () => {
	it("flags three-branch chain", () => {
		const content = `
			if (a) { x(); } else if (b) { y(); } else if (c) { z(); }
		`;
		expect(checkElseIfChain(content, "/x/foo.ts").length).toBeGreaterThan(0);
	});

	it("allows two-branch chain", () => {
		const content = "if (a) { x(); } else if (b) { y(); }";
		expect(checkElseIfChain(content, "/x/foo.ts")).toEqual([]);
	});
});

describe("checkDuplicateSwitchDiscriminant", () => {
	it("flags repeated switch on same .kind", () => {
		const content = `
			function a(x) { switch (x.kind) { case "A": return 1; } }
			function b(x) { switch (x.kind) { case "B": return 2; } }
		`;
		expect(checkDuplicateSwitchDiscriminant(content, "/x/foo.ts").length).toBeGreaterThan(0);
	});

	it("does not flag a single switch", () => {
		const content = 'function a(x) { switch (x.kind) { case "A": return 1; } }';
		expect(checkDuplicateSwitchDiscriminant(content, "/x/foo.ts")).toEqual([]);
	});
});

describe("checkHybridClass", () => {
	it("flags class with public field + method", () => {
		const content = `
			class Thing {
				name: string = "";
				doThing() { return this.name.toUpperCase(); }
			}
		`;
		expect(checkHybridClass(content, "/x/foo.ts").length).toBe(1);
	});

	it("allows pure data class", () => {
		const content = `
			class Dto {
				id: string = "";
				name: string = "";
			}
		`;
		expect(checkHybridClass(content, "/x/foo.ts")).toEqual([]);
	});

	it("allows class with only methods", () => {
		const content = `
			class Service {
				constructor(private deps: Deps) {}
				run() { return this.deps.call(); }
			}
		`;
		expect(checkHybridClass(content, "/x/foo.ts")).toEqual([]);
	});
});

describe("checkFuzzyResponsibilityName", () => {
	it("flags ThingManager", () => {
		const content = "export class ThingManager {}";
		expect(checkFuzzyResponsibilityName(content, "/x/foo.ts").length).toBe(1);
	});

	it("flags FooUtils", () => {
		const content = "export class FooUtils {}";
		expect(checkFuzzyResponsibilityName(content, "/x/foo.ts").length).toBe(1);
	});

	it("passes domain-named classes", () => {
		const content = "export class Invoice {}";
		expect(checkFuzzyResponsibilityName(content, "/x/foo.ts")).toEqual([]);
	});
});

describe("checkLawOfDemeter", () => {
	it("flags five-deep chain", () => {
		const content = "const v = a.b.c.d.e;";
		expect(checkLawOfDemeter(content, "/src/foo.ts").length).toBe(1);
	});

	it("allows three-deep chain", () => {
		const content = "const v = a.b.c;";
		expect(checkLawOfDemeter(content, "/src/foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const content = "const v = a.b.c.d.e;";
		expect(checkLawOfDemeter(content, "/x/foo.test.ts")).toEqual([]);
	});
});

describe("checkFlagArgument", () => {
	it("flags positional boolean literal", () => {
		const content = "doThing(x, true);";
		expect(checkFlagArgument(content, "/src/foo.ts").length).toBe(1);
	});

	it("flags boolean-flag object arg", () => {
		const content = "doThing(x, { verbose: true });";
		expect(checkFlagArgument(content, "/src/foo.ts").length).toBe(1);
	});

	it("allows safe builtins", () => {
		const content = 'element.setAttribute("x", true);';
		expect(checkFlagArgument(content, "/src/foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const content = "doThing(x, true);";
		expect(checkFlagArgument(content, "/x/foo.test.ts")).toEqual([]);
	});
});

describe("checkCommentedOutCode", () => {
	it("flags three consecutive commented code lines", () => {
		const content = [
			"function f() {",
			"  // const x = 1;",
			"  // const y = 2;",
			"  // return x + y;",
			"  return 0;",
			"}",
		].join("\n");
		expect(checkCommentedOutCode(content, "/src/foo.ts").length).toBeGreaterThan(0);
	});

	it("allows two commented code lines", () => {
		const content = "// const x = 1;\n// const y = 2;\nreturn 0;";
		expect(checkCommentedOutCode(content, "/src/foo.ts")).toEqual([]);
	});

	it("allows TODO comments", () => {
		const content = "// TODO: fix this\n// TODO: then this\n// TODO: finally\n";
		expect(checkCommentedOutCode(content, "/src/foo.ts")).toEqual([]);
	});
});

describe("checkConditionalInTest", () => {
	it("flags if inside a test body", () => {
		const content = `
			it("thing", () => {
				if (x) { expect(y).toBe(1); } else { expect(y).toBe(2); }
			});
		`;
		expect(checkConditionalInTest(content, "/x/foo.test.ts").length).toBe(1);
	});

	it("flags try/catch inside a test body", () => {
		const content = `
			it("thing", () => {
				try { fn(); } catch (e) { expect(e.message).toBe("x"); }
			});
		`;
		expect(checkConditionalInTest(content, "/x/foo.test.ts").length).toBe(1);
	});

	it("allows straight-line test", () => {
		const content = `
			it("thing", () => {
				expect(compute()).toBe(42);
			});
		`;
		expect(checkConditionalInTest(content, "/x/foo.test.ts")).toEqual([]);
	});
});

describe("checkNonDeterministicTest", () => {
	it("flags Date.now() in a test", () => {
		const content = `
			it("now", () => {
				const ts = Date.now();
				expect(ts).toBeGreaterThan(0);
			});
		`;
		expect(checkNonDeterministicTest(content, "/x/foo.test.ts").length).toBe(1);
	});

	it("flags new Date() in a test", () => {
		const content = `
			it("now", () => {
				const d = new Date();
				expect(d).toBeDefined();
			});
		`;
		expect(checkNonDeterministicTest(content, "/x/foo.test.ts").length).toBe(1);
	});

	it("allows non-deterministic APIs when fake timers are set up", () => {
		const content = `
			vi.useFakeTimers();
			it("now", () => {
				const ts = Date.now();
				expect(ts).toBeGreaterThan(0);
			});
		`;
		expect(checkNonDeterministicTest(content, "/x/foo.test.ts")).toEqual([]);
	});
});

describe("checkEmptyCatch", () => {
	it("flags empty catch", () => {
		const content = "try { doThing(); } catch (e) {}";
		expect(checkEmptyCatch(content, "/src/foo.ts").length).toBe(1);
	});

	it("flags bare empty catch", () => {
		const content = "try { doThing(); } catch {}";
		expect(checkEmptyCatch(content, "/src/foo.ts").length).toBe(1);
	});

	it("allows catch with body", () => {
		const content = "try { doThing(); } catch (e) { log(e); }";
		expect(checkEmptyCatch(content, "/src/foo.ts")).toEqual([]);
	});

	it("allows empty catch with an intentional rationale comment", () => {
		const content = "try { doThing(); } catch (e) { /* non-critical: cache warmup */ }";
		expect(checkEmptyCatch(content, "/src/foo.ts")).toEqual([]);
	});
});

describe("checkTestWithoutDescription", () => {
	it("flags it('')", () => {
		// Split literal to avoid matching the taste-check pattern on this fixture line.
		const content = `it(${'""'}, () => { expect(1).toBe(1); });`;
		expect(checkTestWithoutDescription(content, "/x/foo.test.ts").length).toBe(1);
	});

	it("flags it with function first arg", () => {
		// Split literal to avoid matching the taste-check pattern on this fixture line.
		const content = `it(${"() => { expect(1).toBe(1); }"});`;
		expect(checkTestWithoutDescription(content, "/x/foo.test.ts").length).toBe(1);
	});

	it("allows normal descriptions", () => {
		const content = 'it("does a thing", () => { expect(1).toBe(1); });';
		expect(checkTestWithoutDescription(content, "/x/foo.test.ts")).toEqual([]);
	});
});

describe("checkAssertionRoulette", () => {
	it("flags test with 8+ expects", () => {
		const expects = Array.from({ length: 9 }, (_, n) => `expect(${n}).toBe(${n});`).join(" ");
		const content = `it("many", () => { ${expects} });`;
		expect(checkAssertionRoulette(content, "/x/foo.test.ts").length).toBe(1);
	});

	it("allows test with 5 expects", () => {
		const expects = Array.from({ length: 5 }, (_, n) => `expect(${n}).toBe(${n});`).join(" ");
		const content = `it("a few", () => { ${expects} });`;
		expect(checkAssertionRoulette(content, "/x/foo.test.ts")).toEqual([]);
	});
});

describe("checkMagicNumber", () => {
	it("flags setTimeout with magic number", () => {
		const content = "setTimeout(fn, 5000);";
		expect(checkMagicNumber(content, "/src/foo.ts").length).toBe(1);
	});

	it("allows named constant", () => {
		const content = "const TIMEOUT_MS = 5000;";
		expect(checkMagicNumber(content, "/src/foo.ts")).toEqual([]);
	});

	it("allows three-digit numbers (HTTP codes etc.)", () => {
		const content = "res.status(404);";
		expect(checkMagicNumber(content, "/src/foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const content = "setTimeout(fn, 5000);";
		expect(checkMagicNumber(content, "/x/foo.test.ts")).toEqual([]);
	});
});

describe("checkFunctionArgCount", () => {
	it("flags function with 4 args", () => {
		const content = "function f(a, b, c, d) { return a + b + c + d; }";
		expect(checkFunctionArgCount(content, "/src/foo.ts").length).toBe(1);
	});

	it("allows function with 3 args", () => {
		const content = "function f(a, b, c) { return a + b + c; }";
		expect(checkFunctionArgCount(content, "/src/foo.ts")).toEqual([]);
	});

	it("flags arrow with 4 args", () => {
		const content = "const f = (a, b, c, d) => a + b + c + d;";
		expect(checkFunctionArgCount(content, "/src/foo.ts").length).toBe(1);
	});

	it("does not count generic type params", () => {
		const content = "function f<A, B, C, D>(x: A) { return x; }";
		expect(checkFunctionArgCount(content, "/src/foo.ts")).toEqual([]);
	});
});

describe("checkDataClump", () => {
	it("flags three consecutive string args", () => {
		const content = "function name(first: string, last: string, middle: string) {}";
		expect(checkDataClump(content, "/src/foo.ts").length).toBe(1);
	});

	it("flags three consecutive number args", () => {
		const content = "function coords(x: number, y: number, z: number) {}";
		expect(checkDataClump(content, "/src/foo.ts").length).toBe(1);
	});

	it("allows mixed types", () => {
		const content = "function f(a: string, b: number, c: string) {}";
		expect(checkDataClump(content, "/src/foo.ts")).toEqual([]);
	});

	it("allows two consecutive string args", () => {
		const content = "function f(first: string, last: string) {}";
		expect(checkDataClump(content, "/src/foo.ts")).toEqual([]);
	});
});

describe("checkDuplicateDescribe", () => {
	// Fixtures built from literals so the taste-check pattern does not match the source of this file.
	const DESC = "desc" + "ribe";
	it("flags repeated describe name", () => {
		const content = `
			${DESC}("foo", () => { it("a", () => {}); });
			${DESC}("foo", () => { it("b", () => {}); });
		`;
		expect(checkDuplicateDescribe(content, "/x/foo.test.ts").length).toBe(1);
	});

	it("allows distinct describe names", () => {
		const content = `
			${DESC}("foo", () => {});
			${DESC}("bar", () => {});
		`;
		expect(checkDuplicateDescribe(content, "/x/foo.test.ts")).toEqual([]);
	});

	it("skips non-test files", () => {
		const content = `${DESC}("foo", () => {}); ${DESC}("foo", () => {});`;
		expect(checkDuplicateDescribe(content, "/src/foo.ts")).toEqual([]);
	});
});

// ===========================================
// FP regression tests
// ===========================================

describe("FP: multi-line template literals are stripped", () => {
	it("does not flag switch inside multi-line template fixture", () => {
		const content = `
			const fixture = \`
				function a(x) { switch (x.kind) { case "A": return 1; } }
				function b(x) { switch (x.kind) { case "B": return 2; } }
			\`;
			doThing(fixture);
		`;
		expect(checkDuplicateSwitchDiscriminant(content, "/src/foo.ts")).toEqual([]);
	});

	it("does not flag else-if inside multi-line template fixture", () => {
		const content = `
			const fixture = \`
				if (a) { x(); } else if (b) { y(); } else if (c) { z(); }
			\`;
		`;
		expect(checkElseIfChain(content, "/src/foo.ts")).toEqual([]);
	});

	it("still flags real switches outside templates", () => {
		const content = `
			const fixture = \`
				switch (x.kind) { case "A": return 1; }
			\`;
			function b(x) { switch (x.kind) { case "B": return 2; } }
			function c(x) { switch (x.kind) { case "C": return 3; } }
		`;
		expect(checkDuplicateSwitchDiscriminant(content, "/src/foo.ts").length).toBeGreaterThan(0);
	});
});

describe("FP: flag-argument safe builtins", () => {
	it("allows fs.mkdirSync(path, { recursive: true })", () => {
		const content = "mkdirSync(dir, { recursive: true });";
		expect(checkFlagArgument(content, "/src/foo.ts")).toEqual([]);
	});

	it("allows fs.writeFileSync with boolean option", () => {
		const content = "writeFileSync(path, data, { flag: true });";
		expect(checkFlagArgument(content, "/src/foo.ts")).toEqual([]);
	});

	it("allows spawnSync with shell: true", () => {
		const content = "spawnSync(cmd, args, { shell: true });";
		expect(checkFlagArgument(content, "/src/foo.ts")).toEqual([]);
	});

	it("still flags user-facing boolean-flag calls", () => {
		const content = "myHelper(input, { verbose: true });";
		expect(checkFlagArgument(content, "/src/foo.ts").length).toBe(1);
	});
});

describe("FP: commented-out-code skips banner dividers", () => {
	it("does not flag // === section dividers", () => {
		const content = [
			"// ===========================================",
			"// ===========================================",
			"// ===========================================",
			"const x = 1;",
		].join("\n");
		expect(checkCommentedOutCode(content, "/src/foo.ts")).toEqual([]);
	});

	it("does not flag // --- dividers", () => {
		const content = [
			"// ----------------------",
			"// ----------------------",
			"// ----------------------",
			"const x = 1;",
		].join("\n");
		expect(checkCommentedOutCode(content, "/src/foo.ts")).toEqual([]);
	});

	it("still flags three lines of actual commented code", () => {
		const content = ["// const x = compute();", "// const y = x + 1;", "// return y;"].join(
			"\n",
		);
		expect(checkCommentedOutCode(content, "/src/foo.ts").length).toBeGreaterThan(0);
	});
});
