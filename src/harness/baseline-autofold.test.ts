// Evidence for the SessionEnd baseline auto-fold orchestrator: budget, audit
// trail, stderr line, config opt-out, dry-run, and never-throw.
//
// Labeled per the Check Evidence Contract — each describe names a direction.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BASELINE_FOLD_LOG_REL,
	DEFAULT_AUTOFOLD_BUDGET_MS,
	formatFoldWarning,
	runBaselineAutoFold,
	runSessionEndBaselineAutoFold,
	sessionStartMs,
} from "./baseline-autofold.js";
import type { FoldOutcome } from "./baseline-autofold-folds.js";
import { resetLargeFileBaselineCache } from "./large-file-policy.js";
import { resetUntestedFilesBaselineCache } from "./tested-file-policy.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "./types.js";

let cwd = "";
let fixtureSeq = 0;
const logged: string[] = [];

function write(rel: string, body: string): void {
	const abs = join(cwd, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, body, "utf-8");
}

/** A baseline + a companion test on disk, so the untested fold has real work. */
function seedUntestedWork(): void {
	write(".interlinked/untested-files-baseline.json", JSON.stringify({ version: 1, min_coverage_pct: 60, files: ["src/a.ts"] }));
	write("src/a.ts", "export const a = 1;\n");
	write("src/a.test.ts", "it('x', () => {});\n");
	resetUntestedFilesBaselineCache();
}

function auditRows(): Array<Record<string, unknown>> {
	const path = join(cwd, BASELINE_FOLD_LOG_REL);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		// SAFETY: every line is written by appendFoldAudit as a JSON object.
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function mkOutcome(over: Partial<FoldOutcome> & { kind: FoldOutcome["kind"] }): FoldOutcome {
	return { changed: 0, refused: 0, skipped: null, details: [], dryRun: false, ...over };
}

function mkEvent(over: Partial<HarnessEvent> = {}): HarnessEvent {
	// SAFETY: the orchestrator reads only session_id + dry_run from the event.
	return { hook_event: "SessionEnd", session_id: "s-1", ...over } as HarnessEvent;
}

function mkSession(files: string[]): SessionTrajectory {
	// SAFETY: the orchestrator reads only files_written + started_at.
	return { files_written: new Set(files), started_at: new Date(0).toISOString() } as SessionTrajectory;
}

function mkRules(over: Partial<GuardRulesConfig> = {}): GuardRulesConfig {
	// SAFETY: the orchestrator reads only rules.baseline_autofold.
	return over as GuardRulesConfig;
}

beforeEach(() => {
	fixtureSeq += 1;
	cwd = join(tmpdir(), `autofold-run-${process.pid}-${fixtureSeq}`);
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
	logged.length = 0;
});

afterEach(() => {
	resetUntestedFilesBaselineCache();
	resetLargeFileBaselineCache();
	rmSync(cwd, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────
describe("audit trail + stderr line — positive (must appear)", () => {
	it("P1: writes one audit row per fold that actually changed something", () => {
		seedUntestedWork();
		const result = runBaselineAutoFold({
			cwd,
			sessionId: "s-1",
			touched: ["src/a.ts"],
			sessionStartMs: 0,
			dryRun: false,
		});
		expect(result.outcomes.find((o) => o.kind === "untested_files")?.changed).toBe(1);
		const rows = auditRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("untested_files");
		expect(rows[0]?.changed).toBe(1);
		expect(rows[0]?.session).toBe("s-1");
		expect(typeof rows[0]?.at).toBe("string");
	});

	it("P2: emits exactly one stderr line naming every fold that moved", () => {
		const warning = formatFoldWarning([
			mkOutcome({ kind: "coverage", changed: 3 }),
			mkOutcome({ kind: "untested_files", changed: 2 }),
			mkOutcome({ kind: "large_files", changed: 1 }),
		]);
		expect(warning).toBe(
			"[interlinked:baseline-fold] coverage +3 raised, untested -2 dropped, large-files -1 dropped",
		);
	});

	it("P3: the SessionEnd wrapper returns the warning line", () => {
		seedUntestedWork();
		const warnings = runSessionEndBaselineAutoFold({
			cwd,
			rules: mkRules(),
			log: (m) => logged.push(m),
			event: mkEvent(),
			session: mkSession([join(cwd, "src/a.ts")]),
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[interlinked:baseline-fold]");
		expect(warnings[0]).toContain("untested -1 dropped");
	});

	it("P4: derives the session start from started_at", () => {
		expect(sessionStartMs(mkSession([]))).toBe(0);
	});
});

describe("audit trail + stderr line — negative (must stay silent)", () => {
	it("N1: writes no audit row and no warning when nothing folded", () => {
		const result = runBaselineAutoFold({ cwd, sessionId: "s-1", touched: [], sessionStartMs: 0, dryRun: false });
		expect(result.warning).toBeNull();
		expect(auditRows()).toEqual([]);
	});

	it("N2: a dry run writes NO audit row and NO baseline change", () => {
		seedUntestedWork();
		const result = runBaselineAutoFold({
			cwd,
			sessionId: "s-1",
			touched: ["src/a.ts"],
			sessionStartMs: 0,
			dryRun: true,
		});
		expect(result.outcomes.find((o) => o.kind === "untested_files")?.dryRun).toBe(true);
		expect(auditRows()).toEqual([]);
		const raw: unknown = JSON.parse(readFileSync(join(cwd, ".interlinked/untested-files-baseline.json"), "utf-8"));
		// SAFETY: the fixture wrote this file with a string[] `files`.
		expect((raw as { files: string[] }).files).toEqual(["src/a.ts"]);
	});

	it("N3: the SessionEnd wrapper honors event.dry_run", () => {
		seedUntestedWork();
		const warnings = runSessionEndBaselineAutoFold({
			cwd,
			rules: mkRules(),
			log: (m) => logged.push(m),
			event: mkEvent({ dry_run: true }),
			session: mkSession([join(cwd, "src/a.ts")]),
		});
		expect(warnings).toEqual([]);
		expect(auditRows()).toEqual([]);
	});

	it("N4: `{enabled: false}` opts out entirely", () => {
		seedUntestedWork();
		const warnings = runSessionEndBaselineAutoFold({
			cwd,
			rules: mkRules({ baseline_autofold: { enabled: false } }),
			log: (m) => logged.push(m),
			event: mkEvent(),
			session: mkSession([join(cwd, "src/a.ts")]),
		});
		expect(warnings).toEqual([]);
		expect(auditRows()).toEqual([]);
	});

	it("N5: an absent session (no files_written) folds nothing", () => {
		seedUntestedWork();
		const warnings = runSessionEndBaselineAutoFold({
			cwd,
			rules: mkRules(),
			log: (m) => logged.push(m),
			event: mkEvent(),
			session: undefined,
		});
		expect(warnings).toEqual([]);
	});

	it("N6: formatFoldWarning returns null when every fold was a no-op", () => {
		expect(formatFoldWarning([mkOutcome({ kind: "coverage", skipped: "no-input" })])).toBeNull();
	});
});

// ───────────────────────────────────────────────────────────────────
describe("budget + never-throw — negative (must degrade, not fail)", () => {
	it("N1: a zero budget skips every fold with reason `budget`", () => {
		seedUntestedWork();
		const result = runBaselineAutoFold({
			cwd,
			sessionId: "s-1",
			touched: ["src/a.ts"],
			sessionStartMs: 0,
			dryRun: false,
			budgetMs: 0,
		});
		expect(result.outcomes.every((o) => o.skipped === "budget")).toBe(true);
		expect(result.warning).toBeNull();
	});

	it("N2: the wrapper never throws when the repo root does not exist", () => {
		const warnings = runSessionEndBaselineAutoFold({
			cwd: join(cwd, "does", "not", "exist"),
			rules: mkRules(),
			log: (m) => logged.push(m),
			event: mkEvent(),
			session: mkSession(["src/a.ts"]),
		});
		expect(warnings).toEqual([]);
	});

	it("N3: the default budget is a small, positive millisecond bound", () => {
		expect(DEFAULT_AUTOFOLD_BUDGET_MS).toBeGreaterThan(0);
		expect(DEFAULT_AUTOFOLD_BUDGET_MS).toBeLessThanOrEqual(5_000);
	});

	it("N4: a malformed started_at yields 0, never NaN", () => {
		// SAFETY: deliberately malformed input for the NaN-guard path.
		expect(sessionStartMs({ started_at: "not-a-date" } as SessionTrajectory)).toBe(0);
	});
});
