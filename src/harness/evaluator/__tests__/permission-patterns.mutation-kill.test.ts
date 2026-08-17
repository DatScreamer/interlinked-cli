// Mutation-kill companion for permission-patterns.ts (fleet-r3 pass1_w13).
// Each case targets an OBSERVABLE-behavior gap left open by the current
// `permission-patterns.test.ts` companion — see
// scratch/fleet-r3/receipts/src_harness_evaluator_permission-patterns.ts.jsonl
// for the full per-mutant disposition (this file's mutantIds included).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addPermissionToSettings, extractPermissionPattern } from "../permission-patterns.js";

describe("extractPermissionPattern — mutation-kill gaps", () => {
	// test-contract: security — "git checkout" is DANGEROUS_COMMANDS' own two-word entry, distinct from "git reset"/"git clean"/"git push".
	it("rejects git checkout as its own two-word deny-list entry", () => {
		expect(extractPermissionPattern("Bash", { command: "git checkout main" })).toBeNull();
	});

	// test-contract: invariant — split(/\s+/) must collapse whitespace RUNS; a single-char split inserts an empty token the subcommand-finder wrongly accepts.
	it("finds a multi-subcommand tool's subcommand across multiple internal spaces", () => {
		expect(extractPermissionPattern("Bash", { command: "git  status && echo done" })).toBe(
			"Bash(git status && echo *)",
		);
	});

	// test-contract: invariant — the &&-splitting regex must match "a&&b" with zero whitespace on either side, not only when a space is present.
	it("splits &&-chained commands with zero surrounding whitespace", () => {
		expect(extractPermissionPattern("Bash", { command: "echo&&printf two" })).toBe(
			"Bash(echo && printf *)",
		);
	});

	// test-contract: invariant — a compound command's first segment can carry leading whitespace the &&-regex never strips; per-segment .trim() must remove it before split(/\s+/).
	it("trims a compound command's own leading whitespace before tokenizing", () => {
		expect(extractPermissionPattern("Bash", { command: " npm test && echo done" })).toBe(
			"Bash(npm test && echo *)",
		);
	});
});

describe("addPermissionToSettings — mutation-kill gaps", () => {
	let tmpDir: string;
	// SPY, not process.chdir(): chdir THROWS in a worker thread, and
	// Stryker's vitest runner pins its own pool — see the sibling
	// permission-patterns.test.ts for the full rationale.
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "perm-mk-"));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
	});

	afterEach(() => {
		cwdSpy.mockRestore();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// test-contract: invariant — mkdirSync for a missing settings dir must pass { recursive: true } so a multi-level-missing parent chain still gets created.
	it("creates settings when multiple parent directories are missing", () => {
		const deepCwd = join(tmpDir, "a", "b", "c");
		cwdSpy.mockReturnValue(deepCwd);
		// deepCwd itself (and "a", "a/b") are NOT created on disk.

		expect(addPermissionToSettings("Bash(ls *)")).toBe(true);
		expect(JSON.parse(readFileSync(join(deepCwd, ".claude", "settings.json"), "utf-8"))).toEqual({
			permissions: { allow: ["Bash(ls *)"] },
		});
	});
});
