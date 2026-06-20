// ===========================================
// Undefined Environment Variable Detection
// ===========================================
// Flags process.env.FOO references whose keys are not declared in the
// project's .env.example / .env.sample / .env.template file.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import type { HarnessEvent, StructuralCheckResult } from "../types.js";
import { readEnvExampleFromDir } from "./env-loader.js";

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Detect process.env.FOO references whose key isn't in .env.example.
 * Diff-aware: when an event.tool_input.new_string is present, only report
 * keys that appear in the new slice, not keys that already existed.
 */
export function checkUndefinedEnvVars(
	filePath: string,
	relPath: string,
	event?: HarnessEvent,
): StructuralCheckResult[] {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}

	// Find all process.env.VAR_NAME references
	const envVarPattern = /\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g;
	const usedVars = new Set<string>();
	let match = envVarPattern.exec(content);
	while (match !== null) {
		usedVars.add(nonNull(match[1]));
		match = envVarPattern.exec(content);
	}

	if (usedVars.size === 0) return [];

	// Diff-aware: only report env vars introduced by this edit
	if (event?.tool_input) {
		const editContent =
			(event.tool_input.new_string as string) || (event.tool_input.content as string) || "";
		if (editContent) {
			const editEnvPattern = /\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g;
			const editVars = new Set<string>();
			let em = editEnvPattern.exec(editContent);
			while (em !== null) {
				editVars.add(nonNull(em[1]));
				em = editEnvPattern.exec(editContent);
			}
			// If the edit doesn't introduce any env var references, skip entirely
			if (editVars.size === 0) return [];
			// Only check vars that appear in the edit. Snapshot the keys
			// before deleting so we never mutate the Set mid-iteration.
			for (const v of [...usedVars]) {
				if (!editVars.has(v)) usedVars.delete(v);
			}
			if (usedVars.size === 0) return [];
		}
	}

	// Find .env.example or .env.sample
	let envExampleVars: Set<string> | null = null;
	let dir = dirname(filePath);
	for (let i = 0; i < 10; i++) {
		envExampleVars = readEnvExampleFromDir(dir);
		if (envExampleVars) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	if (!envExampleVars) return []; // No .env.example found

	// Common standard env vars to skip
	const standardVars = new Set([
		"NODE_ENV",
		"PATH",
		"HOME",
		"USER",
		"SHELL",
		"TERM",
		"CI",
		"PORT",
		"HOST",
		"HOSTNAME",
		"TZ",
		"LANG",
		"LC_ALL",
		"PWD",
		"DEBUG",
		"VERBOSE",
		"LOG_LEVEL",
	]);

	const declared = envExampleVars;
	const undefinedVars = [...usedVars].filter((v) => !declared.has(v) && !standardVars.has(v));

	if (undefinedVars.length === 0) return [];

	return [
		{
			check: "undefined_env_vars",
			severity: "info",
			message: `${relPath} references ${undefinedVars.length} env var(s) not in .env.example: ${undefinedVars.slice(0, 5).join(", ")}${undefinedVars.length > 5 ? ` +${undefinedVars.length - 5} more` : ""}. Add them to .env.example for documentation.`,
			file: filePath,
		},
	];
}
