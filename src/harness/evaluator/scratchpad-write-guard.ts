// ===========================================
// Scratchpad write policy (PreToolUse)
// ===========================================
// Two policies for file-writes aimed at ephemeral temp paths, run BEFORE the
// repo-confinement guard whose session-scratchpad carve-out would otherwise
// allow them without inspection:
//
//   1. tmp-secrets — a write carrying secret material to ANY ephemeral temp
//      path is blocked unconditionally. Temp paths sit outside the repo's
//      protected-file globs, which made them the one unscanned staging
//      surface for credential exfil.
//   2. authored-code placement — an agent-authored CODE-extension file aimed
//      at the session scratchpad is redirected to <repo>/scratch/ (block by
//      default; `scratchpad_guard.code_write_mode` softens to "warn"/"off").
//      A script that shapes decisions deserves the same gates as the code it
//      touches, and future sessions should be able to find it; the scratchpad
//      stays the right place for downloads, package extractions, and other
//      non-code bulk that would poison the repo's search index. Operator
//      decision 2026-07-09 — extends the 2026-07-07 bash-only warn steer.
//
// Escape hatch (placement only — never the secrets scan):
// INTERLINKED_DISABLE_SCRATCH_GUARD=1.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CODE_FILE_EXT_RE } from "../pre-checks-bash-write-detect.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import {
	isEphemeralTempPath,
	resolveWriteTargetPath,
	sessionScratchpadAllows,
} from "./filesystem-guards.js";
import { containsSecrets } from "./pre-tool-helpers.js";
import { isFileWrite } from "./tool-classifiers.js";

type ToolInput = NonNullable<HarnessEvent["tool_input"]>;

export type ScratchpadCodeWriteMode = "block" | "warn" | "off";

const DEFAULT_CODE_WRITE_MODE: ScratchpadCodeWriteMode = "block";

/** Resolved placement mode (config with block default). */
export function scratchpadCodeWriteMode(rules: GuardRulesConfig): ScratchpadCodeWriteMode {
	return rules.scratchpad_guard?.code_write_mode ?? DEFAULT_CODE_WRITE_MODE;
}

/** One-command escape hatch, mirroring INTERLINKED_DISABLE_PACKAGE_GUARD /
 *  INTERLINKED_DISABLE_BASELINE_GUARD (read inline like the baseline gate —
 *  the established convention for these per-command bypasses). Placement
 *  gate only. Public API: consumed by pre-tool-rules.ts for the Bash path. */
export function isScratchGuardDisabled(): boolean {
	return process.env.INTERLINKED_DISABLE_SCRATCH_GUARD === "1";
}

/** `interlinked scratch init` hint, shown only while <repo>/scratch/ is
 *  missing — the redirect is only credible if the destination exists. */
function scratchInitHint(projectRoot: string): string {
	return existsSync(join(projectRoot, "scratch"))
		? ""
		: " Run `interlinked scratch init` once to provision scratch/.";
}

/** Block reason for an authored code file aimed at the session scratchpad. */
export function buildScratchpadCodeReason(opts: {
	target: string;
	projectRoot: string;
}): string {
	return (
		`BLOCKED: ${opts.target} is an agent-authored code file aimed at the ephemeral session ` +
		`scratchpad — it would be ungated, invisible to search, and purged by the OS. Put ` +
		`session/agent scripts in <repo>/scratch/ instead: gitignored but quality-gated, ` +
		`rg-searchable, and durable (see scratch/README.md).${scratchInitHint(opts.projectRoot)} ` +
		`The scratchpad remains the right place for downloads, package extractions, and ` +
		`non-code bulk. Config: scratchpad_guard.code_write_mode; one-command bypass: ` +
		`INTERLINKED_DISABLE_SCRATCH_GUARD=1.`
	);
}

/** Warn-mode steer for the same shape. Public API: also the message the
 *  Bash-redirect steer in pre-tool-rules.ts emits, so both surfaces speak
 *  with one voice. */
export function buildScratchpadSteerWarning(opts: {
	target: string;
	projectRoot: string;
}): string {
	return (
		`[interlinked:scratch] ${opts.target} is an agent-authored code file in the ephemeral ` +
		`session scratchpad. Session/agent scripts belong in <repo>/scratch/ — gitignored ` +
		`but quality-gated and rg-searchable (see scratch/README.md).${scratchInitHint(opts.projectRoot)}`
	);
}

/** GUARD: scratchpad/temp write policy — tmp-secrets block + authored-code
 *  placement. Consumed by evaluator/pre-tool.ts immediately BEFORE the
 *  repo-confinement phase (whose carve-out would otherwise allow these).
 *  Signature matches the sibling guards in pre-tool-guards.ts. */
export function evaluateScratchpadWriteGuard(
	event: HarnessEvent,
	toolName: string,
	toolInput: ToolInput,
	rules: GuardRulesConfig,
	warnings: string[],
): HarnessDecision | null {
	if (!isFileWrite(toolName) || !event.cwd) return null;
	// SAFETY: hook payloads type tool_input values as unknown; file_path/path
	// are strings when present (same extraction as pre-tool-guards.ts).
	const rawPath = (toolInput.file_path as string) || (toolInput.path as string) || "";
	if (!rawPath) return null;
	const resolved = resolveWriteTargetPath(rawPath, event.cwd);
	if (!isEphemeralTempPath(resolved)) return null;

	// SAFETY: content/new_string are strings when present (hook payload shape).
	const content = (toolInput.content as string) || (toolInput.new_string as string) || "";
	if (content && containsSecrets(content)) {
		return {
			decision: "block",
			reason:
				`BLOCKED: Secrets detected in a write to an ephemeral temp path (${rawPath}). ` +
				`Temp/scratchpad files sit outside the repo's protected-file globs but are a ` +
				`classic exfil-staging surface — keep credentials out of temp files entirely.`,
			warnings,
			rule_id: "builtin-tmp-secrets",
			severity: "critical",
			category: "Security",
		};
	}

	return evaluateCodePlacement({
		sessionId: event.session_id,
		projectRoot: event.cwd,
		rawPath,
		resolved,
		rules,
		warnings,
	});
}

/** Placement decision for the session scratchpad specifically. Non-scratchpad
 *  temp paths fall through — repo confinement already owns those. */
function evaluateCodePlacement(opts: {
	sessionId: string | undefined;
	projectRoot: string;
	rawPath: string;
	resolved: string;
	rules: GuardRulesConfig;
	warnings: string[];
}): HarnessDecision | null {
	if (!sessionScratchpadAllows(opts.resolved, opts.sessionId)) return null;
	if (!CODE_FILE_EXT_RE.test(opts.resolved)) return null;
	const mode = scratchpadCodeWriteMode(opts.rules);
	if (mode === "off" || isScratchGuardDisabled()) return null;
	if (mode === "warn") {
		opts.warnings.push(
			buildScratchpadSteerWarning({ target: opts.rawPath, projectRoot: opts.projectRoot }),
		);
		return null;
	}
	return {
		decision: "block",
		reason: buildScratchpadCodeReason({
			target: opts.rawPath,
			projectRoot: opts.projectRoot,
		}),
		warnings: opts.warnings,
		rule_id: "builtin-scratchpad-code-write",
		severity: "medium",
		category: "harness-integrity",
	};
}
