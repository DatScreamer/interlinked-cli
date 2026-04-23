// ===========================================
// Adapter registry — dispatcher + factory for the five supported runners
// ===========================================

import type { ClassifierOverrides } from "../tool-class-classifier.js";
import type { RunnerId } from "../unified-event.js";
import { createClaudeCodeAdapter } from "./claude-code.js";
import { createCodexAdapter } from "./codex.js";
import { createCopilotCliAdapter } from "./copilot-cli.js";
import { createCursorAdapter } from "./cursor.js";
import { createGeminiCliAdapter } from "./gemini-cli.js";
import type { RunnerAdapter } from "./types.js";

export interface AdapterRegistryOptions {
	overrides?: ClassifierOverrides;
}

/** Build the full set of adapters, sharing classifier overrides. */
export function buildAllAdapters(opts: AdapterRegistryOptions = {}): RunnerAdapter[] {
	return [
		createClaudeCodeAdapter({ overrides: opts.overrides }),
		createCopilotCliAdapter({ overrides: opts.overrides }),
		createCursorAdapter({ overrides: opts.overrides }),
		createGeminiCliAdapter({ overrides: opts.overrides }),
		createCodexAdapter({ overrides: opts.overrides }),
	];
}

/** Detect which adapter the current process environment best matches. The
 *  first adapter whose `detectFromEnv` returns true wins. Stable ordering:
 *  claude-code → copilot-cli → cursor → gemini-cli → codex. */
export function detectAdapter(
	env: NodeJS.ProcessEnv,
	adapters: RunnerAdapter[] = buildAllAdapters(),
): RunnerAdapter | null {
	for (const adapter of adapters) {
		if (adapter.detectFromEnv(env)) return adapter;
	}
	return null;
}

/** Look up an adapter by id. Returns null if not found. */
export function getAdapter(
	id: RunnerId,
	adapters: RunnerAdapter[] = buildAllAdapters(),
): RunnerAdapter | null {
	return adapters.find((a) => a.id === id) ?? null;
}

export { createClaudeCodeAdapter } from "./claude-code.js";
export { createCodexAdapter } from "./codex.js";
export { createCopilotCliAdapter } from "./copilot-cli.js";
export { createCursorAdapter } from "./cursor.js";
export { createGeminiCliAdapter } from "./gemini-cli.js";
export type {
	AdapterOutput,
	InstallerManifestEntry,
	MergeStrategy,
	RunnerAdapter,
	SettingsFragment,
} from "./types.js";
