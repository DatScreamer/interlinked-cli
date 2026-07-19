import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DesignScanResult,
	designCommand,
	formatDesignFindings,
	type ImpeccableFinding,
	parseImpeccableJson,
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
		expect(parseImpeccableJson("")).toEqual([]);
	});
	it("coerces missing/typed fields to safe defaults", () => {
		const out = parseImpeccableJson(JSON.stringify([{ antipattern: "side-tab" }, "garbage", { line: 4 }]));
		expect(out[0]).toMatchObject({ antipattern: "side-tab", line: null, file: "" });
		expect(out[1]).toMatchObject({ antipattern: "unknown" });
		expect(out[2]).toMatchObject({ line: 4, antipattern: "unknown" });
	});
});

describe("summarizeDesignFindings / formatDesignFindings", () => {
	it("summarize: clean", () => {
		expect(summarizeDesignFindings([])).toMatch(/no design/i);
	});
	it("summarize: with findings", () => {
		expect(summarizeDesignFindings([finding(), finding({ file: "a.css" })])).toMatch(/2/);
	});
	it("format: clean", () => {
		expect(formatDesignFindings([])).toMatch(/no design/i);
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
	});
});

describe("runImpeccableDetect", () => {
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

	it("returns not-installed via the real exec when impeccable is absent from PATH", () => {
		// No injected exec → real execFileSync("impeccable", …) → ENOENT (not installed here).
		expect(runImpeccableDetect("src/", []).status).toBe("not-installed");
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

	it("emits the not-installed status in --json mode", async () => {
		const run: (t: string, f: string[]) => DesignScanResult = () => ({
			status: "not-installed",
			findings: [],
		});
		await designCommand("src/", { json: true }, run);
		expect(JSON.parse(printed()).status).toBe("not-installed");
	});

	it("prints findings in normal mode", async () => {
		await designCommand("src/", {}, okWith([finding()]));
		expect(printed()).toContain("overused-font");
	});

	it("prints a one-line summary in --short mode", async () => {
		await designCommand("src/", { short: true }, okWith([finding(), finding({ file: "a.css" })]));
		expect(printed()).toMatch(/2/);
	});

	it("emits JSON in --json mode", async () => {
		await designCommand("src/", { json: true }, okWith([finding()]));
		const parsed = JSON.parse(printed());
		expect(parsed.count).toBe(1);
		expect(parsed.findings[0].antipattern).toBe("overused-font");
	});

	it("passes --gpt/--gemini through and reports clean when no findings", async () => {
		const run = vi.fn(okWith([]));
		await designCommand("x", { gpt: true, gemini: true }, run);
		expect(run).toHaveBeenCalledWith("x", ["--gpt", "--gemini"]);
		expect(printed()).toMatch(/no design/i);
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
});
