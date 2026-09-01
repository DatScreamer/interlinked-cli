// ===========================================
// guard-rules-write — merge-preserving writer for .interlinked/guard-rules.json
// ===========================================
// One place for "apply this partial config without clobbering the rest".
// Consumers: `interlinked mode` (preset guard_overrides), the setup wizard's
// scope step, and anything else that owns a SECTION of the shared config but
// must never rewrite the whole file. Deep-merges plain objects; scalars and
// arrays REPLACE (an array is a policy statement, not an accumulator).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";

export interface GuardRulesWriteResult {
	ok: boolean;
	path: string;
	/** Set when ok=false: why the write was refused (existing file preserved). */
	error?: string;
}

function deepMerge(base: JsonObject, patch: JsonObject): JsonObject {
	const out: JsonObject = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		const prior = out[key];
		if (isJsonObject(prior) && isJsonObject(value)) {
			out[key] = deepMerge(prior, value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Which config tier the merge targets. "team" = the committed
 *  guard-rules.json; "local" = the gitignored personal overrides file. Added
 *  2026-08-30: `interlinked mode --local` wrote its check-policy half to the
 *  local file but its guard posture to the SHARED file — a personal mode
 *  switch silently edited committed team policy. */
export type GuardRulesWriteTarget = "team" | "local";

/** Merge `patch` into the targeted guard-rules file under `cwd`, creating
 *  the file (and directory) when absent. A malformed existing file is left
 *  byte-identical and reported as a failure — silently replacing a corrupt
 *  config would destroy whatever the corruption was hiding. */
export function mergeIntoGuardRules(
	cwd: string,
	patch: JsonObject,
	target: GuardRulesWriteTarget = "team",
): GuardRulesWriteResult {
	const path = join(
		cwd,
		".interlinked",
		target === "local" ? "guard-rules.local.json" : "guard-rules.json",
	);
	let existing: JsonObject = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
			if (!isJsonObject(parsed)) {
				return { ok: false, path, error: "existing guard-rules.json is not a JSON object" };
			}
			existing = parsed;
		} catch (err) {
			return {
				ok: false,
				path,
				error: `existing guard-rules.json is malformed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}
	const merged = deepMerge(existing, patch);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
	return { ok: true, path };
}
