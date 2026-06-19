// ===========================================
// coverage-discharge — observed-green-run obligation discharge
// ===========================================
// The Stop nudge (`formatDeferredCoverageWarning`) tells the user that running
// the suite with coverage discharges deferred obligations — but only the commit
// gate ever recorded a discharge, so a user who followed the instruction kept
// getting the same warning (finding 2026-06). This module is the promised
// relief path: a coverage-suite Bash command observed GREEN discharges every
// open obligation whose file the fresh report actually MEASURED.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	dischargeObligationsAfterGreenRun,
	isCoverageSuiteCommand,
	measuredCoverageFiles,
	noteCoverageSuiteRunStart,
} from "../coverage-discharge.js";
import {
	type CoverageObligation,
	readOpenCoverageObligations,
	recordCoverageDischarge,
	recordCoverageObligation,
} from "../coverage-obligation-ledger.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "cov-discharge-"));
	mkdirSync(join(tmp, "coverage"), { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function obligation(file: string, sessionId = "sess-1", timestamp = "2026-06-01T00:00:00.000Z"): CoverageObligation {
	return {
		kind: "coverage",
		file,
		reason: "budget_exceeded",
		estimated_suite_ms: 60_000,
		budget_ms: 25_000,
		session_id: sessionId,
		timestamp,
	};
}

/** Minimal LCOV report measuring `rel` at the given report path. */
function writeLcov(rel: string, reportRel = "coverage/lcov.info"): void {
	const target = join(tmp, reportRel);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, [`SF:${rel}`, "DA:1,1", "end_of_record", ""].join("\n"));
}

describe("isCoverageSuiteCommand — deterministic coverage-run detection", () => {
	it("matches the major runners carrying a coverage flag", () => {
		expect(isCoverageSuiteCommand("npx vitest run --coverage")).toBe(true);
		expect(isCoverageSuiteCommand("npx jest --coverage")).toBe(true);
		expect(isCoverageSuiteCommand("pytest --cov")).toBe(true);
		expect(isCoverageSuiteCommand("pytest --cov=src --cov-report=lcov")).toBe(true);
		expect(isCoverageSuiteCommand("coverage run -m pytest")).toBe(true);
		expect(isCoverageSuiteCommand("python -m coverage run -m pytest")).toBe(true);
		expect(isCoverageSuiteCommand("python3 -m coverage run -m unittest discover")).toBe(true);
		expect(isCoverageSuiteCommand("cargo llvm-cov --lcov --output-path coverage/lcov-rust.info")).toBe(true);
		expect(isCoverageSuiteCommand("npm test -- --coverage")).toBe(true);
		expect(isCoverageSuiteCommand("npx c8 node test.js")).toBe(true);
	});

	it("rejects test runs WITHOUT coverage and coverage exports without a run", () => {
		expect(isCoverageSuiteCommand("npx vitest run")).toBe(false);
		expect(isCoverageSuiteCommand("pytest -x")).toBe(false);
		expect(isCoverageSuiteCommand("coverage lcov -o coverage/lcov-python.info")).toBe(false);
		expect(isCoverageSuiteCommand("git commit -m 'add --coverage flag docs'")).toBe(false);
		expect(isCoverageSuiteCommand("")).toBe(false);
	});

	it("rejects REPORT-ONLY subcommands — they re-emit existing data, running no tests (finding 2026-06)", () => {
		expect(isCoverageSuiteCommand("npx c8 report")).toBe(false);
		expect(isCoverageSuiteCommand("nyc report --reporter=lcov")).toBe(false);
		expect(isCoverageSuiteCommand("nyc merge .nyc_output coverage.json")).toBe(false);
		expect(isCoverageSuiteCommand("nyc check-coverage --lines 90")).toBe(false);
		expect(isCoverageSuiteCommand("nyc instrument src instrumented")).toBe(false);
		expect(isCoverageSuiteCommand("cargo llvm-cov report --lcov")).toBe(false);
		expect(isCoverageSuiteCommand("cargo llvm-cov clean")).toBe(false);
		expect(isCoverageSuiteCommand("cargo llvm-cov show-env")).toBe(false);
		// …while the RUNNING forms of the same wrappers still count.
		expect(isCoverageSuiteCommand("npx c8 node app.test.js")).toBe(true);
		expect(isCoverageSuiteCommand("nyc mocha")).toBe(true);
		expect(isCoverageSuiteCommand("cargo llvm-cov nextest")).toBe(true);
	});

	it("rejects coverage wrappers around NON-test programs — a green run of zero tests is not evidence (round 4)", () => {
		expect(isCoverageSuiteCommand("coverage run app.py")).toBe(false);
		expect(isCoverageSuiteCommand("coverage run manage.py migrate")).toBe(false);
		expect(isCoverageSuiteCommand("npx c8 node script.js")).toBe(false);
		expect(isCoverageSuiteCommand("nyc node server.js")).toBe(false);
		expect(isCoverageSuiteCommand("cargo llvm-cov run")).toBe(false); // runs the BINARY, not the suite
		// Round 5: global flags may precede the subcommand — the whole clause is
		// scanned, not just the token after `llvm-cov`.
		expect(isCoverageSuiteCommand("cargo llvm-cov --workspace report --lcov")).toBe(false);
		expect(isCoverageSuiteCommand("cargo llvm-cov --no-report run --bin server")).toBe(false);
		expect(isCoverageSuiteCommand("cargo llvm-cov --workspace --lcov --output-path coverage/lcov-rust.info")).toBe(true);
		expect(isCoverageSuiteCommand("cargo llvm-cov nextest --workspace")).toBe(true);
		// …while wrapped TEST invocations keep counting.
		expect(isCoverageSuiteCommand("coverage run -m pytest tests/")).toBe(true);
		expect(isCoverageSuiteCommand("coverage run -m unittest discover")).toBe(true);
		expect(isCoverageSuiteCommand("c8 node --test")).toBe(true);
		expect(isCoverageSuiteCommand("nyc ava")).toBe(true);
		expect(isCoverageSuiteCommand("c8 node parser.spec.js")).toBe(true);
	});
});

describe("measuredCoverageFiles — which files a fresh report actually measured", () => {
	it("returns the union of istanbul and every per-language LCOV report, each with its mtime", () => {
		writeLcov("src/a.ts");
		writeLcov("pkg/mod.py", "coverage/lcov-python.info");
		const reports = measuredCoverageFiles(tmp);
		const all = new Set(reports.flatMap((r) => [...r.files]));
		expect(all.has("src/a.ts")).toBe(true);
		expect(all.has("pkg/mod.py")).toBe(true);
		for (const r of reports) expect(r.mtimeMs).toBeGreaterThan(0);
	});

	it("returns [] when no report exists", () => {
		expect(measuredCoverageFiles(tmp)).toEqual([]);
	});
});

describe("dischargeObligationsAfterGreenRun — the promised relief path", () => {
	/** Observed run start a minute ago — fresh report writes land inside the window. */
	function noteRecentRunStart(sessionId = "sess-1"): void {
		noteCoverageSuiteRunStart(sessionId, new Date(Date.now() - 60_000).toISOString());
	}

	it("discharges an open obligation whose file the fresh report measured", () => {
		recordCoverageObligation(tmp, obligation("src/a.ts"));
		writeLcov("src/a.ts");
		noteRecentRunStart();
		const discharged = dischargeObligationsAfterGreenRun(tmp, "sess-1", "2026-06-09T00:00:00.000Z");
		expect(discharged).toEqual(["src/a.ts"]);
		expect(readOpenCoverageObligations(tmp, "sess-1")).toEqual([]);
		// The discharge is a persisted ledger row, not in-memory state.
		const ledger = readFileSync(join(tmp, ".interlinked", "coverage-obligations.jsonl"), "utf-8");
		expect(ledger).toContain("coverage_discharge");
	});

	it("leaves an obligation OPEN when the run did not measure its file (scoped run)", () => {
		recordCoverageObligation(tmp, obligation("src/unmeasured.ts"));
		writeLcov("src/other.ts");
		noteRecentRunStart();
		const discharged = dischargeObligationsAfterGreenRun(tmp, "sess-1", "2026-06-09T00:00:00.000Z");
		expect(discharged).toEqual([]);
		expect(readOpenCoverageObligations(tmp, "sess-1").map((o) => o.file)).toEqual(["src/unmeasured.ts"]);
	});

	it("ignores a STALE report older than the obligation (the deferred edit post-dates it)", () => {
		writeLcov("src/a.ts");
		const old = new Date("2026-05-01T00:00:00Z");
		utimesSync(join(tmp, "coverage", "lcov.info"), old, old);
		recordCoverageObligation(tmp, obligation("src/a.ts", "sess-1", "2026-06-01T00:00:00.000Z"));
		noteRecentRunStart();
		const discharged = dischargeObligationsAfterGreenRun(tmp, "sess-1", "2026-06-09T00:00:00.000Z");
		expect(discharged).toEqual([]); // the report predates the deferral — not evidence
	});

	it("does NOT discharge without an observed run start (evidence cannot be bound)", () => {
		recordCoverageObligation(tmp, obligation("src/a.ts"));
		writeLcov("src/a.ts");
		// No noteCoverageSuiteRunStart — e.g. the daemon restarted mid-run.
		expect(dischargeObligationsAfterGreenRun(tmp, "sess-1", "2026-06-09T00:00:00.000Z")).toEqual([]);
		expect(readOpenCoverageObligations(tmp, "sess-1").map((o) => o.file)).toEqual(["src/a.ts"]);
	});

	it("does NOT discharge on a report predating the observed run (a failed earlier run's leftovers — round 6)", () => {
		recordCoverageObligation(tmp, obligation("src/a.ts"));
		writeLcov("src/a.ts"); // written NOW — e.g. by an earlier FAILED full run
		// The green scoped run we observed started AFTER that report was written.
		noteCoverageSuiteRunStart("sess-1", new Date(Date.now() + 60_000).toISOString());
		const discharged = dischargeObligationsAfterGreenRun(tmp, "sess-1", "2026-06-09T00:00:00.000Z");
		expect(discharged).toEqual([]);
		expect(readOpenCoverageObligations(tmp, "sess-1").map((o) => o.file)).toEqual(["src/a.ts"]);
	});

	it("consumes the noted start: a second discharge pass needs a new observed run", () => {
		recordCoverageObligation(tmp, obligation("src/a.ts"));
		writeLcov("src/a.ts");
		noteRecentRunStart();
		expect(dischargeObligationsAfterGreenRun(tmp, "sess-1", "2026-06-09T00:00:00.000Z")).toEqual(["src/a.ts"]);
		recordCoverageObligation(tmp, obligation("src/a.ts", "sess-1", "2026-06-10T00:00:00.000Z"));
		// Same session, no new start observed → the re-opened obligation stays.
		expect(dischargeObligationsAfterGreenRun(tmp, "sess-1", "2026-06-10T01:00:00.000Z")).toEqual([]);
	});

	it("is a no-op without open obligations (no report parse spent)", () => {
		writeLcov("src/a.ts");
		noteRecentRunStart();
		expect(dischargeObligationsAfterGreenRun(tmp, "sess-1", "2026-06-09T00:00:00.000Z")).toEqual([]);
	});
});

describe("readOpenCoverageObligations — netting + cross-session discharges", () => {
	it("nets obligations against discharges chronologically; a re-edit re-opens", () => {
		recordCoverageObligation(tmp, obligation("src/a.ts", "sess-1", "2026-06-01T00:00:00.000Z"));
		recordCoverageDischarge(tmp, "src/a.ts", "sess-1", "2026-06-02T00:00:00.000Z");
		expect(readOpenCoverageObligations(tmp, "sess-1")).toEqual([]);
		recordCoverageObligation(tmp, obligation("src/a.ts", "sess-1", "2026-06-03T00:00:00.000Z"));
		expect(readOpenCoverageObligations(tmp, "sess-1").map((o) => o.file)).toEqual(["src/a.ts"]);
	});

	it("a discharge from ANOTHER session/process closes the obligation (it is a fact about the FILE)", () => {
		// The commit gate (or a CLI coverage run) may discharge under a different
		// session id than the one that deferred — the measurement is no less real
		// (finding 2026-06: session-filtered discharges kept the Stop warning alive
		// after the promised relief actually happened).
		recordCoverageObligation(tmp, obligation("src/a.ts", "sess-1"));
		recordCoverageDischarge(tmp, "src/a.ts", "OTHER-session", "2026-06-02T00:00:00.000Z");
		expect(readOpenCoverageObligations(tmp, "sess-1")).toEqual([]);
	});

	it("still filters OBLIGATIONS to the requested session (who deferred is session-scoped)", () => {
		recordCoverageObligation(tmp, obligation("src/a.ts", "someone-else"));
		expect(readOpenCoverageObligations(tmp, "sess-1")).toEqual([]);
	});
});
