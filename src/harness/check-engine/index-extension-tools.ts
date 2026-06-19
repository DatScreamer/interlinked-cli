// interlinked-tdd: exempt
// ===========================================
// Check Engine — extension → tool dispatch
// ===========================================
// Extracted from check-engine/index.ts (leaf cluster, no module-private
// state). Declarative extension→tool mapping so adding a language is a
// one-row edit (and so `getToolsForExtension` stays a flat lookup, not a
// switch the cyclomatic ratchet caps).

import { buildExtensionTools } from "./tool-catalog.js";
import type { ToolId } from "./types.js";

// Extension → tool list. Declarative so adding a language is a one-row edit
// (and so `getToolsForExtension` stays a flat lookup, not a switch the
// cyclomatic ratchet caps). lizard rides alongside the per-language
// compiler/linter for the languages without a dedicated complexity gate.
const EXTENSION_TOOLS: Readonly<Record<string, readonly ToolId[]>> = buildExtensionTools();

export function getToolsForExtension(ext: string): ToolId[] {
	const tools = EXTENSION_TOOLS[ext];
	return tools ? [...tools] : [];
}
