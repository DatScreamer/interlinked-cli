// ===========================================
// Built-in Rules — Aggregated Entry Point
// ===========================================
// Combines the category-split builtin rule tables into the single
// `BUILTIN_RULES` array that `rules-loader.ts` consumes. Splitting
// by category keeps each source file under the file-size threshold
// and makes it easier to audit / extend a specific domain.

import type { GuardRule } from "../types.js";
import { DATABASE_AND_CLOUD_RULES } from "./builtin-rules-database.js";
import { DESTRUCTIVE_HTTP_RULES } from "./builtin-rules-destructive-http.js";
import { DESTRUCTIVE_V1_EXTRA_RULES } from "./builtin-rules-extras.js";
import { LANGUAGE_DESTRUCTIVE_RULES } from "./builtin-rules-language.js";
import { MCP_DESTRUCTIVE_RULES } from "./builtin-rules-mcp.js";
import { PROCESS_AND_FILESYSTEM_RULES } from "./builtin-rules-processes.js";
import { RAILWAY_RULES } from "./builtin-rules-railway.js";
import { RESOURCE_BOMB_RULES } from "./builtin-rules-resource-bombs.js";
import { SECURITY_AND_SAFETY_RULES } from "./builtin-rules-security.js";

/**
 * Public API — consumed by `rules-loader.ts` and by tests
 * (`__tests__/docs-freshness.test.ts`, etc.). Re-exported from
 * `rules-loader.ts` as the canonical `BUILTIN_RULES` constant.
 *
 * Ordering note: more specific rule families (Railway) must come BEFORE
 * the generic catch-all destructive-HTTP family so the more informative
 * reason wins when both match. The evaluator stops at the first matching
 * rule per phase/tool, so order is observable.
 */
export const BUILTIN_RULES: GuardRule[] = [
	...PROCESS_AND_FILESYSTEM_RULES,
	...RESOURCE_BOMB_RULES,
	...DATABASE_AND_CLOUD_RULES,
	...RAILWAY_RULES,
	// Plan 02 destructive-command extras (DCG ports). Placed AFTER
	// RAILWAY_RULES so vendor-specific guards still win, and BEFORE
	// MCP_DESTRUCTIVE_RULES / DESTRUCTIVE_HTTP_RULES so these refined
	// command-shape rules trump the generic catch-all that follow.
	...DESTRUCTIVE_V1_EXTRA_RULES,
	...MCP_DESTRUCTIVE_RULES,
	...DESTRUCTIVE_HTTP_RULES,
	...LANGUAGE_DESTRUCTIVE_RULES,
	...SECURITY_AND_SAFETY_RULES,
];
