// ===========================================
// Per-edit mutation — runner endpoint configuration (CLI / ad hoc measurement)
// ===========================================
// Extracted out of measure.ts (2026-08-10, over the line cap) — same reason
// and shape as manifest-heal.ts's extraction from manifest.ts. Resolves the
// cloud mutation runner's URL(s) + auth token straight from the gitignored
// local rules file, independent of the daemon's own config-loading pipeline
// (`rules-loader.ts` → `ctx.rules.per_edit_mutation`, consumed by `gate.ts` /
// `pre-tool-coverage-gates.ts`): this reader is for CLI/script callers
// (`interlinked mutation measure`, the sweep command) that run OUTSIDE the
// daemon and need the SAME config file read directly — mirrors
// `scratch/measure-file.mts`'s original ad hoc reader.

import { join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import type { PerEditMutationConfig } from "./gate.js";

export interface ConfiguredEndpoints {
	endpoints: string[];
	token?: string;
}

/**
 * Validate + construct the subset of {@link PerEditMutationConfig} this
 * reader needs from a parsed `guard-rules.local.json`. Each field is checked
 * independently so one malformed key never disqualifies its neighbours.
 *
 * Replaces an unchecked `JSON.parse(raw) as {...}` cast that trusted the JSON
 * author to have written `runner_urls` as an actual array. That trust was
 * unsound two different ways once `runner_urls` is spread a few lines below:
 * a STRING value spreads into one bogus single-character endpoint per
 * character (silent, no error — `"oops"` becomes `["o","o","p","s"]`), and a
 * non-iterable value (e.g. a number) throws, which the caller's surrounding
 * try/catch turns into `{endpoints: []}` — discarding an otherwise-valid
 * `runner_url` right along with the malformed field.
 */
function parsePerEditMutationConfig(
	value: unknown,
): Pick<PerEditMutationConfig, "runner_url" | "runner_urls" | "token"> {
	if (!isJsonObject(value) || !isJsonObject(value.per_edit_mutation)) return {};
	const p = value.per_edit_mutation;
	const out: Pick<PerEditMutationConfig, "runner_url" | "runner_urls" | "token"> = {};
	if (typeof p.runner_url === "string") out.runner_url = p.runner_url;
	if (Array.isArray(p.runner_urls)) out.runner_urls = p.runner_urls.filter((u): u is string => typeof u === "string");
	if (typeof p.token === "string") out.token = p.token;
	return out;
}

/**
 * Runner topology + auth token from the gitignored local rules — the ONE
 * source of truth per repo (mirrors `scratch/measure-file.mts`'s ad hoc
 * reader, now a first-class, unit-testable function instead of a copy living
 * only in a throwaway script).
 */
export function configuredRunnerEndpoints(
	cwd: string,
	readFile: (path: string) => string | null,
): ConfiguredEndpoints {
	const raw = readFile(join(cwd, ".interlinked", "guard-rules.local.json"));
	if (raw === null) return { endpoints: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { endpoints: [] };
	}
	const m = parsePerEditMutationConfig(parsed);
	const endpoints = [m.runner_url, ...(m.runner_urls ?? [])].filter(
		(u): u is string => typeof u === "string" && u.length > 0,
	);
	return m.token ? { endpoints, token: m.token } : { endpoints };
}

/** `per_edit_mutation.max_test_scope` from either rules file (local wins),
 *  validated to a positive finite number; undefined ⇒ the shipped default.
 *  Same CLI-side reader stance as {@link configuredRunnerEndpoints}: this is
 *  for callers running OUTSIDE the daemon's config pipeline. */
export function configuredMaxTestScope(
	cwd: string,
	readFile: (path: string) => string | null,
): number | undefined {
	for (const name of ["guard-rules.local.json", "guard-rules.json"]) {
		const raw = readFile(join(cwd, ".interlinked", name));
		if (raw === null) continue;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!isJsonObject(parsed) || !isJsonObject(parsed.per_edit_mutation)) continue;
			const v = parsed.per_edit_mutation.max_test_scope;
			if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
		} catch (err) {
			void err; // malformed file → fall through to the next source / default
		}
	}
	return undefined;
}
