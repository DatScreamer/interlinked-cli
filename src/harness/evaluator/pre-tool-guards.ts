// ===========================================
// PreToolUse — short-circuit guard phases
// ===========================================
//
// Extracted verbatim from `evaluatePreToolUse` (pre-tool.ts) to keep the
// orchestrator under the per-file line cap. Each helper inspects the event and
// returns a `HarnessDecision` to short-circuit (the orchestrator returns it
// immediately) or `null` to continue. The shared `warnings` array is passed by
// reference where the original embedded it; control-flow order is unchanged.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { findClosestSpans, formatNearMisses } from "../edit-diagnostics.js";
import { loadAllowlist } from "../package-allowlist.js";
import { parseInstallCommands } from "../package-install-parser.js";
import { checkSupermodelShardWrite } from "../supermodel-shard-write-guard.js";
import type {
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import { evaluateBaselineIntegrityForEvent } from "./baseline-integrity-gate.js";
import { evaluateConfigLooseningForEvent } from "./config-loosening-gate.js";
import { evaluateProtectedFiles, evaluateRepoConfinement } from "./filesystem-guards.js";
import { evaluateGitScopeGateSync } from "./git-session-scope-gate.js";
import { isInspectionWrapperCall } from "./inspection-wrapper.js";
import { evaluateManifestEdit } from "./manifest-edit-guard.js";
import { evaluatePackageInstall } from "./package-install-guard.js";
import { computeFullNewContent, containsSecrets } from "./pre-tool-helpers.js";
import { evaluateTddNewFileGateForEvent } from "./tdd-new-file-gate.js";
import { isBash, isFileOperation, isFileWrite } from "./tool-classifiers.js";

/** The harness event's tool-input bag, normalized to a non-undefined object. */
type ToolInput = NonNullable<HarnessEvent["tool_input"]>;

/**
 * Meta-test wrapper short-circuit: `interlinked harness test "..."` is the
 * CLI's own command for evaluating a synthetic tool call against the rule
 * set. Re-evaluating the outer wrapper would double-fire — the inner
 * quoted-string content matches rule regexes literally, surfacing warnings
 * on the wrapper that belong to the inner event the wrapper will dispatch
 * over the socket. Returning allow here skips the wrapper; the inner
 * synthetic event still runs through the full pipeline normally.
 */
export function evaluateMetaTestWrapper(
	toolName: string,
	toolInput: ToolInput,
): HarnessDecision | null {
	if (toolName === "Bash" || toolName === "Shell" || toolName === "run_command") {
		const command = typeof toolInput.command === "string" ? toolInput.command : "";
		if (isInspectionWrapperCall(command)) {
			return { decision: "allow" };
		}
	}
	return null;
}

/**
 * GUARD: Supermodel `.graph.*` shard write protection — apply_patch layer.
 * `builtin-supermodel-graph-write-blocked` covers tools that surface the
 * path under `tool_input.file_path`, but `apply_patch` embeds destinations
 * in the patch body. Run before the main rule loop so the block reason is
 * consistent regardless of which path the agent took to reach the shard.
 */
export function evaluateSupermodelShardGuard(event: HarnessEvent): HarnessDecision | null {
	const shardBlock = checkSupermodelShardWrite(event);
	if (shardBlock) {
		return {
			decision: "block",
			reason: shardBlock.reason,
			rule_id: shardBlock.rule_id,
			severity: shardBlock.severity,
			category: shardBlock.category,
		};
	}
	return null;
}

/**
 * GUARD: Supply-chain — block package-install shell commands whose
 * packages are not on the per-ecosystem allowlist. Runs before the main
 * rule loop because the existing `builtin-npm-no-ignore-scripts` rule
 * only warns; this gate fails closed. Bypass via INTERLINKED_DISABLE_PACKAGE_GUARD=1
 * (logged; intended for documented bootstrap flows only).
 */
export function evaluatePackageInstallGuard(
	event: HarnessEvent,
	toolName: string,
	toolInput: ToolInput,
): HarnessDecision | null {
	if (process.env.INTERLINKED_DISABLE_PACKAGE_GUARD !== "1" && isBash(toolName)) {
		const cmd = (toolInput.command as string) || "";
		if (cmd) {
			const installCommands = parseInstallCommands(cmd);
			if (installCommands.length > 0) {
				const evalCwd = event.cwd || process.cwd();
				const allowlist = loadAllowlist(evalCwd);
				const supplyDecision = evaluatePackageInstall(installCommands, evalCwd, allowlist);
				if (supplyDecision && supplyDecision.decision === "block") {
					return supplyDecision;
				}
			}
		}
	}
	return null;
}

/**
 * GUARD: Git session-scope gate (PB&J Free-CLI item #7) — asks before
 * `git add` / `git commit` / `git push` includes files this session didn't
 * write. Off by default until validated on real sessions; force-push is
 * intentionally deferred to the existing force-push rule.
 */
export function evaluateGitScopeGate(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): HarnessDecision | null {
	if (isBash(toolName) && session) {
		const gateConfig = rules.git_session_scope_gate;
		if (gateConfig?.enabled && gateConfig.mode !== "off") {
			const cmd = (toolInput.command as string) || "";
			if (cmd) {
				const evalCwd = event.cwd || process.cwd();
				const verdict = evaluateGitScopeGateSync(cmd, session, evalCwd);
				if (verdict && verdict.decision === "ask") {
					const mappedDecision: "ask" | "block" =
						gateConfig.mode === "block" ? "block" : "ask";
					return {
						decision: mappedDecision,
						reason: verdict.reason ?? "git operation scope ambiguous",
						rule_id: "git-session-scope-gate",
						severity: "medium",
						category: "git-scope",
						warnings,
					};
				}
			}
		}
	}
	return null;
}

/**
 * GUARD: Protected files.
 *
 * Gate must admit BOTH read and write tools, then let the per-rule
 * `operations` list (via `evaluateProtectedFiles` → `normalizeToolToOp`)
 * decide. `protected_files` rules are not write-only: the default config
 * marks `**​/*.pem` / `**​/*.key` with `operations: ["Write","Edit","Read"]`
 * to block private-key *reads* (exfiltration), so the gate must reach the
 * guard on `Read` too.
 *
 * `isFileOperation` alone OMITS MultiEdit / NotebookEdit — the write-skip
 * hole (BUG 2): a MultiEdit / NotebookEdit to a protected path silently
 * bypassed the blanket block. Union with `isFileWrite` (which adds exactly
 * those two write-family tools) closes the hole without dropping any read
 * tool, so read-protection is preserved.
 */
export function evaluateProtectedFilesGuard(
	toolName: string,
	toolInput: ToolInput,
	rules: GuardRulesConfig,
	warnings: string[],
): HarnessDecision | null {
	if (isFileOperation(toolName) || isFileWrite(toolName)) {
		const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
		if (filePath) {
			const content = (toolInput.content as string) || (toolInput.new_string as string) || "";
			const pfDecision = evaluateProtectedFiles({
				toolName,
				filePath,
				content,
				protectedFiles: rules.protected_files,
				containsSecrets,
			});
			if (pfDecision) return { ...pfDecision, warnings };
		}
	}
	return null;
}

/** GUARD: Repo confinement — block writes outside CWD. */
export function evaluateRepoConfinementGuard(
	event: HarnessEvent,
	toolName: string,
	toolInput: ToolInput,
	rules: GuardRulesConfig,
	warnings: string[],
): HarnessDecision | null {
	if (isFileWrite(toolName) && event.cwd) {
		const rawPath = (toolInput.file_path as string) || (toolInput.path as string) || "";
		if (rawPath) {
			const rcDecision = evaluateRepoConfinement({
				rawPath,
				cwd: event.cwd,
				allowlist: rules.repo_confinement_allowlist || [],
				linkedProjects: rules.linked_projects || [],
				sessionId: event.session_id,
			});
			if (rcDecision) return { ...rcDecision, warnings };
		}
	}
	return null;
}

/** TDD gate — block new non-test .ts/.tsx without a companion test (enforce mode only). */
export function evaluateTddGate(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
	toolName: string,
	warnings: string[],
): HarnessDecision | null {
	if (isFileWrite(toolName)) {
		const d = evaluateTddNewFileGateForEvent(event, rules, session);
		if (d) return { ...d, warnings };
	}
	return null;
}

/**
 * Config-loosening gate — ask before strict-flag relaxations on
 * tsconfig.json / package.json / known config files.
 */
export function evaluateConfigLooseningGate(
	event: HarnessEvent,
	toolName: string,
	warnings: string[],
): HarnessDecision | null {
	if (isFileWrite(toolName)) {
		const d = evaluateConfigLooseningForEvent(event);
		if (d) return { ...d, warnings };
	}
	return null;
}

/**
 * Baseline-integrity gate — block a Write/Edit/MultiEdit that loosens a
 * committed ratchet water-line under `.interlinked/` (coverage / mutation /
 * per-edit-coverage / large-files / untested-files / metric-caps). Water-lines
 * may only move in the tightening direction; the harness raises them itself via
 * internal writes, never the agent's edit tools. See baseline-integrity-gate.ts.
 */
export function evaluateBaselineIntegrityGate(
	event: HarnessEvent,
	toolName: string,
	warnings: string[],
): HarnessDecision | null {
	if (isFileWrite(toolName)) {
		const d = evaluateBaselineIntegrityForEvent(event);
		if (d) return { ...d, warnings };
	}
	return null;
}

/** GUARD: Edit tool — verify old_string exists. */
export function evaluateEditOldStringGuard(
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): HarnessDecision | null {
	if (toolName === "Edit" && toolInput.file_path && toolInput.old_string) {
		const filePath = toolInput.file_path as string;
		const oldString = toolInput.old_string as string;
		try {
			if (existsSync(filePath)) {
				const fileContent = readFileSync(filePath, "utf-8");
				if (!fileContent.includes(oldString)) {
					const misses = findClosestSpans(fileContent, oldString, 3);
					const hint = misses.length
						? `\nClosest matches in file:\n${formatNearMisses(misses)}\nRe-read at one of these line ranges, then retry with the exact text.`
						: "";
					return {
						decision: "block",
						reason: `Edit will fail: old_string not found in ${filePath}. The file may have been modified by another agent. Re-read the file first.${hint}`,
						warnings,
					};
				}
			}
		} catch (e) {
			void e;
		}
	}
	return null;
}

/** GUARD: WebFetch — exfiltration and safety (block file:// protocol). */
export function evaluateWebFetchGuard(
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): HarnessDecision | null {
	if (toolName === "WebFetch" || toolName === "web_fetch" || toolName === "WebSearch") {
		const url = (toolInput.url as string) || "";
		if (url.startsWith("file://")) {
			return {
				decision: "block",
				reason: "BLOCKED: file:// protocol access is not allowed via WebFetch.",
				warnings,
			};
		}
	}
	return null;
}

/**
 * GUARD: Supply-chain — block Write/Edit of a package manifest that
 * would introduce a new, unapproved dependency. Catches the vector
 * where an agent skips the install command and adds an entry directly
 * to package.json / requirements.txt / pyproject.toml / Cargo.toml /
 * Gemfile / go.mod.
 */
export function evaluateManifestEditGuard(
	event: HarnessEvent,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): HarnessDecision | null {
	if (process.env.INTERLINKED_DISABLE_PACKAGE_GUARD !== "1" && isFileWrite(toolName)) {
		const mfPath = (toolInput.file_path as string) || (toolInput.path as string) || "";
		if (mfPath) {
			const mfCwd = event.cwd || process.cwd();
			const absPath = isAbsolute(mfPath) ? mfPath : resolve(mfCwd, mfPath);
			const fullNewContent = computeFullNewContent(absPath, toolInput);
			if (fullNewContent !== null) {
				const manifestBlock = evaluateManifestEdit({
					filePath: absPath,
					newContent: fullNewContent,
					allowlist: loadAllowlist(mfCwd),
					cwd: mfCwd,
					warnings,
				});
				if (manifestBlock) return manifestBlock;
			}
		}
	}
	return null;
}
