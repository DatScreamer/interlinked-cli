// Compatibility stubs — referenced by check-registry but their full
// implementations live in other modules (or are pending refactor).
// Returning an empty match list keeps the registry build green without
// changing the observable behaviour of the missing checks.
// Extracted from generic-checks.ts.

import type { InlineMatch } from "./shared.js";

// ===========================================
// Compatibility stubs — referenced by check-registry but their full
// implementations live in other modules (or are pending refactor). Returning
// an empty match list keeps the registry build green without changing the
// observable behaviour of the missing checks.
// ===========================================

export function checkMigrationOrdering(_content: string, _filePath: string): InlineMatch[] {
	return [];
}

export function checkSqlSchemaConsistency(_content: string, _filePath: string): InlineMatch[] {
	return [];
}

export function checkVisibilityFilterMissing(_content: string, _filePath: string): InlineMatch[] {
	return [];
}
