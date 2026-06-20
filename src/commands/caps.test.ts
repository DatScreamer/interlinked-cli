import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capsExplainAction, capsSetAction, capsShowAction } from "./caps.js";
import { nonNull } from "../lib/non-null.js";

let cwd: string;
let logs: string[];
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "caps-cmd-"));
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
	logs = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(a.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		logs.push(a.map(String).join(" "));
	});
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function capsFile(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(cwd, ".interlinked", "metric-caps.json"), "utf8"));
}
const out = (): string => logs.join("\n");

describe("capsShowAction", () => {
	it("shows the four metrics at their shipped defaults when no override exists", async () => {
		const code = await capsShowAction({}, { cwd });
		expect(code).toBe(0);
		expect(out()).toContain("cyclomatic");
		expect(out()).toContain("25"); // default cyclomatic
		expect(out()).toContain("default");
	});

	it("reflects a per-repo override and marks its source", async () => {
		writeFileSync(join(cwd, ".interlinked", "metric-caps.json"), JSON.stringify({ max_cyclomatic: 15 }));
		await capsShowAction({}, { cwd });
		expect(out()).toContain("15");
		expect(out()).toContain("metric-caps.json");
	});

	it("emits machine-readable JSON with --json", async () => {
		await capsShowAction({ json: true }, { cwd });
		const parsed = JSON.parse(out()) as Record<string, { value: number; source: string }>;
		expect(nonNull(parsed.cyclomatic).value).toBe(25);
		expect(nonNull(parsed.lines).value).toBe(500);
		expect(nonNull(parsed.crap).value).toBe(30);
		expect(nonNull(parsed.coverage).value).toBe(0);
	});
});

describe("capsSetAction", () => {
	it("writes a per-repo cyclomatic override and confirms", async () => {
		const code = await capsSetAction("cyclomatic", "15", {}, { cwd });
		expect(code).toBe(0);
		expect(capsFile().max_cyclomatic).toBe(15);
		expect(out()).toContain("cyclomatic");
	});

	it("creates .interlinked/ when absent instead of throwing ENOENT (finding 2026-06)", async () => {
		// A fresh repo (before `interlinked enable`) has no .interlinked/; the
		// beforeEach pre-creates it, so remove it to reproduce. caps set must create
		// the dir and write the policy file rather than crash on ENOENT.
		rmSync(join(cwd, ".interlinked"), { recursive: true, force: true });
		const code = await capsSetAction("cyclomatic", "15", {}, { cwd });
		expect(code).toBe(0);
		expect(capsFile().max_cyclomatic).toBe(15);
	});

	it("maps each metric to its config key", async () => {
		await capsSetAction("lines", "500", {}, { cwd });
		await capsSetAction("crap", "20", {}, { cwd });
		await capsSetAction("coverage", "90", {}, { cwd });
		const f = capsFile();
		expect(f.max_lines).toBe(500);
		expect(f.crap_threshold).toBe(20);
		expect(f.min_coverage).toBe(90);
	});

	it("merges into an existing file without clobbering other keys", async () => {
		await capsSetAction("cyclomatic", "15", {}, { cwd });
		await capsSetAction("crap", "20", {}, { cwd });
		const f = capsFile();
		expect(f.max_cyclomatic).toBe(15);
		expect(f.crap_threshold).toBe(20);
	});

	it("rejects an unknown metric", async () => {
		const code = await capsSetAction("bogus", "10", {}, { cwd });
		expect(code).toBe(1);
		expect(existsSync(join(cwd, ".interlinked", "metric-caps.json"))).toBe(false);
	});

	it("rejects a non-numeric or non-positive value (coverage floor 0 allowed)", async () => {
		expect(await capsSetAction("cyclomatic", "abc", {}, { cwd })).toBe(1);
		expect(await capsSetAction("cyclomatic", "0", {}, { cwd })).toBe(1);
		expect(await capsSetAction("coverage", "0", {}, { cwd })).toBe(0); // a 0 floor is valid
		expect(await capsSetAction("coverage", "150", {}, { cwd })).toBe(1); // >100
	});

	it("--json emits the written override", async () => {
		await capsSetAction("cyclomatic", "15", { json: true }, { cwd });
		expect(JSON.parse(out())).toMatchObject({ metric: "cyclomatic", value: 15 });
	});

	it("overwrites a malformed existing metric-caps.json cleanly", async () => {
		writeFileSync(join(cwd, ".interlinked", "metric-caps.json"), "{not json");
		const code = await capsSetAction("cyclomatic", "15", {}, { cwd });
		expect(code).toBe(0);
		expect(capsFile().max_cyclomatic).toBe(15);
	});
});

describe("capsExplainAction", () => {
	it("explains all four metrics when no metric is named", async () => {
		const code = await capsExplainAction(undefined, {}, { cwd });
		expect(code).toBe(0);
		for (const m of ["lines", "cyclomatic", "crap", "coverage"]) expect(out()).toContain(m);
	});

	it("explains a single metric with its definition and how-to-configure", async () => {
		await capsExplainAction("cyclomatic", {}, { cwd });
		expect(out().toLowerCase()).toContain("branch");
		expect(out()).toContain("interlinked caps set cyclomatic");
	});

	it("rejects an unknown metric", async () => {
		expect(await capsExplainAction("bogus", {}, { cwd })).toBe(1);
	});

	it("--json returns the glossary entries", async () => {
		await capsExplainAction(undefined, { json: true }, { cwd });
		const parsed = JSON.parse(out()) as Array<{ key: string }>;
		expect(parsed.map((d) => d.key)).toEqual(["lines", "cyclomatic", "crap", "coverage"]);
	});
});
