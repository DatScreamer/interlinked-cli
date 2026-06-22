// payload-casing — detects reading a cross-runner hook-payload field in ONE
// casing without a fallback to the other.
//
// Bug class (agent-era hook-contract drift): the thinking-capture regression
// that motivated this check happened because one hook impl read the payload as
// snake_case (`transcript_path`) while a payload-shape change could deliver it
// camelCased (`transcriptPath`); the single-casing read silently returned
// undefined and the capability went dark with no error. Hook payloads cross a
// runner boundary (Claude Code / Codex / Gemini / Copilot) and the same logical
// field genuinely arrives in both casings across runners and versions, so a
// raw-payload field read should tolerate both.
//
// Scope (to keep FP near zero): only flags a known cross-runner CONTRACT field,
// only when read off a variable named like a RAW payload (rawInput / nativeJson
// / hookInput / payload / input), and only when the OTHER casing is absent from
// the same line (a `x.snake ?? x.camel` dual-read is the safe pattern and is not
// flagged). Our own normalized objects (`event`, `record`, …) are out of scope —
// they have a fixed internal casing, so reading one casing there is correct.
//
// Check id: payload_field_casing. Advisory (heuristic — shape, not behavior).

import type { InlineMatch } from "./shared.js";

/** Variable names that hold a RAW, un-normalized hook payload whose field casing
 *  is the runner's choice. Deliberately excludes our normalized `event`/`record`
 *  shapes, which have a fixed internal casing. */
const PAYLOAD_VARS = ["rawInput", "nativeJson", "hookInput", "payload", "input"];

/** snake_case ↔ camelCase pairs of hook-payload contract fields that genuinely
 *  appear in both casings across runners/versions. */
const CONTRACT_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["transcript_path", "transcriptPath"],
	["session_id", "sessionId"],
	["hook_event_name", "hookEventName"],
	["permission_mode", "permissionMode"],
	["tool_use_id", "toolUseId"],
	["tool_name", "toolName"],
	["tool_input", "toolInput"],
	["parent_tool_use_id", "parentToolUseId"],
	["agent_transcript_path", "agentTranscriptPath"],
	["stop_hook_active", "stopHookActive"],
];

const VAR_GROUP = PAYLOAD_VARS.join("|");

/**
 * Flag a raw-payload contract-field read that has no other-casing fallback on the
 * same line. `(content, filePath) => InlineMatch[]` to satisfy the registry
 * contract. Skips non-JS/TS and test files. Advisory; heuristic.
 *
 * check id: `payload_field_casing`
 */
export function detectPayloadFieldCasing(content: string, filePath: string): InlineMatch[] {
	const normPath = filePath.replace(/\\/g, "/");
	if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(normPath)) return [];
	if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normPath)) return [];

	const out: InlineMatch[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		for (const [snake, camel] of CONTRACT_PAIRS) {
			const readsSnake = new RegExp(`\\b(?:${VAR_GROUP})\\.${snake}\\b`).test(line);
			const readsCamel = new RegExp(`\\b(?:${VAR_GROUP})\\.${camel}\\b`).test(line);
			if (readsSnake && !line.includes(camel)) {
				out.push({
					line: i + 1,
					text: `payload field .${snake} read without a \`?? .${camel}\` fallback — another runner may deliver the camelCase casing`.slice(
						0,
						150,
					),
				});
			} else if (readsCamel && !line.includes(snake)) {
				out.push({
					line: i + 1,
					text: `payload field .${camel} read without a \`?? .${snake}\` fallback — another runner may deliver the snake_case casing`.slice(
						0,
						150,
					),
				});
			}
		}
	}
	return out;
}
