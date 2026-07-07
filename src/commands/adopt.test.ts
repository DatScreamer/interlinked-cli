// ===========================================
// interlinked adopt — ratchet-from-here bootstrap tests
// ===========================================
// Exercises the full command against a synthetic mini-repo fixture in a tmp
// dir: over-cap file grandfathered at its current count, untested file
// exempted, coverage snapshotting, metric-caps seeding, idempotent re-runs,
// the never-loosen direction rules, --dry-run, and the doctor row.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBaseline } from "../harness/coverage-ratchet.js";
import {
	DEFAULT_MAX_LINES,
	resetLargeFileBaselineCache,
} from "../harness/large-file-policy.js";
import { resetMetricCapsCache } from "../harness/metric-caps.js";
import {
	DEFAULT_MIN_COVERAGE_PCT,
	resetUntestedFilesBaselineCache,
} from "../harness/tested-file-policy.js";
import { type AdoptStepResult, adoptCommand, adoptionArtifactChecks } from "./adopt.js";

let cwd: string;
let savedHome: string | undefined;

/** Write a fixture file under the tmp repo, creating parent dirs. */
function put(rel: string, content: string): void {
	const abs = join(cwd, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

/** An over-cap hand-written code module (function + filler comments). */
function bigFileContent(lines: number): string {
	const filler = Array.from({ length: lines - 2 }, (_, i) => `// pad ${i}`).join("\n");
	return `export function big(): number { return 1; }\n${filler}\n`;
}

/** Build the synthetic mini-repo: one over-cap file, one untested file, one
 *  tested file (companion present), one pure-data module, one doc file. */
function seedFixture(): void {
	put("src/big.ts", bigFileContent(DEFAULT_MAX_LINES + 50));
	put("src/untested.ts", "export function u(x: number): number { return x + 1; }\n");
	put("src/tested.ts", "export function t(x: number): number { return x * 2; }\n");
	put("src/tested.test.ts", "import { t } from './tested.js';\nexport const k = t(1);\n");
	put("src/data.ts", "export const TABLE = { a: 1, b: 2 };\n");
	put("README.md", `# fixture\n${"filler\n".repeat(DEFAULT_MAX_LINES + 10)}`);
}

/** Run adopt with --json and return the parsed step results. */
async function runAdopt(opts: { dryRun?: boolean } = {}): Promise<AdoptStepResult[]> {
	const spy = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		await adoptCommand({ cwd, json: true, ...opts });
		const raw = spy.mock.calls.at(-1)?.[0] as string;
		return (JSON.parse(raw) as { steps: AdoptStepResult[] }).steps;
	} finally {
		spy.mockRestore();
	}
}

function readJson(rel: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(cwd, rel), "utf-8")) as Record<string, unknown>;
}

beforeAll(() => {
	// getConfigDir honors INTERLINKED_HOME — neutralize it so the coverage
	// baseline lands under the fixture's .interlinked like everything else.
	savedHome = process.env.INTERLINKED_HOME;
	delete process.env.INTERLINKED_HOME;
});

afterAll(() => {
	if (savedHome !== undefined) process.env.INTERLINKED_HOME = savedHome;
});

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "interlinked-adopt-"));
	seedFixture();
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	resetLargeFileBaselineCache();
	resetUntestedFilesBaselineCache();
	resetMetricCapsCache();
});

describe("interlinked adopt — full run", () => {
	it("seeds all five artifacts from the current repo state", async () => {
		const steps = await runAdopt();
		expect(steps.map((s) => s.step)).toEqual([
			"index",
			"large_files",
			"untested_files",
			"coverage",
			"metric_caps",
		]);

		// (a) trigram index built + saved
		expect(steps[0]?.action).toBe("written");
		expect(existsSync(join(cwd, ".interlinked", "index"))).toBe(true);

		// (b) over-cap file grandfathered at its current count; cap preserved
		const large = readJson(".interlinked/large-files-baseline.json");
		expect(large.max_lines).toBe(DEFAULT_MAX_LINES);
		expect((large.files as Record<string, number>)["src/big.ts"]).toBe(DEFAULT_MAX_LINES + 50);
		// non-code / under-cap files must NOT be grandfathered
		expect(Object.keys(large.files as Record<string, number>)).toEqual(["src/big.ts"]);

		// (c) untested files exempted; tested + data-only files excluded
		const untested = readJson(".interlinked/untested-files-baseline.json");
		expect(untested.min_coverage_pct).toBe(DEFAULT_MIN_COVERAGE_PCT);
		const files = untested.files as string[];
		expect(files).toContain("src/untested.ts");
		expect(files).toContain("src/big.ts");
		expect(files).not.toContain("src/tested.ts");
		expect(files).not.toContain("src/data.ts");
		expect(files).not.toContain("src/tested.test.ts");

		// (d) no coverage report -> empty-but-valid baseline + guidance note
		const covStep = steps[3];
		expect(covStep?.action).toBe("written");
		expect(covStep?.note).toContain("coverage");
		expect(readJson(".interlinked/coverage-baseline.json").files).toEqual({});

		// (e) metric-caps written with defaults
		const caps = readJson(".interlinked/metric-caps.json");
		expect(caps.max_lines).toBe(DEFAULT_MAX_LINES);
	});

	it("is idempotent: a second run leaves the baselines byte-identical", async () => {
		await runAdopt();
		const firstLarge = readFileSync(join(cwd, ".interlinked/large-files-baseline.json"), "utf-8");
		const firstUntested = readFileSync(
			join(cwd, ".interlinked/untested-files-baseline.json"),
			"utf-8",
		);
		const steps = await runAdopt();
		expect(readFileSync(join(cwd, ".interlinked/large-files-baseline.json"), "utf-8")).toBe(
			firstLarge,
		);
		expect(readFileSync(join(cwd, ".interlinked/untested-files-baseline.json"), "utf-8")).toBe(
			firstUntested,
		);
		// second run reports zero churn on the untested list
		expect(steps[2]?.detail).toContain("(0 new, 0 dropped)");
		// existing metric-caps.json is respected, not rewritten
		expect(steps[4]?.action).toBe("unchanged");
	});

	it("never loosens: keeps the tighter recorded grandfather count and says so", async () => {
		// Pre-seed a baseline recording big.ts SMALLER than its current size —
		// regeneration at the current count would loosen the water-line.
		const tighter = DEFAULT_MAX_LINES + 10;
		put(
			".interlinked/large-files-baseline.json",
			`${JSON.stringify({ version: 1, max_lines: DEFAULT_MAX_LINES, files: { "src/big.ts": tighter } })}\n`,
		);
		const steps = await runAdopt();
		const large = readJson(".interlinked/large-files-baseline.json");
		expect((large.files as Record<string, number>)["src/big.ts"]).toBe(tighter);
		expect(steps[1]?.kept_tighter).toBe(1);
		expect(steps[1]?.detail).toContain("kept at their tighter recorded count");
	});

	it("drops entries that fell under the gates (the ratchet direction)", async () => {
		await runAdopt();
		// big.ts shrinks under the cap and untested.ts gains a companion test.
		put("src/big.ts", "export function big(): number { return 1; }\n");
		put("src/untested.test.ts", "import { u } from './untested.js';\nexport const k = u(1);\n");
		const steps = await runAdopt();
		const large = readJson(".interlinked/large-files-baseline.json");
		expect(large.files).toEqual({});
		const untested = readJson(".interlinked/untested-files-baseline.json");
		expect(untested.files as string[]).not.toContain("src/untested.ts");
		expect(steps[2]?.detail).toContain("1 dropped");
	});
});

describe("interlinked adopt — coverage report handling", () => {
	it("snapshots per-file high-waters and honors the coverage axis for untested files", async () => {
		put(
			"coverage/coverage-summary.json",
			JSON.stringify({
				total: { lines: { pct: 90 }, branches: { pct: 80 } },
				"src/untested.ts": { lines: { pct: 90 }, branches: { pct: 80 } },
			}),
		);
		const steps = await runAdopt();
		// coverage >= threshold counts the companion-less file as tested
		const untested = readJson(".interlinked/untested-files-baseline.json");
		expect(untested.files as string[]).not.toContain("src/untested.ts");
		// and the coverage baseline records the high-water
		const baseline = loadBaseline(join(cwd, ".interlinked"));
		expect(baseline.files["src/untested.ts"]?.lines_pct).toBe(90);
		expect(steps[3]?.action).toBe("written");
	});

	it("keeps a higher existing coverage high-water when the report is lower", async () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		put(
			".interlinked/coverage-baseline.json",
			JSON.stringify({
				version: 1,
				updated_at: new Date(0).toISOString(),
				files: { "src/untested.ts": { lines_pct: 95, branches_pct: 95 } },
			}),
		);
		put(
			"coverage/coverage-summary.json",
			JSON.stringify({
				"src/untested.ts": { lines: { pct: 40 }, branches: { pct: 40 } },
			}),
		);
		await runAdopt();
		const baseline = loadBaseline(join(cwd, ".interlinked"));
		expect(baseline.files["src/untested.ts"]?.lines_pct).toBe(95);
		expect(baseline.files["src/untested.ts"]?.branches_pct).toBe(95);
	});

	it("keeps an existing baseline untouched when no report exists", async () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const seeded = {
			version: 1,
			updated_at: new Date(0).toISOString(),
			files: { "src/tested.ts": { lines_pct: 88, branches_pct: 77 } },
		};
		put(".interlinked/coverage-baseline.json", JSON.stringify(seeded));
		const steps = await runAdopt();
		expect(steps[3]?.action).toBe("unchanged");
		const baseline = loadBaseline(join(cwd, ".interlinked"));
		expect(baseline.files["src/tested.ts"]?.lines_pct).toBe(88);
	});
});

describe("interlinked adopt — dry run", () => {
	it("writes nothing and reports would-write for every step", async () => {
		const steps = await runAdopt({ dryRun: true });
		expect(existsSync(join(cwd, ".interlinked"))).toBe(false);
		for (const step of steps) {
			expect(step.action).toBe("would-write");
		}
		// the dry-run still computed the real offender sets
		expect(steps[1]?.detail).toContain("1 file(s) over");
	});
});

describe("adoptionArtifactChecks (doctor row)", () => {
	it("warns with the adopt pointer when artifacts are missing", () => {
		const rows = adoptionArtifactChecks(cwd);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("warn");
		expect(rows[0]?.message).toContain("interlinked adopt");
		expect(rows[0]?.message).toContain("large-files-baseline.json");
	});

	it("warns about an inert (empty) coverage baseline after a report-less adopt", async () => {
		await runAdopt();
		const rows = adoptionArtifactChecks(cwd);
		expect(rows[0]?.status).toBe("warn");
		expect(rows[0]?.message).toContain("empty");
	});

	it("passes once every artifact exists with real coverage data", async () => {
		put(
			"coverage/coverage-summary.json",
			JSON.stringify({ "src/tested.ts": { lines: { pct: 80 }, branches: { pct: 70 } } }),
		);
		await runAdopt();
		const rows = adoptionArtifactChecks(cwd);
		expect(rows[0]?.status).toBe("pass");
	});
});
