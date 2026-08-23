import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	experienceAnalyzeAction,
	experienceExportAction,
	experienceListAction,
	listExperienceSessions,
} from "./experience.js";

// ---------------------------------------------------------------------------
// Shared harness: tmp dirs, console spies, process.exitCode isolation.
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let savedExitCode: number | string | undefined;

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "exp-w51-"));
	tmpDirs.push(dir);
	return dir;
}

function writeTimeline(dir: string, lines: string[]): void {
	const p = join(dir, ".interlinked");
	mkdirSync(p, { recursive: true });
	writeFileSync(join(p, "timeline.jsonl"), `${lines.join("\n")}\n`);
}

function writeActivity(dir: string, lines: string[]): void {
	const p = join(dir, ".interlinked");
	mkdirSync(p, { recursive: true });
	writeFileSync(join(p, "activity.jsonl"), `${lines.join("\n")}\n`);
}

function writeCollection(dir: string, lines: string[]): void {
	const p = join(dir, ".interlinked");
	mkdirSync(p, { recursive: true });
	writeFileSync(join(p, "collection.jsonl"), `${lines.join("\n")}\n`);
}

beforeEach(() => {
	savedExitCode = process.exitCode;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = savedExitCode;
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
	tmpDirs = [];
});

function allLoggedText(spy: ReturnType<typeof vi.spyOn>): string {
	return spy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

// ---------------------------------------------------------------------------
// parseFormat (kills 5b8445060d4e18d9, 60d897281eec6c6c)
// ---------------------------------------------------------------------------

describe("experienceExportAction — format parsing", () => {
	it("accepts format 'ix' and proceeds past the format check (no timeline data)", () => {
		const dir = makeTmpDir();
		const code = experienceExportAction({ session: "s1", format: "ix", cwd: dir, json: true });
		expect(code).toBe(1);
		const text = allLoggedText(errSpy);
		expect(text).not.toContain("Unknown format");
		expect(text).toContain("No timeline records found");
	});

	it("rejects an unknown format with the exact message", () => {
		const dir = makeTmpDir();
		const code = experienceExportAction({ session: "s1", format: "yaml", cwd: dir, json: true });
		expect(code).toBe(1);
		expect(allLoggedText(errSpy)).toContain('Unknown format \\"yaml\\" — use \\"ix\\" or \\"letta\\".');
	});
});

// ---------------------------------------------------------------------------
// parseTruncate (kills 444a97efd576d964, 09f35efee3274d96, cb2297243c73d537)
// ---------------------------------------------------------------------------

describe("experienceExportAction — truncate parsing", () => {
	it("rejects a negative --truncate value", () => {
		const dir = makeTmpDir();
		const code = experienceExportAction({
			session: "s1",
			truncate: "-5",
			cwd: dir,
			json: true,
		});
		expect(code).toBe(1);
		expect(allLoggedText(errSpy)).toContain(
			'--truncate must be a non-negative number, got \\"-5\\".',
		);
	});

	it("accepts --truncate=0 (boundary) and proceeds past the truncate check", () => {
		const dir = makeTmpDir();
		const code = experienceExportAction({
			session: "s1",
			truncate: "0",
			cwd: dir,
			json: true,
		});
		expect(code).toBe(1);
		const text = allLoggedText(errSpy);
		expect(text).not.toContain("--truncate must be");
		expect(text).toContain("No timeline records found");
	});
});

// ---------------------------------------------------------------------------
// experienceExportAction body (kills c58e174ffb230e35, eff40bdaa3f072e3,
// 9fdce85f1441bfcf, 41fef231953a60c7)
// ---------------------------------------------------------------------------

describe("experienceExportAction — success path", () => {
	function fixtureDir(): string {
		const dir = makeTmpDir();
		writeTimeline(dir, [
			JSON.stringify({
				schema: "timeline.v1",
				session: "sess1",
				ts: "2020-01-01T00:00:00.000Z",
				category: "user_prompt",
				text: "hello",
			}),
		]);
		return dir;
	}

	it("creates deeply nested output directories (recursive mkdir)", () => {
		const dir = fixtureDir();
		const outPath = join(dir, "a", "b", "c", "out.jsonl");
		const code = experienceExportAction({
			session: "sess1",
			format: "ix",
			out: outPath,
			cwd: dir,
			json: true,
		});
		expect(code).toBe(0);
		expect(existsSync(outPath)).toBe(true);
		const written = readFileSync(outPath, "utf-8").trim().split("\n");
		expect(written.length).toBeGreaterThan(0);
	});

	it("reports out/format/records/diagnostics in the success payload", () => {
		const dir = fixtureDir();
		const outPath = join(dir, "out.jsonl");
		const code = experienceExportAction({
			session: "sess1",
			format: "ix",
			out: outPath,
			cwd: dir,
			json: true,
		});
		expect(code).toBe(0);
		const text = allLoggedText(logSpy);
		const parsed = JSON.parse(text);
		expect(parsed.out).toBe(outPath);
		expect(parsed.format).toBe("ix");
		expect(parsed.records).toBe(2); // meta + 1 spine record
		expect(parsed.collection_joined).toBe(0);
		expect(parsed.guard_joined).toBe(0);
	});

	it("includes scan_truncated in the no-records error details (full mode)", () => {
		const dir = makeTmpDir();
		const code = experienceExportAction({
			session: "nosuch",
			format: "ix",
			cwd: dir,
			full: true,
		});
		expect(code).toBe(1);
		const text = allLoggedText(errSpy);
		expect(text).toContain("scan_truncated");
	});
});

// ---------------------------------------------------------------------------
// renderAnalysis via experienceAnalyzeAction (kills cdba1298cac2f123,
// 2e1fdd875d10195f, 61b454d52351dc34) + 56bf14eea9cfbd8d (no-records message)
// ---------------------------------------------------------------------------

describe("experienceAnalyzeAction", () => {
	it("reports the exact no-records message", () => {
		const dir = makeTmpDir();
		const code = experienceAnalyzeAction({ session: "ghost", cwd: dir, json: true });
		expect(code).toBe(1);
		expect(allLoggedText(errSpy)).toContain(
			'No timeline records found for session \\"ghost\\".',
		);
	});

	it("renders spaced role/class tallies and a comma-joined, top-3 guard rule list", () => {
		const dir = makeTmpDir();
		const session = "sess-analyze";
		writeTimeline(dir, [
			JSON.stringify({
				schema: "timeline.v1",
				session,
				ts: "2020-01-01T00:00:00.000Z",
				category: "user_prompt",
				text: "go",
			}),
			JSON.stringify({
				schema: "timeline.v1",
				session,
				ts: "2020-01-01T00:00:01.000Z",
				category: "agent_message",
				text: "ok",
			}),
			JSON.stringify({
				schema: "timeline.v1",
				session,
				ts: "2020-01-01T00:00:02.000Z",
				category: "tool_use",
				tool_use_id: "id1",
				tool_name: "Edit",
			}),
			JSON.stringify({
				schema: "timeline.v1",
				session,
				ts: "2020-01-01T00:00:03.000Z",
				category: "tool_use",
				tool_use_id: "id2",
				tool_name: "Bash",
			}),
			JSON.stringify({
				schema: "timeline.v1",
				session,
				ts: "2020-01-01T00:00:04.000Z",
				category: "tool_use",
				tool_use_id: "id3",
				tool_name: "Read",
			}),
			JSON.stringify({
				schema: "timeline.v1",
				session,
				ts: "2020-01-01T00:00:05.000Z",
				category: "tool_use",
				tool_use_id: "id4",
				tool_name: "Edit",
			}),
		]);
		writeCollection(dir, [
			JSON.stringify({
				kind: "tool_event",
				phase: "post",
				session_id: session,
				tool_use_id: "id1",
				tool_class: "file_edit",
			}),
			JSON.stringify({
				kind: "tool_event",
				phase: "post",
				session_id: session,
				tool_use_id: "id2",
				tool_class: "bash_command",
			}),
			JSON.stringify({
				kind: "tool_event",
				phase: "post",
				session_id: session,
				tool_use_id: "id3",
				tool_class: "file_read",
			}),
			JSON.stringify({
				kind: "tool_event",
				phase: "post",
				session_id: session,
				tool_use_id: "id4",
				tool_class: "file_edit",
			}),
		]);
		writeActivity(dir, [
			JSON.stringify({
				type: "guard_block",
				tool_use_id: "id1",
				guard_rule_id: "ruleA",
			}),
			JSON.stringify({
				type: "guard_block",
				tool_use_id: "id2",
				guard_rule_id: "ruleB",
			}),
			JSON.stringify({
				type: "guard_block",
				tool_use_id: "id3",
				guard_rule_id: "ruleC",
			}),
			JSON.stringify({
				type: "guard_block",
				tool_use_id: "id4",
				guard_rule_id: "ruleD",
			}),
		]);

		const code = experienceAnalyzeAction({ session, cwd: dir });
		expect(code).toBe(0);
		const text = allLoggedText(logSpy);

		// Space-joined role tallies (kills the " " -> "" mutant if it targets roles).
		expect(text).toMatch(/user=1\s+assistant=5/);
		// Space-joined class tallies (kills the " " -> "" mutant if it targets classes).
		expect(text).toContain("file_edit=2");
		expect(text).not.toMatch(/file_edit=2(bash_command|file_read)/);

		// top_rules capped to 3 (kills the slice(0,3) -> full-array mutant): 4
		// rules of equal count sort alphabetically, so ruleD must be excluded.
		expect(text).toContain("ruleA×1");
		expect(text).toContain("ruleB×1");
		expect(text).toContain("ruleC×1");
		expect(text).not.toContain("ruleD");

		// Comma-space joined rule list (kills the ", " -> "" mutant).
		expect(text).toContain("ruleA×1, ruleB×1, ruleC×1");
	});
});

// ---------------------------------------------------------------------------
// listExperienceSessions grouping (kills c0f38af58a1909e2, 16571d32aef75711,
// 917754406fbdf5f6)
// ---------------------------------------------------------------------------

describe("listExperienceSessions — grouping", () => {
	it("groups all records across the full scan without early termination", () => {
		const dir = makeTmpDir();
		// File order: sA (oldest), sA (repeat), sB (newest). Scan reads newest
		// first: sB (new), sA (new), sA (repeat) — this exercises every
		// `return true` in the scan callback.
		writeTimeline(dir, [
			JSON.stringify({ schema: "timeline.v1", session: "sA", ts: "2020-01-01T00:00:00.000Z" }),
			JSON.stringify({ schema: "timeline.v1", session: "sA", ts: "2020-01-01T00:00:01.000Z" }),
			JSON.stringify({ schema: "timeline.v1", session: "sB", ts: "2020-01-01T00:00:02.000Z" }),
		]);
		const { sessions, scan_truncated } = listExperienceSessions(dir);
		expect(scan_truncated).toBe(false);
		expect(sessions).toHaveLength(2);
		const sA = sessions.find((s) => s.session === "sA");
		expect(sA?.records).toBe(2);
	});

	it("skips a record whose session field is not a string", () => {
		const dir = makeTmpDir();
		writeTimeline(dir, [
			JSON.stringify({ schema: "timeline.v1", session: 42, ts: "2020-01-01T00:00:00.000Z" }),
		]);
		const { sessions } = listExperienceSessions(dir);
		expect(sessions).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// listExperienceSessions sort comparator (kills 28abc222b988631f,
// 89e3c3b7b37ee004, 18c6965a3a65077a, cab68714a2109337)
// ---------------------------------------------------------------------------

describe("listExperienceSessions — sort order", () => {
	it("sorts strictly by last_ts descending, out of natural scan order", () => {
		const dir = makeTmpDir();
		// Physical file order (top to bottom = oldest to newest write): A, B, C.
		// Data last_ts values are deliberately NOT monotonic with write order,
		// so a broken comparator that degenerates toward "keep natural scan
		// order" produces a different array than the correct descending sort.
		writeTimeline(dir, [
			JSON.stringify({ schema: "timeline.v1", session: "A", ts: "2020-01-01T00:00:03.000Z" }),
			JSON.stringify({ schema: "timeline.v1", session: "B", ts: "2020-01-01T00:00:01.000Z" }),
			JSON.stringify({ schema: "timeline.v1", session: "C", ts: "2020-01-01T00:00:02.000Z" }),
		]);
		const { sessions } = listExperienceSessions(dir);
		expect(sessions.map((s) => s.session)).toEqual(["A", "C", "B"]);
	});

	it("keeps equal-last_ts sessions in stable (scan) order — P before Q", () => {
		const dir = makeTmpDir();
		// P is written LATER physically (scanned first, inserted first into the
		// map); Q written earlier. Both share the same last_ts.
		writeTimeline(dir, [
			JSON.stringify({ schema: "timeline.v1", session: "Q", ts: "2021-01-01T00:00:00.000Z" }),
			JSON.stringify({ schema: "timeline.v1", session: "P", ts: "2021-01-01T00:00:00.000Z" }),
		]);
		const { sessions } = listExperienceSessions(dir);
		expect(sessions.map((s) => s.session)).toEqual(["P", "Q"]);
	});

	it("orders three equal-last_ts sessions consistently with a true 0-tie comparator", () => {
		const dir = makeTmpDir();
		// Scan (newest-first) inserts in order: Z, Y, X (Z's line is physically
		// last/newest). Same last_ts on all three.
		writeTimeline(dir, [
			JSON.stringify({ schema: "timeline.v1", session: "X", ts: "2022-01-01T00:00:00.000Z" }),
			JSON.stringify({ schema: "timeline.v1", session: "Y", ts: "2022-01-01T00:00:00.000Z" }),
			JSON.stringify({ schema: "timeline.v1", session: "Z", ts: "2022-01-01T00:00:00.000Z" }),
		]);
		const { sessions } = listExperienceSessions(dir);
		expect(sessions.map((s) => s.session)).toEqual(["Z", "Y", "X"]);
	});
});

// ---------------------------------------------------------------------------
// experienceListAction limit parsing (kills 94daa6ecd09cfba4)
// ---------------------------------------------------------------------------

describe("experienceListAction — limit parsing", () => {
	it("falls back to the default limit of 10 when --limit=0", () => {
		const dir = makeTmpDir();
		writeTimeline(dir, [
			JSON.stringify({ schema: "timeline.v1", session: "only", ts: "2020-01-01T00:00:00.000Z" }),
		]);
		const code = experienceListAction({ cwd: dir, limit: "0", json: true });
		expect(code).toBe(0);
		const parsed = JSON.parse(allLoggedText(logSpy));
		expect(parsed.sessions).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// LIST_BUDGET constant (kills 51ef584418ea0153, 2904c0447ec4b204)
// ---------------------------------------------------------------------------

describe("listExperienceSessions — default scan budget", () => {
	it("scans a file well past 1MB in full under the real ~64MB budget", () => {
		const dir = makeTmpDir();
		const oldLine = JSON.stringify({
			schema: "timeline.v1",
			session: "sess-old",
			ts: "2020-01-01T00:00:00.000Z",
		});
		const pad = "P".repeat(1_100_000); // not valid JSON: parsed as a malformed line, harmless
		const recentLine = JSON.stringify({
			schema: "timeline.v1",
			session: "sess-recent",
			ts: "2020-01-02T00:00:00.000Z",
		});
		writeTimeline(dir, [oldLine, pad, recentLine]);

		const { sessions, scan_truncated } = listExperienceSessions(dir);
		expect(scan_truncated).toBe(false);
		const names = sessions.map((s) => s.session).sort();
		expect(names).toEqual(["sess-old", "sess-recent"]);
	});
});
