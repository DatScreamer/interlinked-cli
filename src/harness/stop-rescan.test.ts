// Tests for the Stop-event deterministic pattern rescan.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type PatternRescanFinding, rescanSessionFiles } from "./stop-rescan.js";
import type { SessionTrajectory } from "./types.js";

/** Static ISO timestamp — tests use a fixed value so date generation never
 *  participates in determinism. The rescan code never reads `started_at`. */
const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function makeSession(filesWritten: string[]): SessionTrajectory {
	// SessionTrajectory has many required fields; build a minimal shape with
	// just what the rescan reads.
	return {
		session_id: "test-session",
		agent_source: "claude",
		agent_name: "tester",
		started_at: FIXED_TIMESTAMP,
		tdd_cycles: [],
		assertion_counts: new Map(),
		files_written: new Set(filesWritten),
		commands_run: [],
		active_skills: new Map(),
		verification_observed: new Set(),
		stubs_introduced: [],
		fired_reminders: new Set(),
		non_doc_files_edited_since_commit: new Set(),
		doc_files_edited_since_commit: 0,
		stop_nudge_emitted: false,
	} as unknown as SessionTrajectory;
}

describe("rescanSessionFiles", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rescan-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("finds a pickle.load in a touched .py file", () => {
		const filePath = join(dir, "loader.py");
		writeFileSync(filePath, "import pickle\nobj = pickle.load(f)\n");
		const session = makeSession([filePath]);
		const findings = rescanSessionFiles(session, dir);
		const ids = findings.map((f) => f.checkId);
		expect(ids).toContain("ubs_pickle_untrusted_load");
		const finding = findings.find((f) => f.checkId === "ubs_pickle_untrusted_load");
		expect(finding?.deferred).toBe(false);
		expect(finding?.deferReason).toBeNull();
	});

	it("marks a finding as deferred when the line has `// interlinked: defer` above", () => {
		const filePath = join(dir, "x.ts");
		writeFileSync(
			filePath,
			"// interlinked: defer eval_usage -- sandboxed by callers\neval(code);\n",
		);
		const session = makeSession([filePath]);
		const findings = rescanSessionFiles(session, dir);
		const eval_ = findings.find((f) => f.checkId === "eval_usage");
		expect(eval_).toBeDefined();
		expect(eval_?.deferred).toBe(true);
		expect(eval_?.deferReason).toBe("sandboxed by callers");
	});

	it("marks a finding as deferred when a trailing `# interlinked: defer` comment is present", () => {
		const filePath = join(dir, "loader.py");
		writeFileSync(
			filePath,
			"import pickle\nobj = pickle.load(f)  # interlinked: defer ubs_pickle_untrusted_load -- legacy trusted\n",
		);
		const session = makeSession([filePath]);
		const findings = rescanSessionFiles(session, dir);
		const pickle = findings.find((f) => f.checkId === "ubs_pickle_untrusted_load");
		expect(pickle?.deferred).toBe(true);
		expect(pickle?.deferReason).toBe("legacy trusted");
	});

	it("does not double-count when files_written contains both absolute and relative paths for the same file", () => {
		const filePath = join(dir, "loader.py");
		writeFileSync(filePath, "obj = pickle.load(f)\n");
		const session = makeSession([filePath, "loader.py"]);
		const findings = rescanSessionFiles(session, dir);
		const pickleFindings = findings.filter((f) => f.checkId === "ubs_pickle_untrusted_load");
		expect(pickleFindings.length).toBe(1);
	});

	it("skips files that have been deleted between the edit and the rescan", () => {
		const session = makeSession([join(dir, "ghost.py")]);
		// File never written — rescan should swallow the ENOENT and return [].
		expect(rescanSessionFiles(session, dir)).toEqual([]);
	});

	it("returns an empty array when no files were written in the session", () => {
		expect(rescanSessionFiles(makeSession([]), dir)).toEqual([]);
	});
});
