// ===========================================
// interlinked status — full-mode render helpers (status-full-render.ts)
// ===========================================
// Mutation-directed companion for status-full-render.ts — no test file existed
// for this module before (see the file's own `[interlinked:no_test_file]`
// warning). Exercises every EXPORTED render helper (renderActivityEvents,
// renderFullSessions, renderTokenSummary, renderFullActivity) with exact
// `toEqual` array/string assertions rather than `toContain` fragments, so a
// single StringLiteral / ArrayDeclaration / ConditionalExpression / boundary
// mutation anywhere in the file — including the unexported renderSessionXxx
// helpers reached only through renderFullSessions — produces a visible
// mismatch. Expected values for locale/padding-sensitive primitives
// (header/badge/table/kvLine/relativeTime/shortTimestamp/formatTokens/
// estimateCost) are built by calling the REAL (unmutated) formatter.ts
// helpers with the values the source is documented to pass them — the same
// technique status.test.ts already uses for `kvLine`, never hand-transcribed
// ANSI or padding.
//
// NOTE ON cache_creation (real product gap, not a test gap): sumSessionTokens
// accumulates `tokens_total.cache_creation`, but neither `formatTokens` nor
// `estimateCost` (formatter.ts) ever reads that field on the totals object
// they receive — the aggregate is computed and then silently dropped by
// every consumer, in BOTH renderSessionTokens and renderTokenSummary. A
// mutation to the cache_creation accumulation line therefore has NO path to
// any observable output of this module, verified by differential fuzz in
// scratch/fleet-r3/status-full-render-cache-creation-fuzz.mts (300 random
// sessions, zero divergence). Flagged in the fleet report as a real (if
// minor) product gap — not fixed here since the fix belongs in the shared
// formatter.ts (`formatTokens`/`estimateCost`), used by many other cost/usage
// displays, and is a product decision beyond this file's mutation survivors.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	// Must run before formatter.ts is imported anywhere in the module graph —
	// it samples NO_COLOR/CI/TTY once at load time. vi.hoisted guarantees this
	// runs before the static imports below are evaluated (same reasoning as
	// status.test.ts's identical vi.hoisted NO_COLOR block).
	process.env.NO_COLOR = "1";
});

import {
	badge,
	estimateCost,
	formatTokens,
	header,
	relativeTime,
	shortTimestamp,
	table,
} from "../lib/formatter.js";
import type { LocalActivityEvent, SessionState } from "../lib/local-activity.js";
import type { StatusData } from "./status.js";

const { mockReadLocalActivity } = vi.hoisted(() => ({
	mockReadLocalActivity: vi.fn<(opts?: { limit?: number }) => LocalActivityEvent[]>(),
}));

vi.mock("../lib/local-activity.js", () => ({
	readLocalActivity: mockReadLocalActivity,
}));

import {
	renderActivityEvents,
	renderFullActivity,
	renderFullSessions,
	renderTokenSummary,
} from "./status-full-render.js";

afterEach(() => {
	mockReadLocalActivity.mockReset();
});

// ===========================================
// Fixture builders
// ===========================================

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
	return {
		session_id: "s1",
		agent: "Alice",
		phase: "ACTIVE",
		// Fixed far-past timestamps keep relativeTime() in its
		// `date.toLocaleDateString()` branch regardless of when the test runs
		// (days-ago always >= 30 for any "now" after this fixture was written).
		started_at: "2020-01-01T00:00:00.000Z",
		last_event_at: "2020-01-01T00:05:00.000Z",
		tool_count: 3,
		error_count: 0,
		files_touched: [],
		tools_used: {},
		...overrides,
	};
}

function makeData(sessions: SessionState[]): StatusData {
	// SAFETY: renderFullSessions/renderTokenSummary read only `localSessions`
	// (verified in status-full-render.ts) — other StatusData fields are unused here.
	return { localSessions: sessions } as StatusData;
}

/** Mirrors the row shape renderFullSessions builds — independently written
 *  from the SessionState -> table-row spec, not copied from the SUT — used to
 *  compose exact expected output via the real (unmutated) `table()`. */
function expectedTableRow(s: SessionState): string[] {
	return [
		s.agent,
		badge(s.phase === "ACTIVE" ? "active" : "offline"),
		String(s.tool_count),
		String(s.error_count),
		relativeTime(s.last_event_at),
	];
}

function expectedSessionTable(sessions: SessionState[]): string {
	return table(["Agent", "Phase", "Tools", "Errors", "Last Event"], sessions.map(expectedTableRow));
}

/** The 3 lines every renderSessionDetail call opens with, before any
 *  optional block (files/tools/tokens/subagents/code-activity/commits). */
function baseDetailLines(s: SessionState): string[] {
	return ["", `  ${s.agent} (${s.session_id})`, `    Started: ${s.started_at}`];
}

// ===========================================
// renderActivityEvents
// ===========================================

describe("renderActivityEvents", () => {
	// test-contract: public-api — JSDoc: "withToolDetail appends a [tool]
	// suffix and leaves the summary un-dimmed"; the fallback agent glyph is
	// part of the documented per-line format.
	it("falsy agent falls back to '-', tool+summary flow through to the rendered action, detail suffix appended", () => {
		const ts = "2020-06-01T12:00:00.000Z";
		const events: LocalActivityEvent[] = [
			{ ts, agent: "", type: "post_tool_use", tool: "Bash", summary: "echo hi" },
		];
		const expectedTs = shortTimestamp(ts);
		expect(renderActivityEvents(events, true)).toEqual([
			`  ${expectedTs}  ${"-".padEnd(16)} Ran: echo hi [Bash]`,
		]);
	});

	// test-contract: public-api — same JSDoc: withToolDetail=false "leaves the
	// summary un-dimmed" is the false-branch counterpart; NO_COLOR makes dim a
	// no-op so the assertion is on the absence of the `[tool]` suffix instead.
	it("withToolDetail=false renders the same summary with no [tool] suffix", () => {
		const ts = "2020-06-01T12:00:00.000Z";
		const events: LocalActivityEvent[] = [
			{ ts, agent: "", type: "post_tool_use", tool: "Bash", summary: "echo hi" },
		];
		const expectedTs = shortTimestamp(ts);
		expect(renderActivityEvents(events, false)).toEqual([`  ${expectedTs}  ${"-".padEnd(16)} Ran: echo hi`]);
	});

	// test-contract: invariant — when the event carries no tool name at all,
	// the withToolDetail suffix must be genuinely absent, not a placeholder
	// string, independent of the summary text produced for that event.
	it("no tool on the event -> no [detail] suffix even with withToolDetail=true", () => {
		const ts = "2020-06-01T12:00:00.000Z";
		const events: LocalActivityEvent[] = [{ ts, agent: "Bob", type: "post_tool_use", summary: "did stuff" }];
		const expectedTs = shortTimestamp(ts);
		expect(renderActivityEvents(events, true)).toEqual([
			`  ${expectedTs}  ${"Bob".padEnd(16)} unknown tool: did stuff`,
		]);
	});
});

// ===========================================
// renderFullActivity
// ===========================================

describe("renderFullActivity", () => {
	// test-contract: public-api — header line is unconditional; JSDoc on the
	// section says "up to 50 events" and the empty-state copy is the
	// documented fallback when readLocalActivity returns nothing.
	it("empty activity -> header + 'No recent activity' empty-state line", () => {
		mockReadLocalActivity.mockReturnValue([]);
		expect(renderFullActivity()).toEqual([header("Recent Activity"), "  No recent activity"]);
	});

	// test-contract: public-api — JSDoc: "up to 50 events, with per-event tool
	// detail" — confirms both the header AND that events are rendered via
	// renderActivityEvents(..., true) (tool-detail branch), plus the 50-limit
	// call contract readLocalActivity is invoked with.
	it("non-empty activity -> header + activity lines with tool detail, queried at limit:50", () => {
		const ts = "2020-06-02T09:30:00.000Z";
		mockReadLocalActivity.mockReturnValue([
			{ ts, agent: "Carol", type: "post_tool_use", tool: "Write", summary: "wrote x" },
		]);
		const expectedTs = shortTimestamp(ts);
		expect(renderFullActivity()).toEqual([
			header("Recent Activity"),
			`  ${expectedTs}  ${"Carol".padEnd(16)} Wrote wrote x [Write]`,
		]);
		expect(mockReadLocalActivity).toHaveBeenCalledWith({ limit: 50 });
	});
});

/** Independently mirrors kvLine's observable format (`"  " + key.padEnd(14)
 *  + " " + value`) so the aggregate-token tests don't need a second import
 *  edit — NO_COLOR makes kvLine's internal c.dim a no-op, so this is exact. */
function kv(key: string, value: string): string {
	return `  ${key.padEnd(14)} ${value}`;
}

describe("renderFullSessions — session table (badge/row) + base detail lines", () => {
	// test-contract: public-api — JSDoc: "summary table plus one detail block
	// per session"; the empty-state copy is the documented fallback.
	it("no sessions -> header + 'No sessions recorded' empty-state line", () => {
		expect(renderFullSessions(makeData([]))).toEqual([header("Sessions"), "  No sessions recorded"]);
	});

	// test-contract: public-api — the table row's Phase column reflects
	// `s.phase === "ACTIVE"` as the "active" badge.
	it("ACTIVE session -> 'active' badge in the table row + base detail lines", () => {
		const s = makeSession({ phase: "ACTIVE", session_id: "sA", agent: "Ann" });
		expect(renderFullSessions(makeData([s]))).toEqual([
			header("Sessions"),
			expectedSessionTable([s]),
			...baseDetailLines(s),
		]);
	});

	// test-contract: public-api — the ENDED counterpart of the case above;
	// both are required to distinguish the badge from an always-true/-false mutant.
	it("ENDED session -> 'offline' badge in the table row", () => {
		const s = makeSession({ phase: "ENDED", session_id: "sB", agent: "Zed" });
		expect(renderFullSessions(makeData([s]))).toEqual([
			header("Sessions"),
			expectedSessionTable([s]),
			...baseDetailLines(s),
		]);
	});

	// test-contract: boundary — every optional collection present as a
	// truthy-but-empty value (not undefined) must still suppress its block —
	// the guard-bypass boundary shared by all six renderSessionXxx helpers.
	it("every optional collection present-but-empty -> every conditional block stays suppressed", () => {
		const s = makeSession({
			session_id: "sC",
			agent: "Empty",
			files_touched: [],
			tools_used: {},
			tokens_total: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
			subagents: {},
			by_agent: {},
			commits: [],
		});
		expect(renderFullSessions(makeData([s]))).toEqual([
			header("Sessions"),
			expectedSessionTable([s]),
			...baseDetailLines(s),
		]);
	});
});

describe("renderFullSessions — Files touched block (renderSessionFiles)", () => {
	// test-contract: public-api — JSDoc: "20-row truncation"; below the
	// threshold every file is listed and no truncation line appears.
	it("1-19 files -> every file listed, no truncation line", () => {
		const s = makeSession({ files_touched: ["a.ts", "b.ts", "c.ts"] });
		expect(renderFullSessions(makeData([s]))).toEqual([
			header("Sessions"),
			expectedSessionTable([s]),
			...baseDetailLines(s),
			"    Files touched (3):",
			"      a.ts",
			"      b.ts",
			"      c.ts",
		]);
	});

	// test-contract: boundary — exactly 20 files is the documented threshold;
	// `length > 20` must stay false here, not `>= 20`.
	it("exactly 20 files -> no truncation line (the > vs >= boundary)", () => {
		const files = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
		const s = makeSession({ files_touched: files });
		expect(renderFullSessions(makeData([s]))).toEqual([
			header("Sessions"),
			expectedSessionTable([s]),
			...baseDetailLines(s),
			"    Files touched (20):",
			...files.map((f) => `      ${f}`),
		]);
	});

	// test-contract: public-api — JSDoc: "20-row truncation"; above the
	// threshold only the first 20 are shown plus a count of the remainder.
	it("22 files -> only the first 20 listed + '... and 2 more'", () => {
		const files = Array.from({ length: 22 }, (_, i) => `f${i}.ts`);
		const s = makeSession({ files_touched: files });
		expect(renderFullSessions(makeData([s]))).toEqual([
			header("Sessions"),
			expectedSessionTable([s]),
			...baseDetailLines(s),
			"    Files touched (22):",
			...files.slice(0, 20).map((f) => `      ${f}`),
			"      ... and 2 more",
		]);
	});
});

describe("renderFullSessions — Tools used block (renderSessionTools)", () => {
	// test-contract: public-api — JSDoc: "sorted by descending count"; an
	// insertion order that disagrees with count order is required to prove
	// the sort actually runs (no-sort / always-equal / always-positive
	// comparators all collapse to insertion order for this fixture).
	it("multiple tools -> listed sorted by descending count, not insertion order", () => {
		const s = makeSession({ tools_used: { Read: 1, Bash: 5, Edit: 3 } });
		expect(renderFullSessions(makeData([s]))).toEqual([
			header("Sessions"),
			expectedSessionTable([s]),
			...baseDetailLines(s),
			"    Tools used:",
			"      Bash: 5",
			"      Edit: 3",
			"      Read: 1",
		]);
	});
});

describe("renderFullSessions — Token usage block (renderSessionTokens)", () => {
	// test-contract: public-api — JSDoc: "(full mode, v2)"; with no
	// `token_events`, the "across N events" suffix must be genuinely absent,
	// not a placeholder string.
	it("nonzero tokens, no token_events -> usage line with no 'across N events' suffix", () => {
		const tokens = { input: 5, output: 0, cache_read: 7, cache_creation: 0 };
		const s = makeSession({ tokens_total: tokens });
		expect(renderFullSessions(makeData([s]))).toEqual([
			header("Sessions"),
			expectedSessionTable([s]),
			...baseDetailLines(s),
			`    Token usage: ${formatTokens(tokens)} (${estimateCost(tokens)})`,
		]);
	});
});

describe("renderFullSessions — Subagents block (renderSessionSubagents)", () => {
	// test-contract: public-api — a subagent WITH tokens shows the "(N in /
	// M out)" suffix built from the real `|| 0` fallbacks; a subagent WITHOUT
	// a `tokens` field shows no suffix at all (not a placeholder string).
	it("subagent with tokens shows the (N in / M out) suffix; subagent without tokens shows none", () => {
		const s = makeSession({
			subagents: {
				worker: {
					files_touched: ["a.ts"],
					tools_used: { Read: 1 },
					tool_count: 1,
					tokens: { input: 100, output: 50 },
				},
				helper: { files_touched: [], tools_used: {}, tool_count: 0 },
			},
		});
		expect(renderFullSessions(makeData([s]))).toEqual([
			header("Sessions"),
			expectedSessionTable([s]),
			...baseDetailLines(s),
			"    Subagents:",
			"      worker: 1 tools, 1 files (100 in / 50 out)",
			"      helper: 0 tools, 0 files",
		]);
	});
});

describe("renderFullSessions — Commits block (renderSessionCommits)", () => {
	// test-contract: boundary — exactly 5 commits is the documented
	// truncation threshold; `length > 5` must stay false here.
	it("exactly 5 commits -> no truncation line (the > vs >= / <= boundary)", () => {
		const commits = Array.from({ length: 5 }, (_, i) => ({
			commit_hash: `h${i}00000`,
			timestamp: "2020-01-01T00:00:00.000Z",
			message: `commit ${i}`,
			files: [],
		}));
		const s = makeSession({ commits });
		expect(renderFullSessions(makeData([s]))).toEqual([
			header("Sessions"),
			expectedSessionTable([s]),
			...baseDetailLines(s),
			"    Commits attributed: 5",
			...commits.map((c) => `      ${c.commit_hash.slice(0, 7)}: ${c.message}`),
		]);
	});

	// test-contract: public-api — JSDoc: "5-row truncation"; the commit hash
	// is documented as sliced to 7 characters, and only the first 5 of a
	// longer list are rendered before the "... and N more" count line.
	it("7 commits with long hashes -> only the first 5 shown, hash sliced to 7 chars, '... and 2 more'", () => {
		const commits = Array.from({ length: 7 }, (_, i) => ({
			commit_hash: `abcdef1234567890${i}`,
			timestamp: "2020-01-01T00:00:00.000Z",
			message: `commit ${i}`,
			files: [],
		}));
		const s = makeSession({ commits });
		expect(renderFullSessions(makeData([s]))).toEqual([
			header("Sessions"),
			expectedSessionTable([s]),
			...baseDetailLines(s),
			"    Commits attributed: 7",
			...commits.slice(0, 5).map((c) => `      ${c.commit_hash.slice(0, 7)}: ${c.message}`),
			"      ... and 2 more",
		]);
	});
});

describe("renderTokenSummary", () => {
	// test-contract: public-api — JSDoc: "(omitted when zero)"; guard is
	// `allTokens.input > 0 || allTokens.output > 0`, so all-zero must return [].
	it("all-zero aggregate tokens -> empty summary (omitted)", () => {
		const s = makeSession({ tokens_total: { input: 0, output: 0, cache_read: 0, cache_creation: 0 } });
		expect(renderTokenSummary(makeData([s]))).toEqual([]);
	});

	// test-contract: public-api — aggregates input/output/cache_read via
	// the `acc.field += s.tokens_total.field || 0` fallbacks exactly, and the
	// guard admits an input-only (output===0) session.
	it("aggregates input/output/cache_read via the || 0 accumulation fallbacks", () => {
		const tokens = { input: 5, output: 0, cache_read: 7, cache_creation: 0 };
		const s = makeSession({ tokens_total: tokens });
		expect(renderTokenSummary(makeData([s]))).toEqual([
			header("Token Usage"),
			kv("Total", formatTokens(tokens)),
			kv("Est. cost", estimateCost(tokens)),
		]);
	});
});
