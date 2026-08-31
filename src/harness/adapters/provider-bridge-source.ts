import { formatAskReasonWithTargets } from "../evaluator/rule-matching.js";
import { MANAGED_PROVIDER_FILE_MARKER } from "../managed-provider-file.js";
import type { HarnessDecision } from "../types.js";
import type { AdapterOutput } from "./types.js";

export const PROVIDER_BRIDGE_MARKER = MANAGED_PROVIDER_FILE_MARKER;

const FALLBACK_BLOCK_REASON =
	"Blocked by the interlinked harness, but no reason was attached — likely a harness " +
	"bug; re-run, or run `interlinked harness restart`, then report it.";

const BRIDGE_CONSTANTS_AND_HELPERS = `import { spawn } from "node:child_process";

const INTERLINKED_TIMEOUT_MS = 10_000;
const INTERLINKED_MAX_INPUT_BYTES = 256 * 1024;
const INTERLINKED_MAX_OUTPUT_BYTES = 64 * 1024;

function interlinkedErrorText(error) {
    return error instanceof Error ? error.message : String(error);
}

function interlinkedFeedback(decision) {
    const lines = [];
    if (decision.reason && decision.decision !== "allow") lines.push(decision.reason);
    if (Array.isArray(decision.warnings)) lines.push(...decision.warnings.filter((item) => typeof item === "string"));
    if (typeof decision.additional_context === "string") lines.push(decision.additional_context);
    return lines.filter(Boolean).join("\\n");
}

function interlinkedLegacyHookEvent(eventName) {
    const aliases = {
        "chat.message": "UserPromptSubmit",
        input: "UserPromptSubmit",
        "tool.execute.before": "PreToolUse",
        tool_call: "PreToolUse",
        user_bash: "PreToolUse",
        "tool.execute.after": "PostToolUse",
        tool_result: "PostToolUse",
        "permission.ask": "PermissionRequest",
        "event:permission.updated": "PermissionRequest",
        "experimental.session.compacting": "PreCompact",
        session_before_compact: "PreCompact",
        "event:session.compacted": "PostCompact",
        session_compact: "PostCompact",
        "event:session.created": "SessionStart",
        session_start: "SessionStart",
        "event:session.deleted": "SessionEnd",
        session_shutdown: "SessionEnd",
        "event:session.idle": "Stop",
        agent_settled: "Stop",
    };
    return aliases[eventName] || eventName;
}

function interlinkedDecisionFromOutput(text) {
    const trimmed = text.trim();
    if (!trimmed) return { decision: "allow" };
    const parsed = JSON.parse(trimmed);
    if (parsed && ["allow", "block", "ask"].includes(parsed.decision)) return parsed;

    const specific = parsed && parsed.hookSpecificOutput;
    const permission = specific && specific.permissionDecision;
    if (permission === "deny" || permission === "block") {
        return {
            decision: "block",
            reason: specific.permissionDecisionReason || specific.reason || "Blocked by Interlinked",
        };
    }
    if (permission === "ask") {
        return {
            decision: "ask",
            reason: specific.permissionDecisionReason || specific.reason || "Confirmation required",
        };
    }

    const permissionBehavior = specific && specific.decision && specific.decision.behavior;
    if (permissionBehavior === "deny" || permissionBehavior === "block") {
        return {
            decision: "block",
            reason: specific.decision.message || "Blocked by Interlinked",
        };
    }
    if (permissionBehavior === "ask") {
        return {
            decision: "ask",
            reason: specific.decision.message || "Confirmation required",
        };
    }

    const additionalContext = specific && specific.additionalContext || parsed && parsed.additionalContext;
    return typeof additionalContext === "string"
        ? { decision: "allow", additional_context: additionalContext }
        : { decision: "allow" };
}
`;

const BRIDGE_INVOKE_START = `function invokeInterlinked(eventName, payload) {
    return new Promise((resolve, reject) => {
        let encoded;
        try {
            encoded = JSON.stringify({
                hook_event_name: interlinkedLegacyHookEvent(eventName),
                ...payload,
            });
        } catch (error) {
            reject(new Error("could not serialize provider event: " + interlinkedErrorText(error)));
            return;
        }
        if (Buffer.byteLength(encoded) > INTERLINKED_MAX_INPUT_BYTES) {
            reject(new Error("provider event exceeded the 256 KiB bridge input limit"));
            return;
        }

        const child = spawn("node", [INTERLINKED_HOOK_ENTRY, "--runner", INTERLINKED_RUNNER, "--event", eventName], {
            cwd: typeof payload.cwd === "string" ? payload.cwd : process.cwd(),
            env: { ...process.env, INTERLINKED_CLIENT: INTERLINKED_RUNNER },
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout = [];
        const stderr = [];
        let outputBytes = 0;
        let settled = false;
        let timer;

        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
        };
        const collect = (target, chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > INTERLINKED_MAX_OUTPUT_BYTES) {
                child.kill("SIGKILL");
                finish(new Error("provider bridge output exceeded 64 KiB"));
                return;
            }
            target.push(chunk);
        };
`;

const BRIDGE_INVOKE_FINISH = `        timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(new Error("Interlinked hook timed out after 10 seconds"));
        }, INTERLINKED_TIMEOUT_MS);

        child.stdout.on("data", (chunk) => collect(stdout, chunk));
        child.stderr.on("data", (chunk) => collect(stderr, chunk));
        child.once("error", (error) => finish(error));
        child.once("close", (code) => {
            if (settled) return;
            const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
            if (code !== 0) {
                finish(new Error("Interlinked hook exited " + String(code) + (diagnostic ? ": " + diagnostic.slice(0, 4096) : "")));
                return;
            }
            try {
                const parsed = interlinkedDecisionFromOutput(Buffer.concat(stdout).toString("utf8"));
                finish(undefined, parsed);
            } catch (error) {
                finish(new Error("invalid Interlinked response: " + interlinkedErrorText(error)));
            }
        });
        child.stdin.once("error", (error) => finish(error));
        child.stdin.end(encoded);
    });
}

async function observeInterlinked(eventName, payload) {
    try {
        return await invokeInterlinked(eventName, payload);
    } catch (error) {
        console.error("[interlinked] " + eventName + ": " + interlinkedErrorText(error));
        return undefined;
    }
}
`;

/** The managed plugin protocols use one provider-neutral JSON reply. The
 * generated bridge, rather than hook-entry, owns the provider API calls. */
export function encodeProviderBridgeDecision(decision: HarnessDecision): AdapterOutput {
	const warnings = decision.warnings ?? [];
	const reason = bridgeDecisionReason(decision);
	const payload = {
		decision: decision.decision,
		...(reason ? { reason } : {}),
		...(warnings.length > 0 ? { warnings } : {}),
		...(decision.additional_context
			? { additional_context: decision.additional_context }
			: {}),
		...(decision.updated_input ? { updated_input: decision.updated_input } : {}),
	};
	return {
		stdout: JSON.stringify(payload),
		stderr: warnings.length > 0 ? warnings.join("\n") : undefined,
		exit_code: 0,
	};
}

function bridgeDecisionReason(decision: HarnessDecision): string | undefined {
	if (decision.decision === "allow") return decision.reason;
	return formatAskReasonWithTargets(
		decision.reason ??
			(decision.decision === "ask" ? "Confirmation required" : FALLBACK_BLOCK_REASON),
		decision.resolved_targets,
	);
}

/** Shared, dependency-free runtime prepended to each managed provider file. */
export function renderProviderBridgePrelude(runner: "opencode" | "pi", binaryPath: string): string {
	const identity =
		`const INTERLINKED_RUNNER = ${JSON.stringify(runner)};\n` +
		`const INTERLINKED_HOOK_ENTRY = ${JSON.stringify(binaryPath)};\n`;
	return [
		PROVIDER_BRIDGE_MARKER,
		BRIDGE_CONSTANTS_AND_HELPERS,
		identity,
		BRIDGE_INVOKE_START,
		BRIDGE_INVOKE_FINISH,
	].join("\n");
}
