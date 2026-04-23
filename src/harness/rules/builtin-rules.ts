// ===========================================
// Built-in Rules — Aggregated Entry Point
// ===========================================
// Combines the category-split builtin rule tables into the single
// `BUILTIN_RULES` array that `rules-loader.ts` consumes. Splitting
// by category keeps each source file under the file-size threshold
// and makes it easier to audit / extend a specific domain.

import type { GuardRule } from "../types.js";
import { DATABASE_AND_CLOUD_RULES } from "./builtin-rules-database.js";
import { LANGUAGE_DESTRUCTIVE_RULES } from "./builtin-rules-language.js";
import { PROCESS_AND_FILESYSTEM_RULES } from "./builtin-rules-processes.js";
import { SECURITY_AND_SAFETY_RULES } from "./builtin-rules-security.js";

/**
 * Public API — consumed by `rules-loader.ts` and by tests
 * (`__tests__/docs-freshness.test.ts`, etc.). Re-exported from
 * `rules-loader.ts` as the canonical `BUILTIN_RULES` constant.
 */
export const BUILTIN_RULES: GuardRule[] = [
	...PROCESS_AND_FILESYSTEM_RULES,
	...DATABASE_AND_CLOUD_RULES,
	...LANGUAGE_DESTRUCTIVE_RULES,
	...SECURITY_AND_SAFETY_RULES,
];
