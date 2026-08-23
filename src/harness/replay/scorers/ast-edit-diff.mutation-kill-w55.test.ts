import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Group A: tests that run against the REAL typescript module (no mocking).
// These exercise argvDistance, scoreEditActions routing, and the null-tool
// guard — none of them need loadTs() to succeed or fail in a particular way.
// ---------------------------------------------------------------------------
describe("ast-edit-diff — argvDistance", () => {
	// test-contract: public-api — multisetDistance's `total === 0` guard
	// (ast-edit-diff.ts) must return normalized:0, never 0/0 (NaN).
	it("P: empty-vs-empty command normalizes to 0, not NaN (total===0 guard)", async () => {
		const { argvDistance } = await import("./ast-edit-diff.js");
		const d = argvDistance("", "");
		expect(d.distance).toBe(0);
		expect(d.normalized).toBe(0);
		expect(Number.isNaN(d.normalized)).toBe(false);
	});

	// test-contract: public-api — argvDistance's tokenizer is documented as
	// "flag position is noise", implying `.filter(Boolean)` strips empty
	// tokens produced by leading/trailing whitespace before comparison.
	it("P: leading/trailing whitespace tokens are filtered out before comparing", async () => {
		const { argvDistance } = await import("./ast-edit-diff.js");
		const d = argvDistance(" a b ", "a b");
		expect(d.distance).toBe(0);
	});

	// test-contract: public-api — multisetDistance sums bucket counts to
	// build `sizeA`/`sizeB`; the per-token accumulator must add +1 per
	// occurrence. "a a" vs "a" have documented counts {a:2} and {a:1}.
	it("P: repeated-token count sign must be +1 per occurrence, not -1", async () => {
		const { argvDistance } = await import("./ast-edit-diff.js");
		const d = argvDistance("a a", "a");
		expect(d.normalized).toBeCloseTo(1 / 3, 10);
		expect(d.normalized).toBeGreaterThan(0);
	});
});

describe("ast-edit-diff — scoreEditActions: editText tool/shape gating", () => {
	// test-contract: public-api — editText's `if (!input) return null` guard;
	// scoreEditActions must degrade gracefully, never throw, on null input.
	it("N: null input never throws and yields null", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const action = { tool: "Edit", input: null };
		expect(() => scoreEditActions(action, action)).not.toThrow();
		expect(scoreEditActions(action, action)).toBeNull();
	});

	// test-contract: public-api — editText requires
	// `typeof input.new_string === "string"` for the Edit branch; a
	// non-string value must not be returned as scorable text.
	it("N: Edit tool with non-string new_string yields null, not the raw value", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const action = { tool: "Edit", input: { new_string: 42 } };
		expect(scoreEditActions(action, action)).toBeNull();
	});

	// test-contract: public-api — editText's Edit branch requires
	// `new_string` to be present; an empty object must fall through to null.
	it("N: Edit tool missing new_string entirely yields null", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const action = { tool: "Edit", input: {} };
		expect(scoreEditActions(action, action)).toBeNull();
	});

	// test-contract: public-api — editText's `tool === "Write"` condition
	// gates the content branch; the Write check must not accept a
	// `new_string`-shaped payload meant for Edit.
	it("N: Write tool with new_string present but no content yields null", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const action = { tool: "Write", input: { new_string: "foo" } };
		expect(scoreEditActions(action, action)).toBeNull();
	});

	// test-contract: public-api — editText requires
	// `typeof input.content === "string"` for the Write branch; a
	// non-string value must not be returned as scorable text.
	it("N: Write tool with non-string content yields null, not the raw value", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const action = { tool: "Write", input: { content: 42 } };
		expect(scoreEditActions(action, action)).toBeNull();
	});

	// test-contract: public-api — editText's Write branch requires
	// `content` to be present; an empty object must fall through to null.
	it("N: Write tool missing content entirely yields null", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const action = { tool: "Write", input: {} };
		expect(scoreEditActions(action, action)).toBeNull();
	});

	// test-contract: public-api — editText's `tool === "Edit"` condition
	// gates the new_string branch; the Edit check must not accept a
	// `content`-shaped payload meant for Write.
	it("N: Edit tool with content-but-no-new_string yields null (Write field leaking into Edit)", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const action = { tool: "Edit", input: { content: "foo" } };
		expect(scoreEditActions(action, action)).toBeNull();
	});

	// test-contract: public-api — sanity companion proving the Edit path
	// still scores real new_string text (guards against a test suite that
	// only ever asserts null and would miss an "always null" regression).
	it("P: matched Edit actions with real new_string DO score (sanity companion)", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const ref = { tool: "Edit", input: { new_string: "const a = 1;" } };
		const cand = { tool: "Edit", input: { new_string: "const a = 2;" } };
		const result = scoreEditActions(ref, cand);
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("ast");
	});
});

describe("ast-edit-diff — scoreEditActions: tool-match guard", () => {
	// test-contract: public-api — scoreEditActions' documented contract:
	// "Returns null when the tools differ (action-match already covers
	// that)"; a Bash-shaped `command` field on a mismatched-tool action
	// must not leak into the Bash scoring branch.
	it("N: mismatched tools return null even when a Bash-shaped `command` field is present", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const ref = { tool: "Bash", input: { command: "a b" } };
		const cand = { tool: "Edit", input: { command: "a c" } };
		expect(scoreEditActions(ref, cand)).toBeNull();
	});

	// test-contract: public-api — same tool-mismatch guard, exercised on
	// two non-Bash tools that both carry a matching text field.
	it("N: mismatched non-Bash tools (Edit vs Write) return null even with matching text fields", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const ref = { tool: "Edit", input: { new_string: "foo" } };
		const cand = { tool: "Write", input: { new_string: "bar" } };
		expect(scoreEditActions(ref, cand)).toBeNull();
	});

	// test-contract: public-api — the Bash branch's
	// `typeof ref.input?.command === "string" ? ref.input.command : ""`
	// ternary must fall back to "" (not undefined) when command is absent,
	// so downstream .split() never throws.
	it("N: Bash tool with input.command missing on one side degrades to empty string, never throws", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const ref = { tool: "Bash", input: {} };
		const cand = { tool: "Bash", input: { command: "ls -la" } };
		expect(() => scoreEditActions(ref, cand)).not.toThrow();
		const result = scoreEditActions(ref, cand);
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("argv");
	});

	// test-contract: public-api — same ternary fallback, exercised on the
	// candidate side (`typeof cand.input?.command === "string"`).
	it("N: Bash tool with candidate input.command missing degrades to empty string, never throws", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const ref = { tool: "Bash", input: { command: "ls -la" } };
		const cand = { tool: "Bash", input: {} };
		expect(() => scoreEditActions(ref, cand)).not.toThrow();
		const result = scoreEditActions(ref, cand);
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("argv");
	});

	// test-contract: public-api — `ref.input?.command` must use optional
	// chaining; a null `input` must not throw when reading `.command`.
	it("N: Bash tool with ref.input null never throws (optional chaining required)", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const ref = { tool: "Bash", input: null };
		const cand = { tool: "Bash", input: { command: "ls -la" } };
		expect(() => scoreEditActions(ref, cand)).not.toThrow();
	});

	// test-contract: public-api — `cand.input?.command` must use optional
	// chaining; a null `input` must not throw when reading `.command`.
	it("N: Bash tool with cand.input null never throws (optional chaining required)", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const ref = { tool: "Bash", input: { command: "ls -la" } };
		const cand = { tool: "Bash", input: null };
		expect(() => scoreEditActions(ref, cand)).not.toThrow();
	});

	// test-contract: public-api — scoreEditActions'
	// `if (refText === null || candText === null) return null` guard must
	// still fire when only refText is missing.
	it("N: refText missing but candText present yields null (asymmetric Edit inputs)", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const ref = { tool: "Edit", input: {} };
		const cand = { tool: "Edit", input: { new_string: "bar" } };
		expect(scoreEditActions(ref, cand)).toBeNull();
	});

	// test-contract: public-api — same guard, exercised with only candText
	// missing (the symmetric case).
	it("N: refText present but candText missing yields null (asymmetric Edit inputs)", async () => {
		const { scoreEditActions } = await import("./ast-edit-diff.js");
		const ref = { tool: "Edit", input: { new_string: "foo" } };
		const cand = { tool: "Edit", input: {} };
		expect(scoreEditActions(ref, cand)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Group B: tests that mock node:module so createRequire("typescript") fails,
// forcing loadTs() down the null path. This exercises astAvailable()'s
// caching (call count) and the `!ts` early return in astEditDistance().
// ---------------------------------------------------------------------------
let requireTsCallCount = 0;

vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:module")>();
	return {
		...actual,
		createRequire: (specifier: string | URL) => {
			const real = actual.createRequire(specifier);
			return (id: string) => {
				if (id === "typescript") {
					requireTsCallCount++;
					throw new Error("blocked for mutation-kill test");
				}
				return real(id);
			};
		},
	};
});

describe("ast-edit-diff — loadTs() failure path (typescript unresolvable)", () => {
	beforeEach(() => {
		requireTsCallCount = 0;
		vi.resetModules();
	});

	// test-contract: public-api — astAvailable() is documented as
	// `loadTs() !== null`; when the optionalDependency require throws,
	// availability must report false, never true.
	it("N: astAvailable() reports false when the module fails to load", async () => {
		const { astAvailable } = await import("./ast-edit-diff.js");
		expect(astAvailable()).toBe(false);
	});

	// test-contract: invariant — loadTs()'s `tsCache !== undefined` guard is
	// the memoization contract: once resolved (even to null), the
	// createRequire("typescript") call must not repeat on later invocations.
	it("N: loadTs() result is cached — repeated calls do not re-invoke createRequire", async () => {
		const { astAvailable } = await import("./ast-edit-diff.js");
		astAvailable();
		astAvailable();
		astAvailable();
		expect(requireTsCallCount).toBe(1);
	});

	// test-contract: public-api — astEditDistance's `if (!ts) return
	// {comparable:false,...}` early return is the documented degradation
	// path ("the scorer says comparable:false rather than fabricating a
	// number"); it must fire, not fall through to a null-`ts` crash.
	it("N: astEditDistance() degrades to comparable:false without throwing when ts is unavailable", async () => {
		const { astEditDistance } = await import("./ast-edit-diff.js");
		let result: ReturnType<typeof astEditDistance> | undefined;
		expect(() => {
			result = astEditDistance("const a = 1;", "const a = 2;");
		}).not.toThrow();
		expect(result).toEqual({ comparable: false, distance: 0, normalized: 0 });
	});
});
