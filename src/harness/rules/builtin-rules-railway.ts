// ===========================================
// Built-in Rules — Railway-specific destructive guard
// ===========================================
//
// Direct response to PocketOS's 2026-04-25 incident: a Cursor agent ran
//   curl -X POST https://backboard.railway.app/graphql/v2 \
//     -H "Authorization: Bearer <token-meant-for-domains>" \
//     -d '{"query":"mutation { volumeDelete(volumeId: \"3d2c42fb-...\") }"}'
// and wiped a production volume in nine seconds, taking volume-level
// "backups" with it (Railway stores them in the same volume).
//
// These rules are HARD BLOCKS. The reasoning differs from generic
// destructive HTTP rules:
//   1. Railway tokens have NO operation/environment scoping — a token
//      created for `railway domains add` has the same permissions as one
//      for `volumeDelete`. We cannot trust that the agent's chosen token
//      is environment-restricted.
//   2. Volume backups live in the same volume — destruction is total.
//   3. As of 2026-04-26 Railway has no published recovery SLA.
//
// Users running deliberate Railway sandbox cleanups can disable specific
// rules via .interlinked/guard-rules.local.json#disabled_rules.

import type { GuardRule } from "../types.js";
import { nonNull } from "../../lib/non-null.js";

const RAILWAY_DESTRUCTIVE_VERBS = [
	"delete",
	"destroy",
	"drop",
	"remove",
	"terminate",
	"purge",
	"wipe",
];

// Word-boundary form (case-insensitive). Catches `delete`, `Delete`,
// `DELETE`, `mutation { delete(...)`, etc. Does NOT match camelCase
// `volumeDelete` because there's no \b between `e` and `D`.
const RAILWAY_VERB_WORD_BOUNDARY = `\\b(?:${RAILWAY_DESTRUCTIVE_VERBS.join("|")})\\w*\\b`;

// camelCase form (case-sensitive). Catches `volumeDelete`, `projectDestroy`.
// Case-sensitive lookbehind avoids false-positives on lowercase mid-word
// occurrences (e.g. `splurge` does NOT match `Purge`).
const RAILWAY_VERB_CAMEL_CASE = `(?<=[a-z])(?:${RAILWAY_DESTRUCTIVE_VERBS
	.map((v) => nonNull(v[0]).toUpperCase() + v.slice(1))
	.join("|")})\\w*`;

const RAILWAY_VERB_UC_ALT = RAILWAY_DESTRUCTIVE_VERBS
	.map((v) => nonNull(v[0]).toUpperCase() + v.slice(1))
	.join("|");
const RAILWAY_VERB_LC_ALT = RAILWAY_DESTRUCTIVE_VERBS.join("|");

// Railway GraphQL API hostnames. Both `backboard.railway.app` (current,
// observed in the PocketOS incident) and `railway.app/graphql` (older
// path) are covered.
const RAILWAY_GRAPHQL_HOST_FRAGMENT = "(?:backboard\\.railway\\.app|railway\\.app/graphql)";

/**
 * Public API — consumed by `rules/builtin-rules.ts` to assemble the full
 * BUILTIN_RULES array exported by `rules-loader.ts`.
 */
export const RAILWAY_RULES: GuardRule[] = [
	// --- Railway CLI destructive verbs ---
	{
		id: "builtin-railway-cli-destructive",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			// Resource-scoped destructive verbs:
			//   railway volumes delete, railway volume delete
			//   railway service delete / services delete
			//   railway environment delete / environments delete
			//   railway project delete / projects delete
			//   railway plugin delete / plugins delete
			{
				field: "command",
				regex:
					"\\brailway\\s+(?:volumes?|services?|environments?|projects?|plugins?|deployments?)\\s+(?:delete|destroy|remove|down|teardown)\\b",
				flags: "i",
			},
			// Bare `railway down` — the project teardown command.
			{ field: "command", regex: "\\brailway\\s+down\\b", flags: "i" },
			// `railway delete` (bare) — older alias for project deletion.
			{ field: "command", regex: "\\brailway\\s+delete\\b", flags: "i" },
		],
		reason:
			"Railway CLI destructive command. Railway tokens have no operation/environment " +
			"scoping (a token for `railway domains add` has the same permissions as one for " +
			"`volumeDelete`), and volume-level backups are stored IN the same volume — " +
			"destruction is total and recovery is uncertain.",
		suggestion:
			"Run this manually after verifying environment, scoping, and external backups. " +
			"If you have an external backup of any data on the affected resource, ensure it's " +
			"current before approving.",
		severity: "critical",
		category: "railway",
	},

	// --- Railway GraphQL destructive mutations against backboard.railway.app ---
	//
	// Four patterns to handle the cross-product of:
	//   (a) URL-then-mutation vs mutation-then-URL ordering
	//   (b) lowercase verb (`mutation { delete(`, snake_case) vs
	//       camelCase verb (`mutation { volumeDelete(` — Railway's
	//       canonical naming, the exact PocketOS shape)
	{
		id: "builtin-railway-graphql-destructive",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			// URL → mutation → lowercase/snake_case verb
			{
				field: "command",
				regex: `\\b(curl|wget|xh|http|httpie)\\b[^|;&]*?${RAILWAY_GRAPHQL_HOST_FRAGMENT}[\\s\\S]{0,800}?\\bmutation\\b[\\s\\S]{0,400}?${RAILWAY_VERB_WORD_BOUNDARY}`,
				flags: "i",
			},
			// URL → mutation → camelCase verb (e.g. volumeDelete)
			{
				field: "command",
				regex: `\\b(curl|wget|xh|http|httpie)\\b[^|;&]*?${RAILWAY_GRAPHQL_HOST_FRAGMENT}[\\s\\S]{0,800}?\\bmutation\\b[\\s\\S]{0,400}?${RAILWAY_VERB_CAMEL_CASE}`,
				flags: "",
			},
			// mutation → verb → URL (-d body before URL on the line)
			{
				field: "command",
				regex: `\\b(curl|wget|xh|http|httpie)\\b[^|;&]*?\\bmutation\\b[\\s\\S]{0,400}?${RAILWAY_VERB_WORD_BOUNDARY}[\\s\\S]{0,800}?${RAILWAY_GRAPHQL_HOST_FRAGMENT}`,
				flags: "i",
			},
			// mutation → camelCase verb → URL
			{
				field: "command",
				regex: `\\b(curl|wget|xh|http|httpie)\\b[^|;&]*?\\bmutation\\b[\\s\\S]{0,400}?${RAILWAY_VERB_CAMEL_CASE}[\\s\\S]{0,800}?${RAILWAY_GRAPHQL_HOST_FRAGMENT}`,
				flags: "",
			},
		],
		reason:
			"Destructive GraphQL mutation against Railway's API. This is the exact shape " +
			"that wiped PocketOS's production data on 2026-04-25: a curl POST to " +
			"backboard.railway.app/graphql/v2 with a `mutation { volumeDelete(...) }` body " +
			"and a token that turned out to be over-permissioned. Railway has no scoped " +
			"tokens, no destructive-operation confirmation, and no published recovery SLA.",
		suggestion:
			"Do not run this from an agent session. If you must perform this operation, " +
			"do it from a human-driven session AFTER: (1) verifying you have an external " +
			"backup of any data on the affected resource, (2) confirming the resource id " +
			"matches the intended environment, (3) accepting that recovery is not guaranteed.",
		severity: "critical",
		category: "railway",
	},

	// --- Railway MCP tool destructive calls ---
	{
		id: "builtin-railway-mcp-destructive",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["*"],
		action: "block",
		patterns: [
			// snake_case Railway MCP tool names: `mcp__railway__volume_delete`
			{
				field: "tool_name",
				regex: `^mcp__railway[\\w-]*__\\w*(?:_|-)(?:${RAILWAY_VERB_LC_ALT})\\w*$`,
				flags: "i",
			},
			// camelCase Railway MCP tool names: `mcp__railway__volumeDelete`
			{
				field: "tool_name",
				regex: `^mcp__railway[\\w-]*__\\w*(?<=[a-z])(?:${RAILWAY_VERB_UC_ALT})\\w*$`,
				flags: "",
			},
			// Bare destructive verb directly after the prefix:
			// `mcp__railway__delete`, `mcp__railway__destroy`.
			{
				field: "tool_name",
				regex: `^mcp__railway[\\w-]*__(?:${RAILWAY_VERB_LC_ALT})\\w*$`,
				flags: "i",
			},
		],
		reason:
			"Railway MCP tool with a destructive name. mcp.railway.com uses the same " +
			"unscoped authorization model as the GraphQL API — once invoked, the operation " +
			"is final and recovery is uncertain.",
		suggestion:
			"Use a non-destructive Railway MCP tool, or perform the destructive operation " +
			"manually from a human-driven session with verified backups.",
		severity: "critical",
		category: "railway",
	},
];
