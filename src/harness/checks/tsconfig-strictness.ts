// tsconfig strictness — warn when high-leverage TypeScript strictness flags are
// missing from a project's tsconfig.json.
//
// Runs at PostToolUse against any `tsconfig*.json` write, and is also surfaced
// in `interlinked verify` (per-file path). The five flags we check are
// deliberate: each is a documented TypeScript option that catches a category
// of real bugs the type system would otherwise let through, and NONE of them
// is implied by `strict: true`. See:
//
//   noUncheckedIndexedAccess     — array/object index access becomes `T | undefined`
//   exactOptionalPropertyTypes   — `{ x?: number }` cannot accept `{ x: undefined }`
//   noImplicitOverride           — subclass method overriding a parent must say `override`
//   noImplicitReturns            — every branch in a function with a declared return must return
//   noFallthroughCasesInSwitch   — switch case bodies must terminate (return/break/throw)
//
// These are all PostToolUse warnings (heuristic-tier — the flags' presence is
// deterministic, but whether a given codebase wants them is a judgment call,
// hence "warning" not "error"). Per project guidance the check ships
// default-gated: the FP rate is the lowest of any taste check (flag is either
// present or absent), and the fix is one line.
//
// Skipped contexts:
//   - `node_modules/**` — third-party configs we don't author.
//   - Composite project root configs that contain only `references` and no
//     `compilerOptions` of their own — those are the "list of subprojects"
//     shape and the strictness lives in the sub-configs.
//
// FP guards:
//   - If `extends` chain is present, walk it and merge `compilerOptions`
//     (later wins) before evaluating which flags are missing. A flag set in
//     the base is treated as present in the derived config.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import type { InlineMatch } from "./shared.js";

/** Required strictness flags + their human-readable rationale. The order
 *  here is the order findings will be reported in, so it's chosen so the
 *  highest-bug-yield flag (`noUncheckedIndexedAccess`) comes first. */
interface FlagSpec {
	flag: string;
	rationale: string;
}

const REQUIRED_STRICTNESS_FLAGS: readonly FlagSpec[] = [
	{
		flag: "noUncheckedIndexedAccess",
		rationale:
			"array/object index access returns `T | undefined`, forcing you to handle the empty case",
	},
	{
		flag: "exactOptionalPropertyTypes",
		rationale:
			"`{ x?: number }` no longer silently accepts `{ x: undefined }` — optional means absent, not present-and-undefined",
	},
	{
		flag: "noImplicitOverride",
		rationale:
			"subclass methods overriding a parent must declare `override`, catching renames that silently break the chain",
	},
	{
		flag: "noImplicitReturns",
		rationale:
			"every code path in a function with a declared return type must return, catching forgotten branches",
	},
	{
		flag: "noFallthroughCasesInSwitch",
		rationale:
			"non-empty switch cases must terminate (return/break/throw), catching forgotten breaks",
	},
] as const;

/** Flags that `strict: true` implies (from the TypeScript docs). NONE of the
 *  five flags above is in this set — `strict` does NOT cover them. Listed
 *  here defensively so the merge logic stays correct if we ever extend the
 *  check to a flag the umbrella does cover. Kept in sync with the equivalent
 *  set in `evaluator/config-loosening-gate.ts::STRICT_IMPLIES`. */
const STRICT_IMPLIES: ReadonlySet<string> = new Set([
	"noImplicitAny",
	"strictNullChecks",
	"strictFunctionTypes",
	"strictBindCallApply",
	"strictPropertyInitialization",
	"noImplicitThis",
	"alwaysStrict",
	"useUnknownInCatchVariables",
]);

/** Tolerant JSONC parse — strips `//` line comments, `/* ... *​/` block
 *  comments, and trailing commas before invoking `JSON.parse`. Mirrors the
 *  parser shape in `evaluator/config-loosening-gate.ts::safeJsonParse` so
 *  the two helpers behave identically on the same files. Returns null on
 *  any parse error.
 *
 *  We deliberately do not pull in `jsonc-parser` as a runtime dep — the
 *  CLI ships with `commander` only, and a one-screen tolerant parser is
 *  sufficient for the tsconfig shapes that exist in the wild. */
function safeJsoncParse(text: string): JsonObject | null {
	if (!text) return null;
	let parsed: unknown;
	try {
		const cleaned = text
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/,(\s*[}\]])/g, "$1");
		parsed = JSON.parse(cleaned);
	} catch {
		return null;
	}
	if (parsed instanceof Object && !Array.isArray(parsed)) {
		return parsed as JsonObject;
	}
	return null;
}

function safeReadJsonc(path: string): JsonObject | null {
	if (!existsSync(path)) return null;
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return null;
	}
	return safeJsoncParse(raw);
}

/** Get `compilerOptions` as a JsonObject (or null if absent / not an object). */
function getCompilerOptions(cfg: JsonObject | null): JsonObject | null {
	if (!cfg) return null;
	const co = cfg.compilerOptions;
	if (co instanceof Object && !Array.isArray(co)) {
		return co as JsonObject;
	}
	return null;
}

/** Resolve the path that `extends` refers to. Mirrors the subset of the
 *  TypeScript extends-resolution rules we need: bare `./foo` and `../foo`
 *  resolve relative to the current config's dir, with `.json` appended if
 *  missing. Package-name references (`@my-org/tsconfig-base`) are not
 *  resolved — we return null, which causes the merge to stop at this
 *  level (fail-open: we report the flag as missing only if the current
 *  level also lacks it). */
function resolveExtendsPath(baseConfigPath: string, extendsRef: string): string | null {
	// Only relative paths are followed.
	if (!extendsRef.startsWith(".") && !extendsRef.startsWith("/")) return null;
	const baseDir = dirname(baseConfigPath);
	const target = isAbsolute(extendsRef) ? extendsRef : resolve(baseDir, extendsRef);
	if (target.endsWith(".json")) return target;
	// TypeScript allows the `.json` suffix to be omitted.
	const withExt = `${target}.json`;
	return withExt;
}

/** Walk the `extends` chain starting at `cfg`, accumulating compilerOptions
 *  from base → derived (so the derived value wins on conflict). Returns the
 *  merged compilerOptions. Caps recursion at 8 hops as a defense against
 *  pathological cycles. */
function mergeExtendsChain(
	cfg: JsonObject,
	filePath: string,
	depth = 0,
	seen: Set<string> = new Set(),
): JsonObject {
	const MAX_DEPTH = 8;
	if (depth >= MAX_DEPTH) return getCompilerOptions(cfg) ?? {};
	// Cycle guard: tsconfig cycles are valid filesystem shapes (symlinks)
	// but meaningless semantically.
	const absPath = isAbsolute(filePath) ? filePath : resolve(filePath);
	if (seen.has(absPath)) return getCompilerOptions(cfg) ?? {};
	seen.add(absPath);

	const ownCompiler = getCompilerOptions(cfg) ?? {};

	const extendsField = cfg.extends;
	if (typeof extendsField !== "string" || extendsField.length === 0) {
		return ownCompiler;
	}
	const basePath = resolveExtendsPath(filePath, extendsField);
	if (basePath === null) return ownCompiler;

	const baseCfg = safeReadJsonc(basePath);
	if (!baseCfg) return ownCompiler;

	const baseMerged = mergeExtendsChain(baseCfg, basePath, depth + 1, seen);
	// Derived wins on conflict: own keys override base keys.
	return { ...baseMerged, ...ownCompiler };
}

/** True iff the file is `tsconfig.json` or `tsconfig.<anything>.json`. */
function isTsconfigBasename(filePath: string): boolean {
	const base = basename(filePath);
	return /^tsconfig(?:\.[^/\\]+)?\.json$/i.test(base);
}

/** True iff the path lives under any `node_modules/` segment. */
function isInsideNodeModules(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return normalized.includes("/node_modules/") || normalized.startsWith("node_modules/");
}

/** Best-effort line lookup for `"compilerOptions"` — used so the finding's
 *  line number points the agent at the block where the flag should be added.
 *  Falls back to line 1 when the section header isn't found in the post-edit
 *  text (e.g. extends-only config). */
function findCompilerOptionsLine(content: string): number {
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes('"compilerOptions"')) return i + 1;
	}
	return 1;
}

/**
 * Public API — consumed by the check registry (`entries-warnings.ts`) and
 * the verify file-checks dispatch (`commands/verify/file-checks.ts`).
 *
 * Returns one finding per missing strictness flag, in the order declared in
 * `REQUIRED_STRICTNESS_FLAGS`. Empty array means the tsconfig has all five
 * flags effectively enabled (either explicitly or via an `extends` chain).
 */
export function checkTsconfigStrictness(content: string, filePath: string): InlineMatch[] {
	if (!isTsconfigBasename(filePath)) return [];
	if (isInsideNodeModules(filePath)) return [];

	const cfg = safeJsoncParse(content);
	if (!cfg) return [];

	// Merge `extends` chain so a flag set in the base counts as present here.
	// `mergeExtendsChain` is given the parsed root config and walks upward;
	// the result is the effective compilerOptions object after inheritance.
	const merged = mergeExtendsChain(cfg, filePath);

	// Composite project root configs that contain only `references` (or
	// `files`) and have no `compilerOptions` ANYWHERE in the inheritance
	// chain are project-list configs — strictness lives in the per-project
	// tsconfigs they reference, not here. Skipping silences a class of
	// guaranteed FPs.
	const ownCompiler = getCompilerOptions(cfg);
	const ownHasCompilerOptions = ownCompiler !== null && Object.keys(ownCompiler).length > 0;
	const inheritedHasCompilerOptions = Object.keys(merged).length > 0;
	const hasReferences = Array.isArray(cfg.references) && (cfg.references as unknown[]).length > 0;
	if (!ownHasCompilerOptions && !inheritedHasCompilerOptions && hasReferences) {
		return [];
	}

	const line = findCompilerOptionsLine(content);
	const findings: InlineMatch[] = [];

	for (const spec of REQUIRED_STRICTNESS_FLAGS) {
		// A flag is "enabled" only when its effective value is literal `true`.
		// `strict: true` does NOT imply any of the five flags this check
		// targets (see `STRICT_IMPLIES` above), so the umbrella never
		// rescues a missing flag here. Listing STRICT_IMPLIES still keeps
		// the merge logic honest: if a future flag added to this list IS
		// covered by `strict`, the umbrella will be respected.
		const value = merged[spec.flag];
		if (value === true) continue;
		// If the umbrella `strict: true` is set AND the flag IS one that
		// strict implies, treat it as enabled. (None of the current five
		// hit this branch — kept here so adding a new flag doesn't silently
		// over-fire.)
		if (STRICT_IMPLIES.has(spec.flag) && merged.strict === true && value !== false) {
			continue;
		}
		findings.push({
			line,
			text:
				`[tsconfig_strictness] \`compilerOptions.${spec.flag}\` is not enabled. ` +
				`Add \`"${spec.flag}": true\` — ${spec.rationale}. ` +
				`(Not covered by \`strict: true\`.)`,
		});
	}

	return findings;
}
