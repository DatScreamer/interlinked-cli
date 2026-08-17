import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecFileMock = (command: string, args: string[], options: { encoding: "utf-8" }) => string;
const childProcessMock = vi.hoisted(() => ({
	execFileSync: vi.fn<ExecFileMock>(() => {
		throw Object.assign(new Error("impeccable missing"), { code: "ENOENT" });
	}),
}));
vi.mock("node:child_process", () => childProcessMock);

import {
	type DesignScanResult,
	designCommand,
	formatDesignFindings,
	type ImpeccableFinding,
	parseImpeccableJson,
	realDetectExec,
	runImpeccableDetect,
	summarizeDesignFindings,
} from "./design.js";

function finding(over: Partial<ImpeccableFinding> = {}): ImpeccableFinding {
	return {
		file: "hero.tsx",
		line: 12,
		antipattern: "overused-font",
		description: "Inter is overused",
		snippet: "font-family: Inter",
		...over,
	};
}

describe("parseImpeccableJson", () => {
	it("parses a findings array", () => {
		const out = parseImpeccableJson(JSON.stringify([finding()]));
		expect(out).toHaveLength(1);
		expect(out[0]?.antipattern).toBe("overused-font");
	});
	it("returns [] for invalid JSON", () => {
		expect(parseImpeccableJson("not json")).toEqual([]);
	});
	it("returns [] for non-array JSON", () => {
		expect(parseImpeccableJson(JSON.stringify({ nope: 1 }))).toEqual([]);
	});
	it("returns [] for empty output", () => {
		expect(parseImpeccableJson("")) .toEqual([]);
	});
	it("coerces missing/typed fields to safe defaults", () => {
		const out = parseImpeccableJson(JSON.stringify([{ antipattern: "side-tab" }, "garbage", { line: 4 }]));
		expect(out[0]).toMatchObject({ antipattern: "side-tab", line: null, file: "" });
		expect(out[1]).toMatchObject({ antipattern: "unknown" });
		expect(out[2]).toMatchObject({ line: 4, antipattern: "unknown" });
	});
	it("preserves every valid finding field and rejects each invalid type", () => {
		expect(parseImpeccableJson(JSON.stringify([{
			file: "styles.css",
			line: 0,
			antipattern: "tiny-text",
			description: "small text",
			snippet: "font-size: 10px",
		}]))).toEqual([{
			file: "styles.css",
			line: 0,
			antipattern: "tiny-text",
			description: "small text",
			snippet: "font-size: 10px",
		}]);
		expect(parseImpeccableJson(JSON.stringify([{
			file: 42,
			line: "12",
			antipattern: false,
			description: null,
			snippet: {},
		}]))).toEqual([{
			file: "",
			line: null,
			antipattern: "unknown",
			description: "",
			snippet: "",
		}]);
	});
	it("normalizes null and primitive entries to the complete safe shape", () => {
		expect(parseImpeccableJson(JSON.stringify([null, 7, true]))).toEqual([
			{ file: "", line: null, antipattern: "unknown", description: "", snippet: "" },
			{ file: "", line: null, antipattern: "unknown", description: "", snippet: "" },
			{ file: "", line: null, antipattern: "unknown", description: "", snippet: "" },
		]);
	});
	// test-contract: boundary — the detector's --json output is untrusted external
	// input; a finding object with every field ABSENT (not merely malformed) must
	// still reach the main return branch (not the null/primitive early-return) and
	// normalize to the same complete safe shape as a wrong-typed field would.
	it("mutant-kill: a plain empty object (all keys absent, not null) still reaches the complete safe-default shape", () => {
		expect(parseImpeccableJson(JSON.stringify([{}]))).toEqual([
			{ file: "", line: null, antipattern: "unknown", description: "", snippet: "" },
		]);
	});
});

describe("summarizeDesignFindings / formatDesignFindings", () => {
	it("summarize: clean", () => {
		expect(summarizeDesignFindings([])).toBe("No design tells found.");
	});
	it("summarize: with findings", () => {
		expect(summarizeDesignFindings([finding(), finding({ file: "a.css" })])).toBe(
			"2 design tell(s) across 2 file(s).",
		);
	});
	it("counts distinct files even when findings repeat a file", () => {
		expect(summarizeDesignFindings([finding(), finding()])).toBe("2 design tell(s) across 1 file(s).");
	});
	it("format: clean", () => {
		expect(formatDesignFindings([])).toBe("No design tells found. ✓");
	});
	it("format: groups by file and renders line + line-less findings", () => {
		const text = formatDesignFindings([
			finding(),
			finding({ line: null, antipattern: "em-dash-overuse" }),
			finding({ file: "a.css", antipattern: "side-tab" }),
		]);
		expect(text).toContain("hero.tsx");
		expect(text).toContain("a.css");
		expect(text).toContain("overused-font");
		expect(text).toContain("em-dash-overuse");
		expect(text).toContain("  :12   [overused-font] Inter is overused");
		expect(text).toContain("       [em-dash-overuse] Inter is overused");
		expect(text).toMatch(/3 design tell\(s\) across 2 file\(s\)\.$/);
	});
	// test-contract: public-api — `interlinked design`'s normal-mode rendering
	// (per-file grouping via a fresh accumulator array, the "\n" join separator
	// between every pushed line, the trailing summary line) is the documented
	// human output; a `.toContain`/`.toMatch` check can miss an extra spliced-in
	// element or a dropped separator that a byte-exact comparison catches.
	it("mutant-kill: the full rendering is byte-for-byte exact, not just a set of substrings", () => {
		const text = formatDesignFindings([
			finding(),
			finding({ line: null, antipattern: "em-dash-overuse" }),
			finding({ file: "a.css", antipattern: "side-tab" }),
		]);
		expect(text).toBe(
			"\nhero.tsx\n" +
				"  :12   [overused-font] Inter is overused\n" +
				"        [em-dash-overuse] Inter is overused\n" +
				"\na.css\n" +
				"  :12   [side-tab] Inter is overused\n" +
				"\n3 design tell(s) across 2 file(s).",
		);
	});
});

describe("runImpeccableDetect", () => {
	it("invokes the real detector with the exact command, flags, and encoding", () => {
		childProcessMock.execFileSync.mockReturnValue("[]");
		try {
			expect(realDetectExec("src/", ["--gemini"])).toBe("[]");
			expect(childProcessMock.execFileSync).toHaveBeenCalledWith(
			"impeccable",
			["detect", "--json", "src/", "--gemini"],
			{ encoding: "utf-8" },
		);
		} finally {
			childProcessMock.execFileSync.mockReset();
			childProcessMock.execFileSync.mockImplementation(() => {
				throw Object.assign(new Error("impeccable missing"), { code: "ENOENT" });
			});
		}
	});
	it("returns ok + findings when impeccable exits 0 (injected exec)", () => {
		const r = runImpeccableDetect("src/", [], () => JSON.stringify([finding()]));
		expect(r.status).toBe("ok");
		expect(r.findings).toHaveLength(1);
	});
	it("reads findings from err.stdout when impeccable exits non-zero", () => {
		const exec = () => {
			throw Object.assign(new Error("exit 1"), { stdout: JSON.stringify([finding()]) });
		};
		const r = runImpeccableDetect("src/", ["--gpt"], exec);
		expect(r.status).toBe("ok");
		expect(r.findings).toHaveLength(1);
	});
	it("returns error on a non-ENOENT failure with no stdout", () => {
		const exec = () => {
			throw new Error("boom");
		};
		const r = runImpeccableDetect("src/", [], exec);
		expect(r.status).toBe("error");
		expect(r.message).toContain("boom");
	});
	it("accepts whitespace before JSON findings on a non-zero exit", () => {
		const exec = () => {
			throw Object.assign(new Error("findings"), { stdout: ` \n${JSON.stringify([finding()])}` });
		};
		expect(runImpeccableDetect("src/", [], exec)).toEqual({ status: "ok", findings: [finding()] });
	});
	it("keeps malformed stdout and thrown primitive values as errors", () => {
		for (const thrown of [Object.assign(new Error("bad json"), { stdout: "{}" }), null, "boom"]) {
			const r = runImpeccableDetect("src/", [], () => {
				throw thrown;
			});
			expect(r.status).toBe("error");
		}
	});
	it("classifies an ENOENT-shaped error without requiring a real subprocess", () => {
		const r = runImpeccableDetect("src/", [], () => {
			throw { code: "ENOENT" };
		});
		expect(r).toEqual({ status: "not-installed", findings: [] });
	});
	it("returns not-installed via the real exec when impeccable is absent from PATH", () => {
		expect(runImpeccableDetect("src/", []).status).toBe("not-installed");
	});
	// test-contract: boundary — any subprocess failure other than a literal ENOENT
	// (e.g. EACCES from a sandboxed/no-exec PATH entry) must classify as a plain
	// error, not silently degrade to "not-installed" just because it shares the
	// same {code: string} shape.
	it("mutant-kill: a non-ENOENT error code still classifies as a plain error with empty findings", () => {
		const r = runImpeccableDetect("src/", [], () => {
			throw { code: "EACCES" };
		});
		expect(r).toEqual({ status: "error", findings: [], message: "[object Object]" });
	});
});

describe("designCommand", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		logSpy.mockRestore();
		errSpy.mockRestore();
	});
	const printed = () => logSpy.mock.calls.flat().join("\n");

	const okWith = (findings: ImpeccableFinding[]): ((t: string, f: string[]) => DesignScanResult) => {
		return () => ({ status: "ok", findings });
	};

	it("prints an install hint when impeccable is absent (default runner path)", async () => {
		await designCommand(undefined, {});
		expect(printed()).toMatch(/impeccable/i);
		expect(printed()).toMatch(/install|npx/i);
	});
	// test-contract: public-api — the exact 3-line "not installed" guidance is what
	// a cold-start user reads; each segment (what happened / how to install / the
	// built-in native subset) must stay intact, not just leave SOME impeccable-ish
	// text behind (a loose /impeccable|install/i match survives any one segment
	// going empty, since the other two segments still contain those words).
	it("mutant-kill: the not-installed hint is the exact 3-line message, not a fragment", async () => {
		await designCommand(undefined, {});
		expect(printed()).toBe(
			"impeccable is not installed — this command wraps its deterministic design detector.\n" +
				"Install it with `npm i -g impeccable`, or run `npx impeccable detect` directly.\n" +
				"The built-in `design_slop` advisory check (`interlinked verify --all-checks`) covers a subset natively.",
		);
	});
	it("uses the default target only for missing or blank paths", async () => {
		const run = vi.fn((target: string) => ({ status: "ok" as const, findings: [], target }));
		await designCommand(undefined, {}, run);
		await designCommand("   ", {}, run);
		await designCommand("src/", {}, run);
		expect(run.mock.calls.map(([target]) => target)).toEqual([".", ".", "src/"]);
	});
	it("emits the not-installed status in --json mode", async () => {
		const run: (t: string, f: string[]) => DesignScanResult = () => ({
			status: "not-installed",
			findings: [],
		});
		await designCommand("src/", { json: true }, run);
		expect(JSON.parse(printed())).toEqual({ status: "not-installed", findings: [] });
	});
	it("prints findings in normal mode", async () => {
		await designCommand("src/", {}, okWith([finding()]));
		expect(printed()).toContain("overused-font");
	});
	it("prints a one-line summary in --short mode", async () => {
		await designCommand("src/", { short: true }, okWith([finding(), finding({ file: "a.css" })]));
		expect(printed()).toBe("2 design tell(s) across 2 file(s).");
	});
	it("emits JSON in --json mode", async () => {
		await designCommand("src/", { json: true }, okWith([finding()]));
		const parsed = JSON.parse(printed());
		expect(parsed.status).toBe("ok");
		expect(parsed.count).toBe(1);
		expect(parsed.findings[0].antipattern).toBe("overused-font");
	});
	it("passes --gpt/--gemini through and reports clean when no findings", async () => {
		const run = vi.fn(okWith([]));
		await designCommand("x", { gpt: true, gemini: true }, run);
		expect(run).toHaveBeenCalledWith("x", ["--gpt", "--gemini"]);
		expect(printed()).toBe("No design tells found. ✓");
	});
	it("does not pass disabled provider flags and forwards each enabled flag", async () => {
		const run = vi.fn(okWith([]));
		await designCommand("x", { gpt: false, gemini: false }, run);
		await designCommand("x", { gpt: true }, run);
		await designCommand("x", { gemini: true }, run);
		expect(run.mock.calls.map(([, flags]) => flags)).toEqual([[], ["--gpt"], ["--gemini"]]);
	});
	it("reports an error status to stderr", async () => {
		const run: (t: string, f: string[]) => DesignScanResult = () => ({
			status: "error",
			findings: [],
			message: "kaboom",
		});
		await designCommand("src/", {}, run);
		expect(errSpy.mock.calls.flat().join(" ")).toMatch(/kaboom/i);
	});
	// test-contract: boundary — result.message is optional on an "error" result;
	// the CLI must still print a diagnosable reason (the literal "unknown error")
	// instead of an empty or "undefined" fragment when the detector fails silently.
	it("mutant-kill: falls back to the literal 'unknown error' when the error result carries no message", async () => {
		const run: (t: string, f: string[]) => DesignScanResult = () => ({ status: "error", findings: [] });
		await designCommand("src/", {}, run);
		expect(errSpy.mock.calls.flat().join(" ")).toBe("Error: impeccable detect failed: unknown error");
	});
});
