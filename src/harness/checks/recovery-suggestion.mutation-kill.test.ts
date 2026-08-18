// Phase 1 Channel 3 — mutation-kill companion for recovery-suggestion.ts.
// Targets the surviving mutants recorded in .interlinked/mutation-manifest.json
// (55 survived + 1 uncovered, all in this file, as of the pass1_w22 sweep).
// Existing coverage lives in recovery-suggestion.test.ts and
// __tests__/recovery-suggestion.test.ts; this file adds only the assertions
// needed to kill the specific survivors — see
// scratch/fleet-r3/receipts/src_harness_checks_recovery-suggestion.ts.jsonl for
// the full mutant-by-mutant disposition, including the suspected-equivalent set
// documented below.
//
// Equivalent-mutant notes (not tested here — see receipt for the argument):
//   - buildContext(): `ctx.file`/`ctx.tool`/`ctx.error` are written but never read
//     by any template (only `ctx.symbol`/`ctx.module` are — confirmed by grepping
//     `ctx\.` across this file) and buildContext is not exported, so nothing that
//     touches only those fields (the file_path ternary, the `typeof value` guard,
//     the `{}` object-literal mutant, the errorText fallback content) can change
//     suggestRecovery's return value.
//   - suggestRecovery(): `if (suggestion)` -> `if (true)` — when suggestion is
//     undefined, forcing entry throws on `undefined.template` inside the same
//     try/catch, which falls through to the identical FALLBACK_BY_LABEL path.
//   - missing-symbol's extract regex: the mutated trailing class sits after the
//     named group and is itself optional, so it can never change what the group
//     captures or whether the overall match succeeds.

import { describe, expect, it } from "vitest";
import type { ToolFailureEvent, TriageLabel, TriageResult } from "../types.js";
import { suggestRecovery } from "./recovery-suggestion.js";

function makeEvent(over: Partial<ToolFailureEvent> = {}): ToolFailureEvent {
	const base: ToolFailureEvent = {
		session_id: "mk1",
		agent_source: "claude",
		tool_name: "Bash",
		timestamp: "2026-08-18T00:00:00Z",
	};
	return { ...base, ...over };
}

function makeTriage(label: TriageLabel, category: string): TriageResult {
	return { label, category, confidence: 0.9, source: "local-heuristic" };
}

// No error_message/stderr => errorText === "" => every `extract` call is skipped
// (errorText is falsy) => ctx.symbol/ctx.module stay at their `?? "<...>"`
// placeholder defaults. Isolates these assertions from extract/regex behavior.
const bare = makeEvent();

describe("suggestRecovery — full-string kills (zero-arg templates)", () => {
	// test-contract: public-api — agent-error/type-mismatch template's 3 segments (125bbbcd85416c00, 962fa59e11c538f8, 588fb9d8a8c52959) must all survive intact in the toBe below
	it("agent-error/type-mismatch — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "type-mismatch"));
		expect(out).toBe(
			"The argument type doesn't match the parameter type. Read the function signature at the call site. If the type is correct but inference is wrong, add an explicit type assertion (`fn(value as ExpectedType)`) — but only as a last resort; prefer fixing the source type.",
		);
	});

	// test-contract: public-api — agent-error/missing-property template's 1 segment (7c7468e3165a9756) must survive intact in the toBe below
	it("agent-error/missing-property — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "missing-property"));
		expect(out).toBe(
			"The property doesn't exist on the type. Check the struct/interface definition. If you're trying to add a new field, update the type first.",
		);
	});

	// test-contract: public-api — agent-error/unused-declaration template's 1 segment (b0ea060b2443b81f) must survive intact in the toBe below
	it("agent-error/unused-declaration — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "unused-declaration"));
		expect(out).toBe(
			"Declared but never used — either remove the declaration or actually use it. If it's an interface for an external API, prefix it with `_` to opt out.",
		);
	});

	// test-contract: public-api — agent-error/type-error template's 1 segment (c6539417820d7ea4) must survive intact in the toBe below
	it("agent-error/type-error — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "type-error"));
		expect(out).toBe(
			"The TypeScript compiler rejected this. Read the full `tsc` output for the line/column and fix the type — don't `@ts-ignore` it.",
		);
	});

	// test-contract: public-api — agent-error/git-conflict template's 2 segments (866a1e9d630a609e, 1f699fda24bb2585) must all survive intact in the toBe below
	it("agent-error/git-conflict — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "git-conflict"));
		expect(out).toBe(
			"Merge conflict in the working tree. Open the conflicted files, resolve the `<<<<<<<`/`=======`/`>>>>>>>` markers, `git add` the resolved files, then continue (`git commit` for a merge, `git rebase --continue` for a rebase).",
		);
	});

	// test-contract: public-api — agent-error/pre-commit template's 2 segments (dc1e1ced14aa0ff9, 2de90a6bbc65ac35) must all survive intact in the toBe below
	it("agent-error/pre-commit — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "pre-commit"));
		expect(out).toBe(
			"A pre-commit hook failed. Read the hook output, fix the underlying issue (formatting, lint, type-check), then re-stage and re-commit. Do NOT use `--no-verify`.",
		);
	});

	// test-contract: public-api — agent-error/test-failure template's 2 segments (e20669a23323942f, 06bacec18d602789) must all survive intact in the toBe below
	it("agent-error/test-failure — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "test-failure"));
		expect(out).toBe(
			"Tests are failing. Read the failing assertion, isolate which test in the output, and run that single test in watch mode (`vitest watch <file>` / `jest --watch`). Fix the implementation or the test, not both at once.",
		);
	});

	// test-contract: public-api — agent-error/assertion template's 2 segments (566444812c6de950, ff33973b20d7037e) must all survive intact in the toBe below
	it("agent-error/assertion — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "assertion"));
		expect(out).toBe(
			"Assertion failed. The diff between expected and actual is your fix target — don't change the assertion to match the implementation; understand why the implementation produced the wrong value.",
		);
	});

	// test-contract: public-api — agent-error/auth template's 2 segments (e99a117f69b1d8a3, 2bde7d98e71a1e24) must all survive intact in the toBe below
	it("agent-error/auth — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "auth"));
		expect(out).toBe(
			"Authentication failed. Verify the API key / token is set in env (`echo $TOKEN_NAME`) and not stale. Don't paste credentials into source files — the harness will block that.",
		);
	});

	// test-contract: public-api — agent-error/dns-resolution template's 1 segment (8ad063e9edd28fbf) must survive intact in the toBe below
	it("agent-error/dns-resolution — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "dns-resolution"));
		expect(out).toBe(
			"DNS lookup failed for the host. Check the URL for typos. If the host is internal-only, you may be on the wrong network.",
		);
	});

	// test-contract: public-api — agent-error/package-script template's 2 segments (3c886b1c915eb9c8, 291f450b646a8983) must all survive intact in the toBe below
	it("agent-error/package-script — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "package-script"));
		expect(out).toBe(
			"A package script (`npm run <name>`) failed. Read the script's actual error output above the `npm ERR!` lines — npm just relays it. Fix the underlying script, not the npm wrapper.",
		);
	});

	// test-contract: public-api — agent-error/filesystem-shape template's 1 segment (1817becd076837c7) must survive intact in the toBe below
	it("agent-error/filesystem-shape — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "filesystem-shape"));
		expect(out).toBe(
			"Filesystem state mismatch (file vs directory, exists vs missing). Verify with `ls` before retrying — your assumption about the path shape is wrong.",
		);
	});

	// test-contract: public-api — environmental/filesystem-missing template's 1 segment (6cbb01a393c5f687) must survive intact in the toBe below
	it("environmental/filesystem-missing — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("environmental", "filesystem-missing"));
		expect(out).toBe(
			"File or directory doesn't exist at this path. Verify the path is correct (`ls` the parent), or create the parent first if you intended to write a new file.",
		);
	});

	// test-contract: public-api — environmental/filesystem-permission template's 2 segments (e0c1527078130328, 7b8eb011d01fc365) must all survive intact in the toBe below
	it("environmental/filesystem-permission — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("environmental", "filesystem-permission"));
		expect(out).toBe(
			"Permission denied. The harness usually blocks writes to protected paths — check whether the path is one we shouldn't write to (CI config, secrets, /etc, etc.). If it's legitimate, ask the user to fix the permissions.",
		);
	});

	// test-contract: public-api — environmental/git-state template's 1 segment (6462dc4ba4a5a8f0) must survive intact in the toBe below
	it("environmental/git-state — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("environmental", "git-state"));
		expect(out).toBe(
			"Not a git repository. `cd` to the project root, or run `git init` if this is a fresh project.",
		);
	});

	// test-contract: public-api — environmental/out-of-memory template's 1 segment (0bb12321464fc68c) must survive intact in the toBe below
	it("environmental/out-of-memory — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("environmental", "out-of-memory"));
		expect(out).toBe(
			"The process ran out of heap. If this is Node, raise `--max-old-space-size`. If it's a build, try a smaller scope (single package / single test file).",
		);
	});

	// test-contract: public-api — transient/network-refused template's 2 segments (b51e6368bafc7e20, debdb1d65cfd1190) must all survive intact in the toBe below
	it("transient/network-refused — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("transient", "network-refused"));
		expect(out).toBe(
			"Connection refused. The target service isn't accepting connections — it may be down or you may be hitting the wrong port. Don't retry blindly; verify the target is up first (`curl <host>:<port>` from a known-good shell).",
		);
	});

	// test-contract: public-api — transient/network-timeout template's 1 segment (001bc0ab8c9e2d02) must survive intact in the toBe below
	it("transient/network-timeout — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("transient", "network-timeout"));
		expect(out).toBe(
			"Connection timed out. Retry once. If it times out again, the target is unreachable — escalate rather than spinning.",
		);
	});

	// test-contract: public-api — transient/dns template's 1 segment (370c611d799ce389) must survive intact in the toBe below
	it("transient/dns — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("transient", "dns"));
		expect(out).toBe(
			"DNS resolution flapped (EAI_AGAIN). Retry once after a short pause; this is almost always transient.",
		);
	});

	// test-contract: public-api — transient/rate-limit template's 1 segment (153818cd4b8447c8) must survive intact in the toBe below
	it("transient/rate-limit — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("transient", "rate-limit"));
		expect(out).toBe(
			"Rate-limited. Wait at least 30s before retrying, or use a different provider/key. Repeated retries make this worse.",
		);
	});

	// test-contract: public-api — transient/user-interrupt template's 1 segment (6c39f44113d686e7) must survive intact in the toBe below
	it("transient/user-interrupt — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("transient", "user-interrupt"));
		expect(out).toBe(
			"The user interrupted the call. Don't retry automatically — wait for the user's next instruction.",
		);
	});

	// test-contract: public-api — unrecoverable/process-crash template's 1 segment (3eda5c53dd4ce62c) must survive intact in the toBe below
	it("unrecoverable/process-crash — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("unrecoverable", "process-crash"));
		expect(out).toBe(
			"A process crashed (segfault). Don't retry — this isn't a fix you can make from this side. Escalate with the stack trace if available.",
		);
	});

	// test-contract: public-api — unrecoverable/process-killed template's 1 segment (321fa8327f1f4a4f) must survive intact in the toBe below
	it("unrecoverable/process-killed — exact template text", () => {
		const out = suggestRecovery(bare, makeTriage("unrecoverable", "process-killed"));
		expect(out).toBe(
			"Process was killed (SIGKILL). Likely OOM or external signal. Don't retry without changing the input — same input will produce the same kill.",
		);
	});
});

describe("suggestRecovery — full-string kills (ctx-interpolated templates, default placeholders)", () => {
	// test-contract: public-api — agent-error/missing-import's segment (60fba622802b8ab0) must survive with symbol/module left at their placeholder default
	it("agent-error/missing-import — exact template text (placeholder ctx)", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "missing-import"));
		expect(out).toBe(
			"Add the missing import: `import { <symbol> } from \"<module>\";`. If the package isn't installed locally, check `npm ls <module>` (or the equivalent for the project's package manager).",
		);
	});

	// test-contract: public-api — agent-error/missing-symbol's segments (dd3bd43329cdb19c, 40e56dbceda774f8) must survive with symbol/module left at their placeholder default
	it("agent-error/missing-symbol — exact template text (placeholder ctx)", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "missing-symbol"));
		expect(out).toBe(
			"The symbol `<symbol>` isn't in scope. Either it's missing an import, it was renamed, or it's typo'd. Search the project for the canonical name before guessing.",
		);
	});

	// test-contract: public-api — agent-error/missing-package's segments (ae1d85bdd01709aa, 186b93025d37a99f) must survive with symbol/module left at their placeholder default
	it("agent-error/missing-package — exact template text (placeholder ctx)", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "missing-package"));
		expect(out).toBe(
			"The package `<package>` isn't published or the name is wrong. Check `npm view <package>` for canonical naming. Don't blindly run `npm install <wrong-name>` — pick the right package first.",
		);
	});
});

describe("suggestRecovery — full-string kills (FALLBACK_BY_LABEL)", () => {
	// test-contract: public-api — agent-error fallback segment (9c39916d374c572a) must survive when the category key is unrecognized
	it("agent-error fallback — exact text for an unrecognized category", () => {
		const out = suggestRecovery(bare, makeTriage("agent-error", "mutation-kill-unseen-category"));
		expect(out).toBe(
			"This looks like an agent-side mistake. Re-read the error message carefully, don't guess — the diagnostic usually names the exact symbol/path/type that's wrong.",
		);
	});

	// test-contract: public-api — environmental fallback segment (e5a30a6d5d6aec23) must survive when the category key is unrecognized
	it("environmental fallback — exact text for an unrecognized category", () => {
		const out = suggestRecovery(bare, makeTriage("environmental", "mutation-kill-unseen-category"));
		expect(out).toBe(
			"This looks like an environment problem (filesystem, OS, project state). Don't try to work around it in code — fix the environment or surface the gap to the user.",
		);
	});

	// test-contract: public-api — transient fallback segment (fce6b532d5c4a22c) must survive when the category key is unrecognized
	it("transient fallback — exact text for an unrecognized category", () => {
		const out = suggestRecovery(bare, makeTriage("transient", "mutation-kill-unseen-category"));
		expect(out).toBe(
			"This looks transient. Retry once. If it fails the same way again, treat it as non-transient and escalate.",
		);
	});

	// test-contract: public-api — unrecoverable fallback segment (5a4d4ddadb6afaec) must survive when the category key is unrecognized
	it("unrecoverable fallback — exact text for an unrecognized category", () => {
		const out = suggestRecovery(bare, makeTriage("unrecoverable", "mutation-kill-unseen-category"));
		expect(out).toBe(
			"This looks unrecoverable from the agent side. Stop retrying; surface the failure to the user with the diagnostic.",
		);
	});
});
