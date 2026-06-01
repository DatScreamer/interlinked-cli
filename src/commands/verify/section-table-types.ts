// ===========================================
// Section-table shared types
// ===========================================
// Type home for the declarative code-quality section table. Lives apart from
// `./section-table.ts` so the per-group fragment files can import the type
// without depending on the module that composes them.

import type { CodeQualityResults } from "./tool-results-types.js";

export interface SectionSpec {
	label: string;
	key: keyof CodeQualityResults;
	skipId?: string;
	noun: string;
	passLabel: string;
	color: string;
}
