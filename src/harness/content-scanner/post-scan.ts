// ===========================================
// Content Scanner — PostToolUse Read/Grep scan
// ===========================================
//
// Runs the ML content scanner over the return payload of a Read/Grep tool
// call. On detection:
//   - Ratchets session sensitivity (`Confidential`, or `HighlyConfidential`
//     for `secret`/`account_number`), so existing taint-aware rules (no
//     network after taint, step-budget tightening, etc.) fire downstream.
//   - Records the tool-call step in `session.pii_detected_steps` for future
//     PreToolUse gating patterns to consume.
//   - Returns a human-readable warning listing the detected categories.
//
// Never blocks — we're already post-read; the damage of *reading* PII is
// limited to what the model then *does*. The taint ratchet is how we stop
// that downstream.

import { ratchetSensitivity } from "../taint-tracker.js";
import type {
	GuardRulesConfig,
	HarnessEvent,
	SensitivityLevel,
	SessionTrajectory,
} from "../types.js";
import { decideFromFindings } from "./policy.js";
import type { ContentScanner, ScanFinding } from "./types.js";

// ===========================================
// Applicability — kept out of the main helper so the condition is readable.
// ===========================================

const READ_TOOLS = new Set([
	"Read",
	"ReadFile",
	"read_file",
	"FileRead",
	"view",
	"Grep",
	"grep",
	"Glob",
]);

/** Label set that escalates to `HighlyConfidential` on detection. Everything else → `Confidential`. */
const HIGHLY_CONFIDENTIAL_LABELS = new Set(["secret", "account_number"]);

/** Returns the text to scan, or `undefined` when the event doesn't carry scannable content. */
function extractReadResponseText(event: HarnessEvent): string | undefined {
	const response = event.tool_response;
	if (response === undefined || response === null) return undefined;
	if (typeof response === "string") return response.length > 0 ? response : undefined;
	// Some tools return structured objects (e.g., Grep returns a stringifiable list).
	// Serialize defensively — the scanner just needs text, and JSON.stringify is
	// stable enough for PII detection against quoted values.
	try {
		const serialized = JSON.stringify(response);
		return serialized.length > 2 ? serialized : undefined; // "" and "null" aren't worth scanning
	} catch {
		return undefined;
	}
}

// ===========================================
// Public API
// ===========================================

export interface PostScanResult {
	warnings: string[];
	findings: ScanFinding[];
	/** New sensitivity level, or `undefined` if no ratchet occurred. */
	ratcheted_to?: SensitivityLevel;
}

/**
 * Run the content scanner over a PostToolUse Read/Grep event. Fail-open on
 * any error. The caller owns the session object; we mutate it when findings
 * are present.
 */
export async function runPostToolScan(
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	rules: GuardRulesConfig,
	scanner: ContentScanner | undefined,
): Promise<PostScanResult> {
	const empty: PostScanResult = { warnings: [], findings: [] };
	if (!scanner) return empty;
	const cfg = rules.content_scanner;
	if (!cfg?.enabled || !cfg.scan_points.read_grep_taint) return empty;
	const toolName = event.tool_name ?? "";
	if (!READ_TOOLS.has(toolName)) return empty;

	const text = extractReadResponseText(event);
	if (!text) return empty;

	const scanLimit = cfg.max_scan_bytes || rules.output_scanning?.max_scan_bytes || 100_000;
	let findings: ScanFinding[];
	try {
		findings = await scanner.scan({
			text: text.slice(0, scanLimit),
			source: `${toolName}.tool_response`,
			signal: AbortSignal.timeout(cfg.local.scan_timeout_ms || 1500),
		});
	} catch {
		return empty; // fail-open
	}

	if (findings.length === 0) return empty;

	// Policy reuses the PreToolUse decision to compute the human-readable
	// summary — same label taxonomy and ordering guarantees.
	const verdict = decideFromFindings(findings, cfg);
	const summary =
		verdict.reason ??
		`BLOCKED: privacy-filter detected sensitive content [${findings.length} span(s)].`;

	// Pick sensitivity level — `secret`/`account_number` → HighlyConfidential.
	const ratchetLevel: SensitivityLevel = findings.some((f) =>
		HIGHLY_CONFIDENTIAL_LABELS.has(f.label),
	)
		? "HighlyConfidential"
		: "Confidential";

	const filePath = (event.tool_input?.file_path as string) || `<${toolName}-response>`;
	let ratcheted: SensitivityLevel | undefined;
	if (session && rules.taint_tracking?.enabled) {
		const changed = ratchetSensitivity(session, filePath, ratchetLevel, rules.taint_tracking);
		if (changed) ratcheted = ratchetLevel;
		// Record the step even when the ratchet was a no-op (already at or above
		// the target level) — PreToolUse gating patterns care about detection
		// events, not just monotone changes.
		session.pii_detected_steps.push(session.tool_call_count);
	}

	const warning =
		`[interlinked:content-scanner] ${toolName} returned sensitive content ` +
		`(session sensitivity → ${ratchetLevel}). ${summary.replace(/^BLOCKED: /, "")}`;

	return { warnings: [warning], findings, ratcheted_to: ratcheted };
}
