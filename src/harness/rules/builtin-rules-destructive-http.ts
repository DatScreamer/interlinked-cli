// ===========================================
// Built-in Rules — Generic destructive HTTP / API surface
// ===========================================
//
// Catches the class of failure that took down PocketOS on 2026-04-25:
// an agent issuing a destructive call to a vendor API directly via curl
// (or fetch / xh / httpie). The actual deletion command was a Railway
// GraphQL mutation, but the *shape* — destructive verb in REST/GraphQL
// inside an arbitrary curl invocation — generalises across vendors.
//
// We default to `action: "ask"`, NOT `block`. Reasons:
//   1. Destructive HTTP calls are sometimes legitimate (cleanup scripts,
//      cron jobs being scaffolded, tests against sandbox endpoints).
//   2. The agents we care most about (Claude Code, Cursor) support an
//      interactive permission prompt — the user gets to approve per-call.
//   3. Agents that lack an ask primitive (Copilot, Codex, Gemini) have
//      ask collapsed to deny by the provider-response formatter, so the
//      end behaviour for those clients is identical to a hard block.
//
// This is the strongest layer of defence we have against the class of
// failure where:
//   - the agent finds a credential in a file unrelated to its task
//   - constructs a destructive API call against that credential
//   - executes it without user awareness
//
// Rules in this file work in concert with the Railway- and MCP-specific
// rule families (see builtin-rules-railway.ts, builtin-rules-mcp.ts) — those
// families upgrade specific known-destructive APIs to a hard block, while
// this one acts as the catch-all for vendors and operations we haven't
// individually catalogued.

import type { GuardRule } from "../types.js";
import { nonNull } from "../../lib/non-null.js";

// Verbs that signal a destructive intent inside a JSON body / GraphQL
// mutation / shell pipeline. We accept English-tense plurality (delete /
// deletes / deleted / deleting) by anchoring on a stem.
const DESTRUCTIVE_VERB_STEMS = [
	"delete",
	"destroy",
	"drop",
	"truncate",
	"wipe",
	"purge",
	"remove",
	"terminate",
	"erase",
	"obliterate",
	"unlink",
	"forcedelete",
	"force_delete",
];

const DESTRUCTIVE_VERB_LC_ALT = DESTRUCTIVE_VERB_STEMS.join("|");
const DESTRUCTIVE_VERB_UC_ALT = DESTRUCTIVE_VERB_STEMS
	.map((v) => nonNull(v[0]).toUpperCase() + v.slice(1))
	.join("|");

// Word-boundary form (case-insensitive). Catches:
//   - start-of-identifier verbs: `deleteUser`, `dropTable`, `purgeAll`
//   - all-caps and mixed: `DELETE`, `Delete`, `DropDatabase`
// Does NOT catch lower→upper camelCase mid-identifier (`volumeDelete`),
// because there is no `\b` between two word chars (handled by
// VERB_CAMEL_CASE below). Also does NOT catch snake_case mid-identifier
// (`volume_delete`) because `_` is a word char so `\b` doesn't fire
// between `_` and `delete` — handled by VERB_SNAKE_CASE below.
const VERB_WORD_BOUNDARY = `\\b(?:${DESTRUCTIVE_VERB_LC_ALT})\\w*\\b`;

// camelCase form (case-sensitive — no `i` flag at the regex level for
// patterns using this fragment). Catches `volumeDelete` etc by requiring
// a lowercase letter before an uppercase-first verb. Without case-
// insensitivity so `splurge` doesn't fire on the `purge` substring.
const VERB_CAMEL_CASE = `(?<=[a-z])(?:${DESTRUCTIVE_VERB_UC_ALT})\\w*`;

// snake_case form (case-insensitive at regex flag level). Catches
// `volume_delete`, `project_destroy`, `instance_terminate`, and the
// SCREAMING_SNAKE all-caps variants. Required because `\b` does NOT fire
// between `_` and a word char, so VERB_WORD_BOUNDARY misses these. Uses a
// lookbehind so the leading `_` isn't consumed (keeps the match anchored
// on the verb itself, mirroring how VERB_CAMEL_CASE handles its prefix).
const VERB_SNAKE_CASE = `(?<=_)(?:${DESTRUCTIVE_VERB_LC_ALT})\\w*`;

// HTTP fetch tools — Bash families plus generic shell aliases.
const HTTP_TOOLS = ["Bash", "Shell", "run_command"];

/**
 * Public API — consumed by `rules/builtin-rules.ts` to assemble the full
 * BUILTIN_RULES array exported by `rules-loader.ts`.
 */
export const DESTRUCTIVE_HTTP_RULES: GuardRule[] = [
	// --- REST DELETE via curl / wget / xh / httpie ---
	{
		id: "builtin-curl-rest-delete",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: HTTP_TOOLS,
		action: "ask",
		patterns: [
			{
				field: "command",
				regex:
					"\\b(curl|wget|xh|http|httpie)\\b[^|;&]*?(-X(\\s+|=)?\"?DELETE\"?|--request(\\s+|=)?\"?DELETE\"?|--method(\\s+|=)?\"?DELETE\"?|-XDELETE)\\b",
				flags: "i",
			},
		],
		reason:
			"This command issues an HTTP DELETE against a remote endpoint. " +
			"DELETE requests are typically irreversible — they may remove production data, " +
			"infrastructure, or user records depending on the API.",
		suggestion:
			"Confirm: (1) you intended this exact endpoint, (2) the credential is scoped to " +
			"the right environment, (3) the resource id is correct, and (4) you have a recent " +
			"backup of any data that can't be recreated.",
		severity: "critical",
		category: "destructive-http",
	},
	{
		id: "builtin-curl-rest-overwrite",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: HTTP_TOOLS,
		action: "ask",
		// Two patterns because curl flags are order-independent on the command
		// line. A single sequential regex anchored on `-X PUT ... -d` would
		// miss `curl -d 'body' -X PUT https://...` even though the call has
		// the same destructive shape. Pattern OR-logic within a rule means
		// either firing matches — equivalent to a single regex with two
		// lookaheads but easier to read.
		patterns: [
			// Method flag first, then body
			{
				field: "command",
				regex:
					"\\bcurl\\b[^|;&]*?(-X(\\s+|=)?\"?(PUT|PATCH)\"?|--request(\\s+|=)?\"?(PUT|PATCH)\"?)\\b[^|;&]*?(-d\\b|--data\\b|--data-raw\\b|--data-binary\\b)",
				flags: "i",
			},
			// Body first, then method flag
			{
				field: "command",
				regex:
					"\\bcurl\\b[^|;&]*?(-d\\b|--data\\b|--data-raw\\b|--data-binary\\b)[^|;&]*?(-X(\\s+|=)?\"?(PUT|PATCH)\"?|--request(\\s+|=)?\"?(PUT|PATCH)\"?)\\b",
				flags: "i",
			},
		],
		reason:
			"This command issues an HTTP PUT/PATCH with a request body — " +
			"a state-overwriting operation that may replace production data.",
		suggestion:
			"If this is a config/state update against production, consider the rollback path. " +
			"For dev/staging, you can safely approve.",
		severity: "high",
		category: "destructive-http",
	},

	// --- GraphQL mutations carrying destructive verbs ---
	//
	// Three patterns per "shape" because identifier conventions in GraphQL
	// vary across vendors:
	//   - lowercase/PascalCase at a `\b` boundary (`delete`, `Delete`)
	//   - camelCase mid-identifier (`volumeDelete`) — `\b` doesn't fire
	//     between two word chars, so we need a case-sensitive lookbehind
	//   - snake_case (`volume_delete`, `project_destroy`) — `\b` doesn't
	//     fire between `_` and a word char either, so we need a separate
	//     `(?<=_)` lookbehind. Without this third pattern, snake_case verbs
	//     bypassed the gate entirely.
	// Pattern OR-logic within a rule means any single firing matches.
	{
		id: "builtin-graphql-destructive-mutation",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: HTTP_TOOLS,
		action: "ask",
		patterns: [
			// curl + mutation + lowercase verb at word boundary (case-insensitive)
			{
				field: "command",
				regex: `\\bcurl\\b[^|;&]*?\\bmutation\\b[\\s\\S]{0,400}?${VERB_WORD_BOUNDARY}`,
				flags: "i",
			},
			// curl + mutation + camelCase verb (case-sensitive)
			{
				field: "command",
				regex: `\\bcurl\\b[^|;&]*?\\bmutation\\b[\\s\\S]{0,400}?${VERB_CAMEL_CASE}`,
				flags: "",
			},
			// curl + mutation + snake_case verb (case-insensitive)
			{
				field: "command",
				regex: `\\bcurl\\b[^|;&]*?\\bmutation\\b[\\s\\S]{0,400}?${VERB_SNAKE_CASE}`,
				flags: "i",
			},
			// wget/xh/http variants — lowercase verbs
			{
				field: "command",
				regex: `\\b(wget|xh|http|httpie)\\b[^|;&]*?\\bmutation\\b[\\s\\S]{0,400}?${VERB_WORD_BOUNDARY}`,
				flags: "i",
			},
			// wget/xh/http variants — camelCase verbs
			{
				field: "command",
				regex: `\\b(wget|xh|http|httpie)\\b[^|;&]*?\\bmutation\\b[\\s\\S]{0,400}?${VERB_CAMEL_CASE}`,
				flags: "",
			},
			// wget/xh/http variants — snake_case verbs
			{
				field: "command",
				regex: `\\b(wget|xh|http|httpie)\\b[^|;&]*?\\bmutation\\b[\\s\\S]{0,400}?${VERB_SNAKE_CASE}`,
				flags: "i",
			},
			// --data/-d/--data-raw/--data-binary form — lowercase verbs
			{
				field: "command",
				regex: `(?:-d|--data(?:-raw|-binary)?)\\s+["'][\\s\\S]*?\\bmutation\\b[\\s\\S]{0,400}?${VERB_WORD_BOUNDARY}`,
				flags: "i",
			},
			// --data/-d/--data-raw/--data-binary form — camelCase verbs
			{
				field: "command",
				regex: `(?:-d|--data(?:-raw|-binary)?)\\s+["'][\\s\\S]*?\\bmutation\\b[\\s\\S]{0,400}?${VERB_CAMEL_CASE}`,
				flags: "",
			},
			// --data/-d/--data-raw/--data-binary form — snake_case verbs
			{
				field: "command",
				regex: `(?:-d|--data(?:-raw|-binary)?)\\s+["'][\\s\\S]*?\\bmutation\\b[\\s\\S]{0,400}?${VERB_SNAKE_CASE}`,
				flags: "i",
			},
		],
		reason:
			"This command carries a GraphQL mutation containing a destructive verb " +
			"(delete/destroy/drop/truncate/wipe/purge/remove/terminate/...). GraphQL " +
			"mutations have no built-in confirmation step — once submitted with a valid " +
			"token, the operation is final. This is the exact shape that wiped " +
			"production data via Railway's volumeDelete in 2026-04.",
		suggestion:
			"Verify: (1) the mutation name and arguments match what you intended, " +
			"(2) the resource id is from the correct environment, (3) the token is scoped " +
			"to staging/dev rather than production, (4) you have a recent backup. If you " +
			"need this in a script, make the destructive operation a separate, " +
			"interactively-approved step rather than running it inline.",
		severity: "critical",
		category: "destructive-http",
	},

	// --- fetch() destructive calls inside Bash one-liners ---
	{
		id: "builtin-node-fetch-destructive",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: HTTP_TOOLS,
		action: "ask",
		patterns: [
			{
				field: "command",
				regex:
					"\\b(node|deno|bun)\\b[^|;&]*?-e\\b[\\s\\S]*?\\bfetch\\s*\\([\\s\\S]*?method\\s*:\\s*[\"']DELETE[\"']",
				flags: "i",
			},
		],
		reason:
			"This command runs a one-off Node/Deno/Bun script that issues an HTTP DELETE " +
			"via fetch(). One-liner destructive calls bypass code review and any " +
			"in-app confirmation flows.",
		suggestion:
			"If this is a deliberate cleanup, consider running it as a checked-in script " +
			"under version control rather than as an inline -e argument.",
		severity: "critical",
		category: "destructive-http",
	},

	// --- WebFetch tool with destructive intent in URL path ---
	{
		id: "builtin-webfetch-destructive-url",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["WebFetch"],
		action: "ask",
		patterns: [
			{
				field: "url",
				regex: "/(?:delete|destroy|drop|truncate|wipe|purge|remove|terminate)(?:-all|_all)?(?:/|$|\\?)",
				flags: "i",
			},
		],
		reason:
			"The WebFetch URL contains a destructive-looking path segment. Even though " +
			"WebFetch is documented as read-only, some endpoints execute server-side " +
			"actions on GET (anti-pattern but real).",
		suggestion: "Verify the endpoint is genuinely read-only before approving.",
		severity: "high",
		category: "destructive-http",
	},
];
