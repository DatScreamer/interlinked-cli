// Tests for the scratchpad write policy guard: tmp-secrets block +
// authored-code placement (block/warn/off) for the host session scratchpad.
// The triad path shape mirrors filesystem-guards.test.ts.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import {
	buildScratchpadCodeReason,
	evaluateScratchpadWriteGuard,
	scratchpadCodeWriteMode,
} from "./scratchpad-write-guard.js";

const ROOT = "/Users/dev/project";
const SESSION_ID = "e1ef5ba4-0000-4000-8000-000000000001";
const OTHER_SESSION = "ffffffff-1111-4111-8111-000000000002";

const scratchpadPath = (sessionId: string, ...tail: string[]): string =>
	join(tmpdir(), "claude-501", "-Users-dev-project", sessionId, "scratchpad", ...tail);

const makeEvent = (overrides: Partial<HarnessEvent> = {}): HarnessEvent =>
	// SAFETY: the guard only reads the event fields set here; a full
	// HarnessEvent fixture would restate every unrelated optional field.
	({
		hook_event: "PreToolUse",
		session_id: SESSION_ID,
		agent_source: "claude",
		tool_name: "Write",
		tool_input: {},
		timestamp: "2026-07-09T00:00:00Z",
		cwd: ROOT,
		...overrides,
		// SAFETY: guard reads only the fields set above.
	}) as HarnessEvent;

// SAFETY: the guard touches only `scratchpad_guard`; an empty object IS the
// "config absent" production shape the defaults must handle.
const RULES = {} as GuardRulesConfig;
const rulesWithMode = (mode: "block" | "warn" | "off"): GuardRulesConfig =>
	// SAFETY: same single-field access pattern as RULES above.
	({ scratchpad_guard: { code_write_mode: mode } }) as GuardRulesConfig;

const run = (
	filePath: string,
	opts: { content?: string; rules?: GuardRulesConfig; sessionId?: string; tool?: string } = {},
) => {
	const warnings: string[] = [];
	const decision = evaluateScratchpadWriteGuard(
		makeEvent({ session_id: opts.sessionId ?? SESSION_ID }),
		opts.tool ?? "Write",
		{ file_path: filePath, content: opts.content ?? "export {};\n" },
		opts.rules ?? RULES,
		warnings,
	);
	return { decision, warnings };
};

afterEach(() => {
	delete process.env.INTERLINKED_DISABLE_SCRATCH_GUARD;
});

describe("evaluateScratchpadWriteGuard — authored-code placement", () => {
	it("blocks a .ts write into this session's scratchpad by default (redirect to scratch/)", () => {
		const { decision } = run(scratchpadPath(SESSION_ID, "probe.ts"));
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("builtin-scratchpad-code-write");
		expect(decision?.reason).toContain("scratch/");
	});

	it("blocks other code extensions (.mts, .sh) the same way", () => {
		expect(run(scratchpadPath(SESSION_ID, "probe.mts")).decision?.decision).toBe("block");
		expect(run(scratchpadPath(SESSION_ID, "run.sh")).decision?.decision).toBe("block");
	});

	it("warn mode softens to a [interlinked:scratch] steer and allows", () => {
		const { decision, warnings } = run(scratchpadPath(SESSION_ID, "probe.ts"), {
			rules: rulesWithMode("warn"),
		});
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.startsWith("[interlinked:scratch]"))).toBe(true);
	});

	it("mentions `interlinked scratch init` while <repo>/scratch is missing", () => {
		expect(
			buildScratchpadCodeReason({ target: "x.ts", projectRoot: "/nonexistent/repo/root" }),
		).toContain("interlinked scratch init");
	});

	it("defaults to block mode when config is absent", () => {
		expect(scratchpadCodeWriteMode(RULES)).toBe("block");
		expect(scratchpadCodeWriteMode(rulesWithMode("off"))).toBe("off");
	});

	// --- negative cases: legitimate patterns that must NOT fire ---

	it("allows non-code scratchpad writes (downloads / outputs) untouched", () => {
		for (const name of ["results.json", "report.md", "bundle.tgz", "LICENSE"]) {
			const { decision, warnings } = run(scratchpadPath(SESSION_ID, name));
			expect(decision).toBeNull();
			expect(warnings).toHaveLength(0);
		}
	});

	it("ignores code writes inside the repo (not an ephemeral temp path)", () => {
		const { decision, warnings } = run(join(ROOT, "src", "real.ts"));
		expect(decision).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("leaves a DIFFERENT session's scratchpad to the confinement guard", () => {
		expect(run(scratchpadPath(OTHER_SESSION, "x.ts")).decision).toBeNull();
	});

	it("leaves non-scratchpad temp paths to the confinement guard", () => {
		expect(run(join(tmpdir(), "loose-probe.ts")).decision).toBeNull();
	});

	it("mode off disables the placement gate", () => {
		const { decision, warnings } = run(scratchpadPath(SESSION_ID, "probe.ts"), {
			rules: rulesWithMode("off"),
		});
		expect(decision).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("honors the INTERLINKED_DISABLE_SCRATCH_GUARD escape hatch", () => {
		process.env.INTERLINKED_DISABLE_SCRATCH_GUARD = "1";
		expect(run(scratchpadPath(SESSION_ID, "probe.ts")).decision).toBeNull();
	});

	it("ignores non-write tools", () => {
		expect(
			run(scratchpadPath(SESSION_ID, "probe.ts"), { tool: "Read" }).decision,
		).toBeNull();
	});
});

describe("evaluateScratchpadWriteGuard — tmp-secrets scan", () => {
	// AWS's canonical documentation example key — not a live credential. Split
	// so the contiguous key material exists only at test runtime, never in the
	// working tree (session_secret_persistence would rightly flag it).
	const AWS_KEY_LINE = `const key = '${"AKIA" + "IOSFODNN7EXAMPLE"}';\n`;

	it("blocks secret material written to the session scratchpad (any extension)", () => {
		const { decision } = run(scratchpadPath(SESSION_ID, "creds.json"), {
			content: AWS_KEY_LINE,
		});
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("builtin-tmp-secrets");
	});

	it("blocks secret material on non-scratchpad temp paths too", () => {
		const { decision } = run(join(tmpdir(), "staging.txt"), { content: AWS_KEY_LINE });
		expect(decision?.rule_id).toBe("builtin-tmp-secrets");
	});

	it("secrets verdict outranks the placement verdict for code files", () => {
		const { decision } = run(scratchpadPath(SESSION_ID, "leak.ts"), {
			content: AWS_KEY_LINE,
		});
		expect(decision?.rule_id).toBe("builtin-tmp-secrets");
	});

	it("the secrets scan ignores in-repo writes (protected-files globs own those)", () => {
		const { decision } = run(join(ROOT, "src", "config.ts"), { content: AWS_KEY_LINE });
		expect(decision).toBeNull();
	});

	it("the escape hatch does NOT disable the secrets scan", () => {
		process.env.INTERLINKED_DISABLE_SCRATCH_GUARD = "1";
		const { decision } = run(scratchpadPath(SESSION_ID, "creds.env"), {
			content: AWS_KEY_LINE,
		});
		expect(decision?.rule_id).toBe("builtin-tmp-secrets");
	});
});
