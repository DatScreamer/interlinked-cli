import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectWipCommitSubjects,
	DEFAULT_DOC_GLOBS,
	formatMidSessionBackstop,
	formatStopNudge,
	formatWipCommitsNudge,
	isDocFile,
	isWipCommitSubject,
	readSessionTokens,
} from "./commit-cadence.js";

describe("isDocFile", () => {
	it("treats markdown / mdx / txt / rst as docs", () => {
		expect(isDocFile("README.md")).toBe(true);
		expect(isDocFile("docs/intro.mdx")).toBe(true);
		expect(isDocFile("notes.txt")).toBe(true);
		expect(isDocFile("CHANGELOG.rst")).toBe(true);
	});

	it("treats files under docs/ plans/ notes/ as docs even when not .md", () => {
		expect(isDocFile("docs/architecture.svg")).toBe(true);
		expect(isDocFile("plans/q3-roadmap.yaml")).toBe(true);
		expect(isDocFile("notes/scratch.json")).toBe(true);
	});

	it("treats CLAUDE.md / AGENTS.md / PLAN*.md as docs anywhere in the tree", () => {
		expect(isDocFile("CLAUDE.md")).toBe(true);
		expect(isDocFile("subdir/AGENTS.md")).toBe(true);
		expect(isDocFile("PLAN-2026.md")).toBe(true);
	});

	it("treats source code as non-doc", () => {
		expect(isDocFile("src/index.ts")).toBe(false);
		expect(isDocFile("packages/cli/foo.tsx")).toBe(false);
		expect(isDocFile("server.py")).toBe(false);
		expect(isDocFile("Cargo.toml")).toBe(false);
	});

	it("respects custom doc globs override", () => {
		expect(isDocFile("rfc/proposal.adoc", ["rfc/**", "**/*.adoc"])).toBe(true);
		expect(isDocFile("src/index.ts", ["rfc/**"])).toBe(false);
	});

	it("DEFAULT_DOC_GLOBS contains markdown and the common doc dirs", () => {
		expect(DEFAULT_DOC_GLOBS).toContain("**/*.md");
		expect(DEFAULT_DOC_GLOBS).toContain("docs/**");
		expect(DEFAULT_DOC_GLOBS).toContain("plans/**");
	});
});

describe("readSessionTokens", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "commit-cadence-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns null when transcriptPath is missing or unreadable", () => {
		expect(readSessionTokens(undefined)).toBeNull();
		expect(readSessionTokens(join(tmp, "does-not-exist.jsonl"))).toBeNull();
	});

	it("sums input + output tokens across assistant messages", () => {
		const path = join(tmp, "transcript.jsonl");
		const lines = [
			JSON.stringify({ type: "user", message: { content: "hi" } }),
			JSON.stringify({
				type: "assistant",
				message: { usage: { input_tokens: 1000, output_tokens: 500 } },
			}),
			JSON.stringify({
				type: "assistant",
				message: { usage: { input_tokens: 2000, output_tokens: 750 } },
			}),
		].join("\n");
		writeFileSync(path, `${lines}\n`);
		const tokens = readSessionTokens(path);
		expect(tokens).not.toBeNull();
		expect(tokens!.input).toBe(3000);
		expect(tokens!.output).toBe(1250);
		expect(tokens!.total).toBe(4250);
	});

	it("ignores non-assistant rows and rows missing usage", () => {
		const path = join(tmp, "mixed.jsonl");
		const lines = [
			JSON.stringify({ type: "user", message: { content: "hi" } }),
			JSON.stringify({ type: "assistant", message: {} }),
			JSON.stringify({
				type: "assistant",
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
			}),
		].join("\n");
		writeFileSync(path, `${lines}\n`);
		const tokens = readSessionTokens(path);
		expect(tokens!.total).toBe(150);
	});

	it("tolerates malformed JSONL lines without throwing", () => {
		const path = join(tmp, "broken.jsonl");
		const lines = [
			"not valid json",
			JSON.stringify({
				type: "assistant",
				message: { usage: { input_tokens: 10, output_tokens: 5 } },
			}),
			"another bad line",
		].join("\n");
		writeFileSync(path, `${lines}\n`);
		const tokens = readSessionTokens(path);
		expect(tokens!.total).toBe(15);
	});
});

describe("formatStopNudge", () => {
	const baseOpts = {
		threshold: 5,
		tokenBandLow: 200_000,
		tokenBandHigh: 400_000,
	};

	it("returns null when below threshold", () => {
		expect(
			formatStopNudge({
				...baseOpts,
				uncommittedNonDocCount: 3,
				docFilesExcluded: 1,
			}),
		).toBeNull();
	});

	it("returns a base message at the file-count threshold", () => {
		const msg = formatStopNudge({
			...baseOpts,
			uncommittedNonDocCount: 6,
			docFilesExcluded: 2,
		});
		expect(msg).not.toBeNull();
		expect(msg!).toContain("6 uncommitted code-file edit");
		expect(msg!).toContain("2 doc/plan");
		expect(msg!).toContain("Don't push");
	});

	it("escalates wording above the low token band", () => {
		const msg = formatStopNudge({
			...baseOpts,
			uncommittedNonDocCount: 6,
			docFilesExcluded: 0,
			cumulativeTokens: 250_000,
		});
		expect(msg!).toContain("long session");
		expect(msg!).toMatch(/250k tokens/);
	});

	it("escalates further above the high token band", () => {
		const msg = formatStopNudge({
			...baseOpts,
			uncommittedNonDocCount: 6,
			docFilesExcluded: 0,
			cumulativeTokens: 450_000,
		});
		expect(msg!).toContain("very long session");
		expect(msg!).toContain("context window is degrading");
	});

	it("does not mention tokens when the count is unknown", () => {
		const msg = formatStopNudge({
			...baseOpts,
			uncommittedNonDocCount: 6,
			docFilesExcluded: 0,
		});
		expect(msg!).not.toMatch(/tokens/);
	});
});

describe("formatMidSessionBackstop", () => {
	it("returns null below threshold", () => {
		expect(
			formatMidSessionBackstop({ uncommittedNonDocCount: 39, threshold: 40 }),
		).toBeNull();
	});

	it("returns a mid-session warning at threshold crossing", () => {
		const msg = formatMidSessionBackstop({
			uncommittedNonDocCount: 41,
			threshold: 40,
		});
		expect(msg!).toContain("41 distinct code file");
		expect(msg!).toContain("Commit incrementally");
		expect(msg!).toContain("Don't push");
	});
});

// ---------------------------------------------------------------------------
// WIP-commit cleanup nudge (Stop backlog 3B)
// ---------------------------------------------------------------------------

describe("isWipCommitSubject", () => {
	it("fires on subjects starting with wip / fixup / tmp (case-insensitive)", () => {
		expect(isWipCommitSubject("wip")).toBe(true);
		expect(isWipCommitSubject("WIP: half-done parser")).toBe(true);
		expect(isWipCommitSubject("fixup lint errors")).toBe(true);
		expect(isWipCommitSubject("tmp checkpoint before rebase")).toBe(true);
	});

	it("fires on temp / squash prefixes and tolerates leading whitespace", () => {
		expect(isWipCommitSubject("temp: stash of debug state")).toBe(true);
		expect(isWipCommitSubject("  squash me into previous")).toBe(true);
	});

	it("does NOT fire when the marker word appears mid-subject", () => {
		expect(isWipCommitSubject("fix wip detection in commit-cadence")).toBe(false);
		expect(isWipCommitSubject("remove tmp files from dist")).toBe(false);
	});

	it("does NOT fire on ordinary conventional-commit subjects", () => {
		expect(isWipCommitSubject("feat(harness): add wip-commit stop nudge")).toBe(false);
		expect(isWipCommitSubject("fix: handle empty baseline sha")).toBe(false);
	});

	it("does NOT fire on words that merely start with a marker (wipe, template)", () => {
		// \b after the marker: `wipe`/`template` are not `wip`/`temp`.
		expect(isWipCommitSubject("wipe stale cache entries on boot")).toBe(false);
		expect(isWipCommitSubject("template the sponsor row renderer")).toBe(false);
	});

	it("excludes deliberate autosquash fixup!/squash! markers (the known-FP case)", () => {
		expect(isWipCommitSubject("fixup! feat: add parser")).toBe(false);
		expect(isWipCommitSubject("squash! fix: rounding")).toBe(false);
	});
});

describe("collectWipCommitSubjects", () => {
	let repo: string;

	function git(...args: string[]): string {
		return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
	}

	function commit(subject: string): void {
		writeFileSync(join(repo, "a.txt"), `${subject}\n`);
		git("add", "a.txt");
		git("commit", "-q", "-m", subject);
	}

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "wip-commits-"));
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		commit("feat: baseline commit");
	});
	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("returns only WIP-style subjects committed after the baseline sha", () => {
		const baseline = git("rev-parse", "HEAD");
		commit("wip: half-done thing");
		commit("feat: a real commit");
		commit("tmp checkpoint");
		// git log is newest-first.
		expect(collectWipCommitSubjects(repo, baseline)).toEqual([
			"tmp checkpoint",
			"wip: half-done thing",
		]);
	});

	it("returns [] when the session made no commits (empty range)", () => {
		const baseline = git("rev-parse", "HEAD");
		expect(collectWipCommitSubjects(repo, baseline)).toEqual([]);
	});

	it("does not count pre-baseline WIP commits", () => {
		commit("wip: pre-session scratch");
		const baseline = git("rev-parse", "HEAD");
		commit("feat: session work");
		expect(collectWipCommitSubjects(repo, baseline)).toEqual([]);
	});

	it("returns [] for an empty baseline sha without shelling out", () => {
		expect(collectWipCommitSubjects(repo, "")).toEqual([]);
	});

	it("returns [] (never throws) when git fails — unknown sha / not a repo", () => {
		expect(
			collectWipCommitSubjects(repo, "0000000000000000000000000000000000000000"),
		).toEqual([]);
		expect(collectWipCommitSubjects(tmpdir(), "abc123")).toEqual([]);
	});
});

describe("formatWipCommitsNudge", () => {
	it("returns null when there are no WIP subjects", () => {
		expect(formatWipCommitsNudge({ wipSubjects: [] })).toBeNull();
	});

	it("emits a one-line nudge listing the subjects, rebase hint, and no-push stance", () => {
		const msg = formatWipCommitsNudge({ wipSubjects: ["wip: parser", "tmp checkpoint"] });
		expect(msg!).toContain("[interlinked:commit-cadence]");
		expect(msg!).toContain("2 WIP-style commit(s)");
		expect(msg!).toContain('"wip: parser"');
		expect(msg!).toContain("git rebase -i");
		expect(msg!).toContain("Don't push");
		expect(msg!).not.toContain("\n");
	});

	it("truncates the subject list past maxShown with an ellipsis", () => {
		const msg = formatWipCommitsNudge({
			wipSubjects: ["wip 1", "wip 2", "wip 3", "wip 4"],
		});
		expect(msg!).toContain("4 WIP-style commit(s)");
		expect(msg!).toContain('"wip 3"');
		expect(msg!).not.toContain('"wip 4"');
		expect(msg!).toContain(", ...");
	});
});
