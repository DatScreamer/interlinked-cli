import { describe, expect, it } from "vitest";
import { commitReferencesPath } from "./helpers-commands.js";

// commitReferencesPath decides whether a `git add`/`commit` would include a file
// a secret was just written to — the second leg of the `secEnvAddThenGitCommit`
// BLOCK rule. It must be near-zero-FP (blocking is the strongest verdict), so it
// matches staged PATHS, not substrings of the command text.
describe("commitReferencesPath — anchored, message-aware staging match", () => {
	// --- False positives the old `cmd.includes(...)` substring match produced.
	it("does NOT fire when the secret file is only named in a -m commit message", () => {
		// `-m` without `-a` stages nothing; the filename here is prose, not a path.
		expect(commitReferencesPath('git commit -m "fix config.json parsing"', "config.json")).toBe(false);
	});

	it("does NOT fire on a different file whose name merely CONTAINS the path", () => {
		// `.env` is a substring of `.env.example`, but they are different files.
		expect(commitReferencesPath("git add .env.example", ".env")).toBe(false);
	});

	it("does NOT fire on a non-add/commit git verb that names the file", () => {
		expect(commitReferencesPath("git status .env", ".env")).toBe(false);
		expect(commitReferencesPath("git diff .env", ".env")).toBe(false);
	});

	// --- True positives that must still fire.
	it("fires when the exact path is staged by name", () => {
		expect(commitReferencesPath("git add .env", ".env")).toBe(true);
	});

	it("fires on a staged path in a subdirectory (basename match)", () => {
		expect(commitReferencesPath("git add src/.env", ".env")).toBe(true);
	});

	it("fires when add and commit are chained in one command", () => {
		expect(commitReferencesPath('git add .env && git commit -m "wip"', ".env")).toBe(true);
	});

	it("fires on `git commit -am` (stages all tracked modifications)", () => {
		expect(commitReferencesPath('git commit -am "wip"', ".env")).toBe(true);
	});

	it("fires on `git add .` / `-A` / `--all` (stages the worktree)", () => {
		expect(commitReferencesPath("git add .", ".env")).toBe(true);
		expect(commitReferencesPath("git add -A", ".env")).toBe(true);
		expect(commitReferencesPath("git add --all", ".env")).toBe(true);
	});
});
