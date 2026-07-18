import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import type { HarnessEvent } from "../types.js";
import {
	__resetComplexityPulseForTesting,
	collectComplexityPulseWarnings,
	consumeComplexityPulse,
	formatComplexityPulse,
	MAX_FILES_PER_EVENT,
	MAX_STASH_ENTRIES,
	recordComplexityPulse,
} from "./complexity-pulse.js";
import { type ComplexityObserver, checkFunctionComplexityWrite } from "./complexity-write-guard.js";

/** One synthetic JS/TS complexity entry. */
function entry(name: string, cyclomatic: number, line = 1): FunctionComplexityEntry {
	return { name, line, endLine: line + 5, cyclomatic, language: "js_ts" };
}

/** A function body with `branches` if-statements → cyclomatic = branches + 1. */
function fnWith(name: string, branches: number): string {
	let s = `export function ${name}(a: number): number {\n\tlet r = 0;\n`;
	for (let i = 0; i < branches; i++) s += `\tif (a === ${i}) r += ${i};\n`;
	return `${s}\treturn r;\n}\n`;
}

function postEvent(overrides: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "pulse-test",
		agent_source: "claude",
		timestamp: "2026-06-10T00:00:00Z",
		...overrides,
	} as HarnessEvent;
}

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "complexity-pulse-"));
	__resetComplexityPulseForTesting();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("formatComplexityPulse", () => {
	it("reports counts, ΣCC delta, max function, and per-name deltas", () => {
		const before = [entry("alpha", 5), entry("beta", 3)];
		const after = [entry("alpha", 8), entry("beta", 3), entry("gamma", 2)];
		const line = formatComplexityPulse("src/foo.ts", before, after);
		expect(line).toContain("[interlinked:cyclomatic] src/foo.ts");
		expect(line).toContain("3 fns");
		expect(line).toContain("ΣCC 13 (Δ+5)");
		expect(line).toContain("max alpha=8");
		expect(line).toContain("alpha 5→8");
		expect(line).toContain("gamma new=2");
		// Unchanged functions are not spelled out.
		expect(line).not.toContain("beta");
	});

	it("reports removed functions with a negative ΣCC delta", () => {
		const before = [entry("alpha", 5), entry("beta", 9)];
		const after = [entry("alpha", 5)];
		const line = formatComplexityPulse("src/foo.ts", before, after);
		expect(line).toContain("ΣCC 5 (Δ-9)");
		expect(line).toContain("beta removed (was 9)");
	});

	it("uses the repo's effective cap for the label and over-cap list (deep-round #11)", () => {
		const fns = [entry("wide", 20)];
		// Default cap (25): CC 20 is under cap.
		const dflt = formatComplexityPulse("src/foo.ts", null, fns);
		expect(dflt).toContain("(cap 25)");
		expect(dflt).not.toContain("over cap");
		// Tighter cap (10): the same function is over cap and labeled as such.
		const tight = formatComplexityPulse("src/foo.ts", null, fns, 10);
		expect(tight).toContain("(cap 10)");
		expect(tight).toContain("over cap: wide=20");
	});

	it("omits the delta entirely when there is no before snapshot", () => {
		const line = formatComplexityPulse("src/foo.ts", null, [entry("alpha", 4)]);
		expect(line).toContain("ΣCC 4");
		expect(line).not.toContain("Δ");
	});

	it("lists over-cap functions", () => {
		const line = formatComplexityPulse("src/foo.ts", null, [entry("big", 31), entry("ok", 3)]);
		expect(line).toContain("over cap: big=31");
		expect(line).not.toContain("ok=3");
	});

	it("returns null when neither side has functions", () => {
		expect(formatComplexityPulse("src/foo.ts", [], [])).toBeNull();
		expect(formatComplexityPulse("src/foo.ts", null, [])).toBeNull();
	});

	it("still reports when every function was removed", () => {
		const line = formatComplexityPulse("src/foo.ts", [entry("alpha", 7)], []);
		expect(line).toContain("0 fns");
		expect(line).toContain("(Δ-7)");
	});

	it("truncates the per-name delta list and counts the remainder", () => {
		const before = [1, 2, 3, 4, 5].map((i) => entry(`fn${i}`, i));
		const after = [1, 2, 3, 4, 5].map((i) => entry(`fn${i}`, i + 10));
		const line = formatComplexityPulse("src/foo.ts", before, after) ?? "";
		expect(line.match(/→/g)?.length).toBe(3);
		expect(line).toContain("+2 more");
	});

	it("counts anonymous functions in ΣCC but never name-matches them", () => {
		const before = [entry("(callback)", 2)];
		const after = [entry("(callback)", 6)];
		const line = formatComplexityPulse("src/foo.ts", before, after);
		expect(line).toContain("(Δ+4)");
		expect(line).not.toContain("Δ fns:");
	});
});

describe("pulse stash", () => {
	it("round-trips a snapshot and consumes it exactly once", () => {
		recordComplexityPulse("s1", "/a.ts", [entry("f", 2)], [entry("f", 4)], "content");
		const snap = consumeComplexityPulse("s1", "/a.ts", "content");
		expect(snap?.beforeFns[0]?.cyclomatic).toBe(2);
		expect(snap?.afterFns[0]?.cyclomatic).toBe(4);
		expect(consumeComplexityPulse("s1", "/a.ts", "content")).toBeNull();
	});

	it("discards the snapshot when the on-disk content does not match", () => {
		recordComplexityPulse("s1", "/a.ts", [], [entry("f", 4)], "projected");
		expect(consumeComplexityPulse("s1", "/a.ts", "what actually landed")).toBeNull();
		// Dropped, not retained: a later matching read still misses.
		expect(consumeComplexityPulse("s1", "/a.ts", "projected")).toBeNull();
	});

	it("is keyed by session — another session cannot consume the snapshot", () => {
		recordComplexityPulse("s1", "/a.ts", [], [entry("f", 4)], "c");
		expect(consumeComplexityPulse("s2", "/a.ts", "c")).toBeNull();
		expect(consumeComplexityPulse("s1", "/a.ts", "c")).not.toBeNull();
	});

	it("evicts the oldest snapshot past the cap", () => {
		for (let i = 0; i <= MAX_STASH_ENTRIES; i++) {
			recordComplexityPulse("s1", `/f${i}.ts`, [], [], "x");
		}
		expect(consumeComplexityPulse("s1", "/f0.ts", "x")).toBeNull();
		expect(consumeComplexityPulse("s1", `/f${MAX_STASH_ENTRIES}.ts`, "x")).not.toBeNull();
	});

	it("re-recording the same file replaces the snapshot without growing the stash", () => {
		recordComplexityPulse("s1", "/a.ts", [], [entry("f", 2)], "c1");
		recordComplexityPulse("s1", "/a.ts", [], [entry("f", 9)], "c2");
		expect(consumeComplexityPulse("s1", "/a.ts", "c1")).toBeNull();
		recordComplexityPulse("s1", "/a.ts", [], [entry("f", 9)], "c2");
		expect(consumeComplexityPulse("s1", "/a.ts", "c2")?.afterFns[0]?.cyclomatic).toBe(9);
	});
});

describe("collectComplexityPulseWarnings", () => {
	it("emits a delta pulse from the stashed snapshot when the disk content matches", () => {
		const abs = join(tmp, "src", "thing.ts");
		mkdirSync(join(tmp, "src"), { recursive: true });
		const content = fnWith("widget", 8);
		writeFileSync(abs, content);
		recordComplexityPulse("pulse-test", abs, [entry("widget", 5)], [entry("widget", 9)], content);

		const warnings = collectComplexityPulseWarnings(
			postEvent({ tool_name: "Edit", tool_input: { file_path: abs }, cwd: tmp }),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("src/thing.ts");
		expect(warnings[0]).toContain("ΣCC 9 (Δ+4)");
		expect(warnings[0]).toContain("widget 5→9");
	});

	it("falls back to an on-disk parse (no delta) on a stash miss", () => {
		const abs = join(tmp, "loose.ts");
		writeFileSync(abs, fnWith("check", 3));
		const warnings = collectComplexityPulseWarnings(
			postEvent({ tool_name: "Write", tool_input: { file_path: abs }, cwd: tmp }),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("max check=4");
		expect(warnings[0]).not.toContain("Δ");
	});

	it("falls back to absolutes when the stash hash does not match the landed bytes", () => {
		const abs = join(tmp, "raced.ts");
		writeFileSync(abs, fnWith("real", 2));
		recordComplexityPulse("pulse-test", abs, [entry("real", 1)], [entry("real", 50)], "projected-but-never-landed");
		const warnings = collectComplexityPulseWarnings(
			postEvent({ tool_name: "Edit", tool_input: { file_path: abs }, cwd: tmp }),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("max real=3");
		expect(warnings[0]).not.toContain("Δ");
	});

	it("skips test files — the same population the gate governs", () => {
		const abs = join(tmp, "thing.test.ts");
		writeFileSync(abs, fnWith("helper", 6));
		expect(
			collectComplexityPulseWarnings(
				postEvent({ tool_name: "Write", tool_input: { file_path: abs }, cwd: tmp }),
			),
		).toEqual([]);
	});

	it("skips non-code files", () => {
		const abs = join(tmp, "README.md");
		writeFileSync(abs, "# hello\n");
		expect(
			collectComplexityPulseWarnings(
				postEvent({ tool_name: "Write", tool_input: { file_path: abs }, cwd: tmp }),
			),
		).toEqual([]);
	});

	it("skips unreadable / deleted files and non-write tools", () => {
		expect(
			collectComplexityPulseWarnings(
				postEvent({ tool_name: "Edit", tool_input: { file_path: join(tmp, "gone.ts") }, cwd: tmp }),
			),
		).toEqual([]);
		expect(
			collectComplexityPulseWarnings(
				postEvent({ tool_name: "Read", tool_input: { file_path: join(tmp, "x.ts") }, cwd: tmp }),
			),
		).toEqual([]);
	});

	it("bounds the number of files profiled per event", () => {
		const paths: string[] = [];
		for (let i = 0; i < MAX_FILES_PER_EVENT + 2; i++) {
			const abs = join(tmp, `multi${i}.ts`);
			writeFileSync(abs, fnWith(`fn${i}`, 2));
			paths.push(abs);
		}
		const warnings = collectComplexityPulseWarnings(
			postEvent({ tool_name: "Edit", tool_input: {}, files_modified: paths, cwd: tmp }),
		);
		expect(warnings).toHaveLength(MAX_FILES_PER_EVENT);
	});
});

describe("complexity-write-guard observer", () => {
	it("observes before/after entries on a gated edit without changing the decision", () => {
		const abs = join(tmp, "observed.ts");
		writeFileSync(abs, fnWith("alpha", 3)); // alpha cyclomatic 4
		const observe = vi.fn<ComplexityObserver>();
		// A REDUCTION (4 → 3): allowed by both the cap and the monotonic ratchet,
		// so the decision stays `null` while the observer still sees the delta.
		const result = checkFunctionComplexityWrite(
			{ file_path: abs, old_string: "\tif (a === 2) r += 2;\n", new_string: "" },
			tmp,
			observe,
		);
		expect(result).toBeNull();
		expect(observe).toHaveBeenCalledTimes(1);
		const [filePath, beforeFns, afterFns, afterContent] = nonNull(observe.mock.calls[0]);
		expect(filePath).toBe(abs);
		expect(beforeFns.find((f) => f.name === "alpha")?.cyclomatic).toBe(4);
		expect(afterFns.find((f) => f.name === "alpha")?.cyclomatic).toBe(3);
		expect(afterContent).not.toContain("a === 2");
	});

	it("still observes when the gate blocks (the hash check protects the stash)", () => {
		const abs = join(tmp, "blocked.ts");
		writeFileSync(abs, fnWith("calm", 1));
		const observe = vi.fn<ComplexityObserver>();
		const result = checkFunctionComplexityWrite(
			{ file_path: abs, content: fnWith("storm", 40) },
			tmp,
			observe,
		);
		expect(result?.block).toContain("cyclomatic");
		expect(observe).toHaveBeenCalledTimes(1);
	});

	it("does not observe non-code or exempt (test) files", () => {
		const observe = vi.fn<ComplexityObserver>();
		expect(
			checkFunctionComplexityWrite({ file_path: join(tmp, "notes.md"), content: "# hi" }, tmp, observe),
		).toBeNull();
		const testAbs = join(tmp, "thing.test.ts");
		writeFileSync(testAbs, fnWith("t", 1));
		expect(
			checkFunctionComplexityWrite({ file_path: testAbs, content: fnWith("t", 2) }, tmp, observe),
		).toBeNull();
		expect(observe).not.toHaveBeenCalled();
	});

	it("observes a brand-new file with an empty before profile", () => {
		const abs = join(tmp, "fresh.ts");
		const observe = vi.fn<ComplexityObserver>();
		expect(checkFunctionComplexityWrite({ file_path: abs, content: fnWith("born", 2) }, tmp, observe)).toBeNull();
		expect(observe).toHaveBeenCalledTimes(1);
		const [, beforeFns, afterFns] = nonNull(observe.mock.calls[0]);
		expect(beforeFns).toEqual([]);
		expect(afterFns.find((f) => f.name === "born")?.cyclomatic).toBe(3);
	});
});
