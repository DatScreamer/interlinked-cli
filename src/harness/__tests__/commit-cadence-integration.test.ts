// Integration tests for the commit-cadence nudge — exercises the
// PostToolUse increment / reset / mid-session-backstop machinery via
// the public `evaluatePostToolUse` entry point. The Stop-hook nudge
// runs inside `server.ts` against a transcript file, so it's exercised
// at the helper level (`formatStopNudge`) in commit-cadence.test.ts
// rather than re-stood up here.

import { beforeEach, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePostToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig } from "../rules-loader.js";
import type { GuardRulesConfig, SessionTrajectory } from "../types.js";
import { makeEvent, makeSession } from "./fixtures/evaluator.js";

describe("commit-cadence — PostToolUse integration", () => {
	let rules: GuardRulesConfig;
	let session: SessionTrajectory;
	let cohort: CohortManager;
	let reservations: ReservationManager;

	beforeEach(() => {
		rules = getDefaultConfig();
		// Fixture sessions are bare-bones; populate the cadence fields.
		session = {
			...makeSession(),
			non_doc_files_edited_since_commit: new Set(),
			doc_files_edited_since_commit: 0,
			mid_session_nudge_emitted: false,
			stop_nudge_emitted: false,
		};
		cohort = new CohortManager();
		reservations = new ReservationManager();
	});

	function postEdit(filePath: string): void {
		evaluatePostToolUse(
			makeEvent({
				hook_event: "PostToolUse",
				tool_name: "Write",
				tool_input: { file_path: filePath, content: "x" },
			}),
			rules,
			session,
			reservations,
			cohort,
		);
	}

	function postBash(command: string): void {
		evaluatePostToolUse(
			makeEvent({
				hook_event: "PostToolUse",
				tool_name: "Bash",
				tool_input: { command },
			}),
			rules,
			session,
			reservations,
			cohort,
		);
	}

	it("counts non-doc Write edits as uncommitted code-file work", () => {
		postEdit("/repo/src/a.ts");
		postEdit("/repo/src/b.ts");
		expect(session.non_doc_files_edited_since_commit?.size).toBe(2);
		expect(session.doc_files_edited_since_commit ?? 0).toBe(0);
	});

	it("dedupes re-edits to the same file", () => {
		postEdit("/repo/src/a.ts");
		postEdit("/repo/src/a.ts");
		postEdit("/repo/src/a.ts");
		expect(session.non_doc_files_edited_since_commit?.size).toBe(1);
	});

	it("does NOT count markdown / docs / plans / CLAUDE.md edits", () => {
		postEdit("/repo/README.md");
		postEdit("/repo/docs/intro.mdx");
		postEdit("/repo/plans/q3.yaml");
		postEdit("/repo/CLAUDE.md");
		expect(session.non_doc_files_edited_since_commit?.size).toBe(0);
		expect(session.doc_files_edited_since_commit ?? 0).toBe(4);
	});

	it("clears the set on `git commit` Bash invocations", () => {
		postEdit("/repo/src/a.ts");
		postEdit("/repo/src/b.ts");
		expect(session.non_doc_files_edited_since_commit?.size).toBe(2);
		postBash("git commit -m 'wip'");
		expect(session.non_doc_files_edited_since_commit?.size).toBe(0);
		expect(session.doc_files_edited_since_commit ?? 0).toBe(0);
	});

	it("does not clear on unrelated Bash commands", () => {
		postEdit("/repo/src/a.ts");
		postBash("ls -la");
		expect(session.non_doc_files_edited_since_commit?.size).toBe(1);
	});

	it("emits the mid-session backstop warning when threshold is crossed", () => {
		// Drop the threshold so the test doesn't have to spam 41 edits.
		rules.commit_cadence = {
			...rules.commit_cadence,
			enabled: true,
			stop_threshold: 5,
			mid_session_threshold: 3,
			token_band_low: 200_000,
			token_band_high: 400_000,
			doc_globs: rules.commit_cadence?.doc_globs ?? [],
		};

		const decisions: Array<{ warnings?: string[] }> = [];
		for (const f of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
			decisions.push(
				evaluatePostToolUse(
					makeEvent({
						hook_event: "PostToolUse",
						tool_name: "Write",
						tool_input: { file_path: `/repo/src/${f}`, content: "x" },
					}),
					rules,
					session,
					reservations,
					cohort,
				),
			);
		}
		// The 4th edit (size=4 > threshold=3) should fire the backstop.
		const fired = decisions.find((d) =>
			d.warnings?.some((w) => w.includes("[interlinked:commit-cadence]")),
		);
		expect(fired).toBeDefined();
	});

	it("fires the mid-session backstop at most once per session", () => {
		rules.commit_cadence = {
			...rules.commit_cadence,
			enabled: true,
			stop_threshold: 5,
			mid_session_threshold: 2,
			token_band_low: 200_000,
			token_band_high: 400_000,
			doc_globs: rules.commit_cadence?.doc_globs ?? [],
		};

		const decisions: Array<{ warnings?: string[] }> = [];
		for (const f of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
			decisions.push(
				evaluatePostToolUse(
					makeEvent({
						hook_event: "PostToolUse",
						tool_name: "Write",
						tool_input: { file_path: `/repo/src/${f}`, content: "x" },
					}),
					rules,
					session,
					reservations,
					cohort,
				),
			);
		}
		const cadenceWarnings = decisions.flatMap(
			(d) => d.warnings?.filter((w) => w.includes("[interlinked:commit-cadence]")) ?? [],
		);
		expect(cadenceWarnings.length).toBe(1);
	});

	it("re-arms the mid-session backstop after a git commit", () => {
		rules.commit_cadence = {
			...rules.commit_cadence,
			enabled: true,
			stop_threshold: 5,
			mid_session_threshold: 2,
			token_band_low: 200_000,
			token_band_high: 400_000,
			doc_globs: rules.commit_cadence?.doc_globs ?? [],
		};

		// First burst — fires once.
		for (const f of ["a.ts", "b.ts", "c.ts"]) postEdit(`/repo/src/${f}`);
		expect(session.mid_session_nudge_emitted).toBe(true);

		// Commit clears the set + flag.
		postBash("git commit -m foo");
		expect(session.mid_session_nudge_emitted).toBe(false);

		// Second burst — fires again.
		const after: Array<{ warnings?: string[] }> = [];
		for (const f of ["d.ts", "e.ts", "f.ts"]) {
			after.push(
				evaluatePostToolUse(
					makeEvent({
						hook_event: "PostToolUse",
						tool_name: "Write",
						tool_input: { file_path: `/repo/src/${f}`, content: "x" },
					}),
					rules,
					session,
					reservations,
					cohort,
				),
			);
		}
		const cadenceWarnings = after.flatMap(
			(d) => d.warnings?.filter((w) => w.includes("[interlinked:commit-cadence]")) ?? [],
		);
		expect(cadenceWarnings.length).toBe(1);
	});

	it("is a no-op when commit_cadence is disabled", () => {
		rules.commit_cadence = {
			...rules.commit_cadence,
			enabled: false,
			stop_threshold: 5,
			mid_session_threshold: 2,
			token_band_low: 200_000,
			token_band_high: 400_000,
			doc_globs: rules.commit_cadence?.doc_globs ?? [],
		};
		for (const f of ["a.ts", "b.ts", "c.ts", "d.ts"]) postEdit(`/repo/src/${f}`);
		expect(session.non_doc_files_edited_since_commit?.size ?? 0).toBe(0);
		expect(session.mid_session_nudge_emitted).toBe(false);
	});
});
