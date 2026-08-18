// Mutation-kill campaign for cross-agent.ts (fleet-r3, pass1_w22). Targets
// the 54 surviving mutants reported in .interlinked/mutation-manifest.json
// for this file as of 2026-08-18. None of the internal helpers
// (canonicalKey, isWriteCandidate, getFilePath, fileMatches, eventFilePath)
// are exported, so every test here exercises them indirectly through the
// three exported detectors, matching the style of the companion
// cross-agent.test.ts. Eight mutants proved genuinely equivalent by hand
// (see the receipts JSONL for the structural argument) and have no
// corresponding test here.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTrajectoryFixture, makeCandidate } from "../__tests__/sequence-fixtures.js";
import { _clearCrossSessionCache } from "../cross-session.js";
import {
	fileOverwriteAfterOtherAgent,
	staleReadThenWrite,
	subagentDivergedEdit,
} from "./cross-agent.js";

// Same frozen instant style as the companion file — detectors that read
// now() (subagentDivergedEdit, fileOverwriteAfterOtherAgent) need a fixed
// clock for exact boundary-ms assertions.
const FROZEN_NOW = new Date("2026-05-27T12:00:00.000Z");

beforeAll(() => {
	vi.useFakeTimers();
	vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
	vi.useRealTimers();
});

interface ActivityRow {
	hook_event?: string;
	session_id?: string;
	agent_source?: string;
	agent_name?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	timestamp: string;
	cwd?: string;
}

function writeActivityLog(dir: string, events: ReadonlyArray<ActivityRow>): void {
	const sub = join(dir, ".interlinked");
	mkdirSync(sub, { recursive: true });
	const lines = events.map((e) =>
		JSON.stringify({
			hook_event: "PostToolUse",
			session_id: "other-session",
			agent_source: "claude",
			...e,
		}),
	);
	writeFileSync(join(sub, "activity.jsonl"), `${lines.join("\n")}\n`, "utf-8");
}

/** Minutes from the frozen "now", formatted as ISO. Negative = in the past. */
function isoMinutesFromNow(minutes: number): string {
	return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

// ===========================================
// staleReadThenWrite — exact-match (kills the ??/StringLiteral/ArrayDeclaration
// mutants living inside its match-construction block)
// ===========================================

describe("staleReadThenWrite — exact match (mutation-kill)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xa-mk-srw-exact-"));
		_clearCrossSessionCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — the returned SequenceMatch is the detector's documented contract; kills 06efe737542459a9, 5c76e85bb09c6f15, 82caf7ced87bd79d, 19882fb954c66de9, 535590dc8ee04c68, fb55dcbc33d5ec0a, 0af5b4e2b2d34df9
	it("returns the exact match object, byte for byte, for a single offending write", () => {
		const filePath = "src/foo.ts";
		const startedAt = "2026-05-27T00:00:00.000Z";
		const lastTimestamp = "2026-05-27T00:05:00.000Z";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: startedAt, agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: lastTimestamp,
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		const matches = staleReadThenWrite.fn(session, candidate);
		expect(matches).toEqual([
			{
				prior_event_count: 1,
				prior_summary: `rival wrote ${filePath} at ${lastTimestamp}`,
				message:
					`About to write ${filePath}, but rival wrote it 1 time(s) ` +
					`since this session started (${startedAt}). Your in-session read is stale. ` +
					"Re-read the file before overwriting, or acknowledge with " +
					"`// interlinked: defer stale_read_then_write -- <reason>`.",
				evidence: [filePath, lastTimestamp],
			},
		]);
	});
});

// ===========================================
// staleReadThenWrite — guard clauses inside the loop body (its own copy of
// the write-tool filter and the fileMatches wrapper, ordinal 0)
// ===========================================

describe("staleReadThenWrite — guard clauses (mutation-kill)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xa-mk-srw-guard-"));
		_clearCrossSessionCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: invariant — only write tools (Write/Edit/MultiEdit) count as offending; kills 1454d8ac9caff688, 8aec61ecd1033b40
	it("does not fire when the only other-agent row is a Read, not a write tool", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Read",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
	});

	// test-contract: invariant — an other-agent write to an unrelated path must never count as offending; kills c8dc60cb6665793a
	it("does not fire when the only other-agent write targets an unrelated file", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: "docs/totally-unrelated-name.md" },
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
	});
});

// ===========================================
// fileMatches (private helper) — exercised via staleReadThenWrite, whose
// started_at/timestamp comparisons are the least entangled with any other
// mutant under test.
// ===========================================

describe("fileMatches via staleReadThenWrite (mutation-kill)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xa-mk-filematch-"));
		_clearCrossSessionCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: invariant — an event with no file_path never matches any target file; kills 3117105440c4ad03, 5b808f0fd7d31e26, and the guard-site BooleanLiteral (1fd4b67fd3cf200f or 4226099595a94366, whichever is textually the guard)
	it("does not fire when the offending row has no file_path (empty eventFile)", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				// no tool_input at all -> eventFilePath resolves to ""
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
	});

	// test-contract: invariant — two genuinely unrelated non-empty paths never match; kills ad3ad1f4567e4089, 7c1a41a693cf271d, 29ee1eae5a79ac55, 0f0dbe6bfbe9be2b, and the trailing-return BooleanLiteral (1fd4b67fd3cf200f or 4226099595a94366, whichever is textually the final return)
	it("does not fire when the offending row targets a wholly unrelated non-empty path", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: "docs/totally-unrelated-name.md" },
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
	});
});

// ===========================================
// getFilePath (private helper) — exercised via fileOverwriteAfterOtherAgent,
// which does not require seeding files_read (unlike staleReadThenWrite,
// which requires the read to have happened).
// ===========================================

describe("getFilePath via fileOverwriteAfterOtherAgent (mutation-kill)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xa-mk-getfilepath-"));
		_clearCrossSessionCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: invariant — a candidate with no tool_input must resolve to "no file", not a placeholder path; kills d2d4815a3df19303
	it("treats a candidate with no tool_input as having no file (not a placeholder path)", () => {
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: "Stryker was here!" },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({ tool_name: "Write", cwd: dir, agent_name: "me" });
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
	});

	// test-contract: invariant — a non-string file_path must resolve to "no file", not a placeholder path; kills e07238126143a0a6
	it("treats a non-string file_path as having no file (not a placeholder path)", () => {
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: "Stryker was here!" },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			// SAFETY: deliberately-wrong runtime type to exercise getFilePath's
			// typeof-guard; TS is told string, but the test needs a real number.
			tool_input: { file_path: 123 as unknown as string },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
	});

	// test-contract: invariant — getFilePath must never return a non-string fp value verbatim; kills ec1c39f9844be5a3
	it("does not return a non-string file_path value verbatim", () => {
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: "src/file42" },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			// SAFETY: deliberately-wrong runtime type to exercise getFilePath's
			// typeof-guard; TS is told string, but the test needs a real number.
			tool_input: { file_path: 42 as unknown as string },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
	});
});

// ===========================================
// subagentDivergedEdit — exact match
// ===========================================

describe("subagentDivergedEdit — exact match (mutation-kill)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xa-mk-sde-exact-"));
		_clearCrossSessionCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — the returned SequenceMatch is the detector's documented contract; kills 19a17f2f1e1c7901, ac52e5d9b505373f, 45f5ee696093c0e9, ccdde4afc2b55310, 298f6d883eb7ecfa, 86511b8d456b5c14, 6ff7cd4775f25337
	it("returns the exact match object, byte for byte, for a single divergent write", () => {
		const filePath = join(dir, "src/foo.ts");
		const otherTimestamp = "2026-05-27T11:50:00.000Z"; // isoMinutesFromNow(-10)
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Write", tool_input: { file_path: filePath }, cwd: dir }],
			{ agent_name: "parent" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "subagent-x",
				tool_name: "Edit",
				tool_input: { file_path: filePath },
				timestamp: otherTimestamp,
			},
		]);
		const candidate = makeCandidate({ hook_event: "Stop", cwd: dir, agent_name: "parent" });
		const matches = subagentDivergedEdit.fn(session, candidate);
		expect(matches).toEqual([
			{
				prior_event_count: 1,
				prior_summary: `subagent-x wrote ${filePath} at ${otherTimestamp}`,
				message:
					`Both this session and subagent-x wrote ${filePath} in the last 30 minutes. ` +
					"Coarse proxy for parent/subagent divergence — verify the final on-disk state " +
					"matches intent, or acknowledge with " +
					"`// interlinked: defer subagent_diverged_edit -- <reason>`.",
				evidence: [filePath, otherTimestamp],
			},
		]);
	});
});

// ===========================================
// subagentDivergedEdit — guard clauses inside the loop body (ordinal 1 of
// the shared write-tool/fileMatches sites, plus its own evMs boundary)
// ===========================================

describe("subagentDivergedEdit — guard clauses (mutation-kill)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xa-mk-sde-guard-"));
		_clearCrossSessionCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: invariant — only write tools (Write/Edit/MultiEdit) count as divergent; kills 47f008d7d95949c9, dea2a4c732539194
	it("does not fire when the only other-agent row is a Read, not a write tool", () => {
		const filePath = join(dir, "src/foo.ts");
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Write", tool_input: { file_path: filePath }, cwd: dir }],
			{ agent_name: "parent" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "sub",
				tool_name: "Read",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({ hook_event: "Stop", cwd: dir, agent_name: "parent" });
		expect(subagentDivergedEdit.fn(session, candidate)).toEqual([]);
	});

	// test-contract: invariant — an other-agent write to an unrelated path must never count as divergent; kills 4b52f7c9aa1ce687
	it("does not fire when the only other-agent write targets an unrelated file", () => {
		const filePath = join(dir, "src/foo.ts");
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Write", tool_input: { file_path: filePath }, cwd: dir }],
			{ agent_name: "parent" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "sub",
				tool_name: "Write",
				tool_input: { file_path: join(dir, "docs/unrelated.md") },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({ hook_event: "Stop", cwd: dir, agent_name: "parent" });
		expect(subagentDivergedEdit.fn(session, candidate)).toEqual([]);
	});

	// test-contract: boundary — an other-agent write exactly at the 30-minute window edge still counts; kills 163a7674fa0a3d64
	it("fires for an other-agent write exactly at the 30-minute window boundary", () => {
		const filePath = join(dir, "src/foo.ts");
		const boundaryTimestamp = "2026-05-27T11:30:00.000Z"; // isoMinutesFromNow(-30)
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Write", tool_input: { file_path: filePath }, cwd: dir }],
			{ agent_name: "parent" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "sub",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: boundaryTimestamp,
			},
		]);
		const candidate = makeCandidate({ hook_event: "Stop", cwd: dir, agent_name: "parent" });
		expect(subagentDivergedEdit.fn(session, candidate)).toEqual([
			{
				prior_event_count: 1,
				prior_summary: `sub wrote ${filePath} at ${boundaryTimestamp}`,
				message:
					`Both this session and sub wrote ${filePath} in the last 30 minutes. ` +
					"Coarse proxy for parent/subagent divergence — verify the final on-disk state " +
					"matches intent, or acknowledge with " +
					"`// interlinked: defer subagent_diverged_edit -- <reason>`.",
				evidence: [filePath, boundaryTimestamp],
			},
		]);
	});
});

// ===========================================
// fileOverwriteAfterOtherAgent — exact match
// ===========================================

describe("fileOverwriteAfterOtherAgent — exact match (mutation-kill)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xa-mk-foa-exact-"));
		_clearCrossSessionCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — the returned SequenceMatch is the detector's documented contract; kills 429dc63de50f1c98, 5c124b5629bdf72d, 7d77e51a19bfd253, 55c4fd6777c881be, 24d1a189d956badf, b18d7c731dce215d, 0ecc0ebd191490b2
	it("returns the exact match object, byte for byte, for a single unread overwrite", () => {
		const filePath = "src/foo.ts";
		const otherTimestamp = "2026-05-27T11:45:00.000Z"; // isoMinutesFromNow(-15)
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: otherTimestamp,
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		const matches = fileOverwriteAfterOtherAgent.fn(session, candidate);
		expect(matches).toEqual([
			{
				prior_event_count: 1,
				prior_summary: `rival wrote ${filePath} at ${otherTimestamp}`,
				message:
					`About to write ${filePath}, but rival wrote it within the last hour ` +
					"and this session has not read it. Read the current contents first to confirm " +
					"the overwrite is intended, or acknowledge with " +
					"`// interlinked: defer file_overwrite_after_other_agent -- <reason>`.",
				evidence: [filePath, otherTimestamp],
			},
		]);
	});
});

// ===========================================
// fileOverwriteAfterOtherAgent — guard clauses inside the loop body
// (ordinal 2 of the shared write-tool/fileMatches sites, plus its own evMs
// boundary, ordinal 1)
// ===========================================

describe("fileOverwriteAfterOtherAgent — guard clauses (mutation-kill)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xa-mk-foa-guard-"));
		_clearCrossSessionCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: invariant — only write tools (Write/Edit/MultiEdit) count as a prior overwrite; kills 90c9b56cc456e0c6, c839eadeaacb81d5
	it("does not fire when the only other-agent row is a Read, not a write tool", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Read",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
	});

	// test-contract: invariant — an other-agent write to an unrelated path must never count as a prior overwrite; kills da3e9e3ccd90e4b3
	it("does not fire when the only other-agent write targets an unrelated file", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: "totally/unrelated.md" },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
	});

	// test-contract: boundary — an other-agent write exactly at the 1-hour window edge still counts; kills ace32e6b7aa14f44
	it("fires for an other-agent write exactly at the 1-hour window boundary", () => {
		const filePath = "src/foo.ts";
		const boundaryTimestamp = "2026-05-27T11:00:00.000Z"; // isoMinutesFromNow(-60)
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: boundaryTimestamp,
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([
			{
				prior_event_count: 1,
				prior_summary: `rival wrote ${filePath} at ${boundaryTimestamp}`,
				message:
					`About to write ${filePath}, but rival wrote it within the last hour ` +
					"and this session has not read it. Read the current contents first to confirm " +
					"the overwrite is intended, or acknowledge with " +
					"`// interlinked: defer file_overwrite_after_other_agent -- <reason>`.",
				evidence: [filePath, boundaryTimestamp],
			},
		]);
	});
});

// ===========================================
// Detector phase metadata — never individually asserted by the companion
// file (it only checks family/determinism/default_enabled in a loop).
// ===========================================

describe("detector phase metadata (mutation-kill)", () => {
	// test-contract: public-api — phase is a documented field of the exported detector object; kills fa22a387e00ff58d
	it("staleReadThenWrite.phase is exactly pre_warn", () => {
		expect(staleReadThenWrite.phase).toBe("pre_warn");
	});

	// test-contract: public-api — phase is a documented field of the exported detector object; kills 39d9e568b21ed178
	it("subagentDivergedEdit.phase is exactly stop", () => {
		expect(subagentDivergedEdit.phase).toBe("stop");
	});

	// test-contract: public-api — phase is a documented field of the exported detector object; kills f9af2ab591c584a4
	it("fileOverwriteAfterOtherAgent.phase is exactly pre_warn", () => {
		expect(fileOverwriteAfterOtherAgent.phase).toBe("pre_warn");
	});
});
