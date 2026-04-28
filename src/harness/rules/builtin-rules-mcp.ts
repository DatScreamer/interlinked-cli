// ===========================================
// Built-in Rules — Generic MCP destructive-tool guard
// ===========================================
//
// MCP tool names are deliberately verb-shaped — `volume_delete`,
// `project_destroy`, `database_drop`, `kv_purge`. We use that convention
// as a defence-in-depth signal: if the agent is calling a tool whose name
// itself reads like a destructive operation, surface it for review even
// if we don't have a vendor-specific rule for it.
//
// Default: action: "ask". The user gets a per-call prompt on Claude Code
// and Cursor; on Copilot/Codex/Gemini the provider-response formatter
// collapses ask → deny so the user still sees the reason and can retry
// after deciding whether the tool is acceptable.
//
// This rule complements (does not replace) vendor-specific rules. The
// Railway MCP family hard-blocks; Cloudflare Wrangler's MCP equivalents
// (when they ship) should also hard-block. This generic rule catches
// destructive tools across vendors we haven't individually catalogued —
// the long tail.

import type { GuardRule } from "../types.js";

const MCP_DESTRUCTIVE_VERBS = [
	"delete",
	"destroy",
	"drop",
	"remove",
	"terminate",
	"purge",
	"wipe",
	"truncate",
	"erase",
	"obliterate",
];

// Build a regex that requires:
//   - prefix `mcp__<server>__`
//   - then a token boundary (start of name, underscore, OR a lowercase→Upper transition for camelCase)
//   - then one of the verbs as the start of the verb-token
//
// This rejects substring false positives:
//   - `mcp__post__delivery_status` ← "delivery" contains "delive..." but not at a word boundary
//   - `mcp__finance__splurgemeter`  ← "splurge" contains "purge" mid-word
//
// To handle camelCase (`deleteRepo`, `dropDatabase`) without matching
// `splurgemeter`, we require the verb to start either at the beginning of
// the post-prefix segment, after an underscore, or after a hyphen.
//
// We do NOT use a `\\b` boundary because verbs like `deleteUser` start
// with a word char immediately after another (transition Lower→Upper), and
// JS regex `\\b` is purely word-character-based. Instead we anchor via:
//   `(?:^|_|-)` (after-prefix segment) + verb stem + `(?:[A-Z_-]|$|\\W)`
// where the trailing match permits camelCase boundaries (`deleteRepo`),
// snake_case boundaries (`delete_user`), and end-of-string.

const MCP_DESTRUCTIVE_VERB_RE = `(?:^|__|_|-)(?:${MCP_DESTRUCTIVE_VERBS.join(
	"|",
)})(?=[A-Z_-]|$|[^a-z])`;

/**
 * Public API — consumed by `rules/builtin-rules.ts` to assemble the full
 * BUILTIN_RULES array exported by `rules-loader.ts`.
 */
export const MCP_DESTRUCTIVE_RULES: GuardRule[] = [
	{
		id: "builtin-mcp-destructive-verb",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["*"],
		action: "ask",
		patterns: [
			// MCP tool names follow the `mcp__<server>__<verb>` convention.
			// Match the prefix, then look for a destructive verb as the leading
			// segment of the action portion.
			{
				field: "tool_name",
				regex: `^mcp__[^_]+(?:__[^_]+)*${MCP_DESTRUCTIVE_VERB_RE}`,
				flags: "i",
			},
		],
		reason:
			"This MCP tool's name suggests a destructive operation (delete/destroy/drop/" +
			"truncate/wipe/purge/remove/terminate/erase/obliterate). MCP tools have no " +
			"built-in confirmation step — once invoked with a valid token, the operation " +
			"runs.",
		suggestion:
			"Verify: (1) which vendor and environment this tool targets, (2) the token's " +
			"scope (many vendors ship blanket-permission tokens by default), (3) whether " +
			"recovery is possible. If approving, prefer running destructive operations as " +
			"discrete, intentional steps rather than as part of an agent's autonomous " +
			"trajectory.",
		severity: "critical",
		category: "mcp-destructive",
	},
];
