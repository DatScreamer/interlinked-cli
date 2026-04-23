// ===========================================
// Generic Artifact Structure V1 — Schema Validation
// ===========================================
// Validates structure.json and all artifact files per spec sections 7–9.
// Unknown keys are invalid at every level for committed structure files.

import { existsSync } from "node:fs";
import { posix, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import type { ArtifactFileKey, StructureConfig, StructureMode } from "./types.js";
import {
	DEFAULT_ADOPTION_THRESHOLDS,
	DEFAULT_BUILTINS,
	ENV_KEY_PATTERN,
	LOCAL_ID_PATTERN,
	MODE_DEFAULTS,
	VALID_ARTIFACT_KINDS,
	VALID_DOC_KINDS,
	VALID_MODES,
	VALID_STABILITY,
	VALID_SYMBOL_KINDS,
	VALID_TEST_KINDS,
} from "./types.js";

// -------------------------------------------
// Validation Result
// -------------------------------------------

export interface ValidationError {
	path: string;
	message: string;
}

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
}

function ok(): ValidationResult {
	return { valid: true, errors: [] };
}

function fail(errors: ValidationError[]): ValidationResult {
	return { valid: false, errors };
}

function err(path: string, message: string): ValidationError {
	return { path, message };
}

// -------------------------------------------
// Helpers
// -------------------------------------------

function includes<T>(arr: readonly T[], val: unknown): val is T {
	return (arr as readonly unknown[]).includes(val);
}

function isRepoRelativePath(p: string): boolean {
	return !p.startsWith("/") && !p.startsWith("../") && p === posix.normalize(p);
}

function hasNoDuplicates(arr: string[]): boolean {
	return new Set(arr).size === arr.length;
}

function checkUnknownKeys(obj: JsonObject, allowed: string[], path: string): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) {
			errors.push(err(`${path}.${key}`, `Unknown key "${key}"`));
		}
	}
	return errors;
}

function validateLocalId(id: string, path: string): ValidationError[] {
	if (!LOCAL_ID_PATTERN.test(id)) {
		return [err(path, `Invalid local ID "${id}" — must match ${LOCAL_ID_PATTERN.source}`)];
	}
	if (id.includes(":")) {
		return [err(path, `Local ID "${id}" must not contain ":"`)];
	}
	return [];
}

function validateCoversArray(covers: unknown[], path: string): ValidationError[] {
	const errors: ValidationError[] = [];
	if (!Array.isArray(covers)) {
		errors.push(err(path, "covers must be an array"));
		return errors;
	}
	for (let i = 0; i < covers.length; i++) {
		const c = covers[i] as JsonObject;
		const cp = `${path}[${i}]`;
		errors.push(...checkUnknownKeys(c, ["artifact_kind", "artifact_id"], cp));
		if (
			typeof c.artifact_kind !== "string" ||
			!includes(VALID_ARTIFACT_KINDS, c.artifact_kind)
		) {
			errors.push(
				err(`${cp}.artifact_kind`, `Must be one of: ${VALID_ARTIFACT_KINDS.join(", ")}`),
			);
		}
		if (typeof c.artifact_id !== "string" || c.artifact_id.length === 0) {
			errors.push(err(`${cp}.artifact_id`, "Must be a non-empty string"));
		}
	}
	return errors;
}

function validateStringArray(arr: unknown, path: string): ValidationError[] {
	if (!Array.isArray(arr)) return [err(path, "Must be an array")];
	const errors: ValidationError[] = [];
	for (let i = 0; i < arr.length; i++) {
		if (typeof arr[i] !== "string") {
			errors.push(err(`${path}[${i}]`, "Must be a string"));
		}
	}
	if (!hasNoDuplicates(arr.filter((x): x is string => typeof x === "string"))) {
		errors.push(err(path, "Array must not contain duplicates"));
	}
	return errors;
}

// -------------------------------------------
// structure.json Validation
// -------------------------------------------

const STRUCTURE_ROOT_KEYS = [
	"version",
	"mode",
	"artifacts",
	"verify",
	"posttooluse",
	"adoption",
	"builtins",
];
const VERIFY_KEYS = [
	"fail_on_deterministic",
	"fail_on_invalid_structure",
	"fail_on_partial",
	"fail_on_heuristic",
];
const POSTTOOLUSE_KEYS = ["emit_deterministic", "emit_partial", "emit_heuristic", "max_heuristics"];
const ADOPTION_KEYS = ["coverage_thresholds"];
const BUILTINS_KEYS = [
	"public_symbol_companions",
	"env_key_companions",
	"config_key_companions",
	"layer_boundary_violations",
	"glossary_residue",
	"package_boundary_violations",
];
const ARTIFACT_FILE_KEYS: ArtifactFileKey[] = [
	"public_api",
	"env",
	"config",
	"tests",
	"docs",
	"examples",
	"glossary",
	"layers",
	"packages",
];
const COVERAGE_KEYS = ARTIFACT_FILE_KEYS;

export function validateStructureJson(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors: ValidationError[] = [];

	errors.push(...checkUnknownKeys(obj, STRUCTURE_ROOT_KEYS, "$"));

	// version
	if (obj.version !== 1) {
		errors.push(err("$.version", "Must be 1"));
	}

	// mode
	if (typeof obj.mode !== "string" || !VALID_MODES.includes(obj.mode as StructureMode)) {
		errors.push(err("$.mode", `Must be one of: ${VALID_MODES.join(", ")}`));
	}

	// artifacts
	if (obj.artifacts !== undefined) {
		if (
			typeof obj.artifacts !== "object" ||
			obj.artifacts === null ||
			Array.isArray(obj.artifacts)
		) {
			errors.push(err("$.artifacts", "Must be an object"));
		} else {
			const arts = obj.artifacts as JsonObject;
			errors.push(...checkUnknownKeys(arts, ARTIFACT_FILE_KEYS, "$.artifacts"));
			for (const [key, val] of Object.entries(arts)) {
				if (typeof val !== "string") {
					errors.push(err(`$.artifacts.${key}`, "Must be a string path"));
				} else if (!isRepoRelativePath(val)) {
					errors.push(err(`$.artifacts.${key}`, "Must be a repo-relative POSIX path"));
				}
			}
		}
	}

	// verify
	if (obj.verify !== undefined) {
		if (typeof obj.verify !== "object" || obj.verify === null || Array.isArray(obj.verify)) {
			errors.push(err("$.verify", "Must be an object"));
		} else {
			const v = obj.verify as JsonObject;
			errors.push(...checkUnknownKeys(v, VERIFY_KEYS, "$.verify"));
			for (const k of VERIFY_KEYS) {
				if (k in v && typeof v[k] !== "boolean") {
					errors.push(err(`$.verify.${k}`, "Must be a boolean"));
				}
			}
		}
	}

	// posttooluse
	if (obj.posttooluse !== undefined) {
		if (
			typeof obj.posttooluse !== "object" ||
			obj.posttooluse === null ||
			Array.isArray(obj.posttooluse)
		) {
			errors.push(err("$.posttooluse", "Must be an object"));
		} else {
			const p = obj.posttooluse as JsonObject;
			errors.push(...checkUnknownKeys(p, POSTTOOLUSE_KEYS, "$.posttooluse"));
			for (const k of ["emit_deterministic", "emit_partial", "emit_heuristic"]) {
				if (k in p && typeof p[k] !== "boolean") {
					errors.push(err(`$.posttooluse.${k}`, "Must be a boolean"));
				}
			}
			if (
				"max_heuristics" in p &&
				(typeof p.max_heuristics !== "number" || p.max_heuristics < 0)
			) {
				errors.push(err("$.posttooluse.max_heuristics", "Must be a non-negative number"));
			}
		}
	}

	// adoption
	if (obj.adoption !== undefined) {
		if (
			typeof obj.adoption !== "object" ||
			obj.adoption === null ||
			Array.isArray(obj.adoption)
		) {
			errors.push(err("$.adoption", "Must be an object"));
		} else {
			const a = obj.adoption as JsonObject;
			errors.push(...checkUnknownKeys(a, ADOPTION_KEYS, "$.adoption"));
			if (a.coverage_thresholds !== undefined) {
				if (typeof a.coverage_thresholds !== "object" || a.coverage_thresholds === null) {
					errors.push(err("$.adoption.coverage_thresholds", "Must be an object"));
				} else {
					const ct = a.coverage_thresholds as JsonObject;
					errors.push(
						...checkUnknownKeys(
							ct,
							COVERAGE_KEYS as string[],
							"$.adoption.coverage_thresholds",
						),
					);
					for (const [k, v] of Object.entries(ct)) {
						if (typeof v !== "number" || v < 0 || v > 1) {
							errors.push(
								err(
									`$.adoption.coverage_thresholds.${k}`,
									"Must be a number between 0.0 and 1.0",
								),
							);
						}
					}
				}
			}
		}
	}

	// builtins
	if (obj.builtins !== undefined) {
		if (
			typeof obj.builtins !== "object" ||
			obj.builtins === null ||
			Array.isArray(obj.builtins)
		) {
			errors.push(err("$.builtins", "Must be an object"));
		} else {
			const b = obj.builtins as JsonObject;
			errors.push(...checkUnknownKeys(b, BUILTINS_KEYS, "$.builtins"));
			for (const k of BUILTINS_KEYS) {
				if (k in b && typeof b[k] !== "boolean") {
					errors.push(err(`$.builtins.${k}`, "Must be a boolean"));
				}
			}
		}
	}

	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// Resolve StructureConfig with mode defaults
// -------------------------------------------

export function resolveStructureConfig(data: JsonObject): StructureConfig {
	const mode = (data.mode as StructureMode) || "standard";
	const defaults = MODE_DEFAULTS[mode];

	const verify: StructureConfig["verify"] = {
		...defaults.verify,
		...((data.verify as Partial<StructureConfig["verify"]>) || {}),
	};
	const posttooluse: StructureConfig["posttooluse"] = {
		...defaults.posttooluse,
		...((data.posttooluse as Partial<StructureConfig["posttooluse"]>) || {}),
	};
	const adoption: StructureConfig["adoption"] = {
		coverage_thresholds: {
			...DEFAULT_ADOPTION_THRESHOLDS,
			...((data.adoption as Record<string, Record<string, number>> | undefined)
				?.coverage_thresholds || {}),
		},
	};
	const builtins: StructureConfig["builtins"] = {
		...DEFAULT_BUILTINS,
		...((data.builtins as Partial<StructureConfig["builtins"]>) || {}),
	};

	return {
		version: 1,
		mode,
		artifacts: (data.artifacts as StructureConfig["artifacts"]) || {},
		verify,
		posttooluse,
		adoption,
		builtins,
	};
}

// -------------------------------------------
// Artifact File Validators
// -------------------------------------------

export function validatePublicApiFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors: ValidationError[] = [];
	errors.push(...checkUnknownKeys(obj, ["version", "modules"], "$"));

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (!Array.isArray(obj.modules)) {
		errors.push(err("$.modules", "Must be an array"));
		return fail(errors);
	}

	const moduleIds = new Set<string>();
	for (let i = 0; i < obj.modules.length; i++) {
		const m = obj.modules[i] as JsonObject;
		const mp = `$.modules[${i}]`;
		errors.push(...checkUnknownKeys(m, ["id", "file", "symbols"], mp));

		if (typeof m.id !== "string") {
			errors.push(err(`${mp}.id`, "Must be a string"));
		} else {
			errors.push(...validateLocalId(m.id, `${mp}.id`));
			if (moduleIds.has(m.id)) errors.push(err(`${mp}.id`, `Duplicate module ID "${m.id}"`));
			moduleIds.add(m.id);
		}

		if (typeof m.file !== "string") {
			errors.push(err(`${mp}.file`, "Must be a string"));
		} else if (!isRepoRelativePath(m.file)) {
			errors.push(err(`${mp}.file`, "Must be a repo-relative POSIX path"));
		}

		if (!Array.isArray(m.symbols)) {
			errors.push(err(`${mp}.symbols`, "Must be an array"));
		} else {
			for (let j = 0; j < m.symbols.length; j++) {
				const s = m.symbols[j] as JsonObject;
				const sp = `${mp}.symbols[${j}]`;
				errors.push(
					...checkUnknownKeys(
						s,
						["name", "kind", "stability", "docs", "tests", "examples"],
						sp,
					),
				);

				if (typeof s.name !== "string" || s.name.length === 0) {
					errors.push(err(`${sp}.name`, "Must be a non-empty string"));
				}
				if (!includes(VALID_SYMBOL_KINDS, s.kind)) {
					errors.push(
						err(`${sp}.kind`, `Must be one of: ${VALID_SYMBOL_KINDS.join(", ")}`),
					);
				}
				if (!includes(VALID_STABILITY, s.stability)) {
					errors.push(
						err(`${sp}.stability`, `Must be one of: ${VALID_STABILITY.join(", ")}`),
					);
				}
				errors.push(...validateStringArray(s.docs, `${sp}.docs`));
				errors.push(...validateStringArray(s.tests, `${sp}.tests`));
				errors.push(...validateStringArray(s.examples, `${sp}.examples`));
			}
		}
	}
	return errors.length > 0 ? fail(errors) : ok();
}

export function validateEnvFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors: ValidationError[] = [];
	errors.push(...checkUnknownKeys(obj, ["version", "sources", "keys"], "$"));

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (obj.sources !== undefined) {
		if (typeof obj.sources !== "object" || obj.sources === null || Array.isArray(obj.sources)) {
			errors.push(err("$.sources", "Must be an object"));
		} else {
			const src = obj.sources as JsonObject;
			errors.push(...checkUnknownKeys(src, ["declarations", "defaults"], "$.sources"));
			errors.push(...validateStringArray(src.declarations || [], "$.sources.declarations"));
			errors.push(...validateStringArray(src.defaults || [], "$.sources.defaults"));
		}
	}

	if (!Array.isArray(obj.keys)) {
		errors.push(err("$.keys", "Must be an array"));
		return fail(errors);
	}

	const keyNames = new Set<string>();
	for (let i = 0; i < obj.keys.length; i++) {
		const k = obj.keys[i] as JsonObject;
		const kp = `$.keys[${i}]`;
		errors.push(
			...checkUnknownKeys(
				k,
				["name", "required", "docs", "tests", "examples", "default_sources"],
				kp,
			),
		);

		if (typeof k.name !== "string") {
			errors.push(err(`${kp}.name`, "Must be a string"));
		} else {
			if (!ENV_KEY_PATTERN.test(k.name)) {
				errors.push(err(`${kp}.name`, `Must match ${ENV_KEY_PATTERN.source}`));
			}
			if (keyNames.has(k.name))
				errors.push(err(`${kp}.name`, `Duplicate key name "${k.name}"`));
			keyNames.add(k.name);
		}

		if (typeof k.required !== "boolean")
			errors.push(err(`${kp}.required`, "Must be a boolean"));
		errors.push(...validateStringArray(k.docs || [], `${kp}.docs`));
		errors.push(...validateStringArray(k.tests || [], `${kp}.tests`));
		errors.push(...validateStringArray(k.examples || [], `${kp}.examples`));
		errors.push(...validateStringArray(k.default_sources || [], `${kp}.default_sources`));
	}
	return errors.length > 0 ? fail(errors) : ok();
}

export function validateConfigFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors: ValidationError[] = [];
	errors.push(...checkUnknownKeys(obj, ["version", "roots", "keys"], "$"));

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (Array.isArray(obj.roots)) {
		const rootIds = new Set<string>();
		for (let i = 0; i < obj.roots.length; i++) {
			const r = obj.roots[i] as JsonObject;
			const rp = `$.roots[${i}]`;
			errors.push(...checkUnknownKeys(r, ["id", "file"], rp));
			if (typeof r.id !== "string") errors.push(err(`${rp}.id`, "Must be a string"));
			else {
				errors.push(...validateLocalId(r.id, `${rp}.id`));
				if (rootIds.has(r.id)) errors.push(err(`${rp}.id`, `Duplicate root ID "${r.id}"`));
				rootIds.add(r.id);
			}
			if (typeof r.file !== "string") errors.push(err(`${rp}.file`, "Must be a string"));
			else if (!isRepoRelativePath(r.file))
				errors.push(err(`${rp}.file`, "Must be a repo-relative POSIX path"));
		}
	}

	if (!Array.isArray(obj.keys)) {
		errors.push(err("$.keys", "Must be an array"));
		return fail(errors);
	}

	for (let i = 0; i < obj.keys.length; i++) {
		const k = obj.keys[i] as JsonObject;
		const kp = `$.keys[${i}]`;
		errors.push(
			...checkUnknownKeys(
				k,
				["name", "required", "docs", "tests", "examples", "declared_in"],
				kp,
			),
		);

		if (typeof k.name !== "string" || k.name.length === 0) {
			errors.push(err(`${kp}.name`, "Must be a non-empty string"));
		}
		if (typeof k.required !== "boolean")
			errors.push(err(`${kp}.required`, "Must be a boolean"));
		errors.push(...validateStringArray(k.docs || [], `${kp}.docs`));
		errors.push(...validateStringArray(k.tests || [], `${kp}.tests`));
		errors.push(...validateStringArray(k.examples || [], `${kp}.examples`));
		errors.push(...validateStringArray(k.declared_in || [], `${kp}.declared_in`));
	}
	return errors.length > 0 ? fail(errors) : ok();
}

export function validateTestsFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors: ValidationError[] = [];
	errors.push(...checkUnknownKeys(obj, ["version", "tests"], "$"));

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (!Array.isArray(obj.tests)) {
		errors.push(err("$.tests", "Must be an array"));
		return fail(errors);
	}

	const testIds = new Set<string>();
	for (let i = 0; i < obj.tests.length; i++) {
		const t = obj.tests[i] as JsonObject;
		const tp = `$.tests[${i}]`;
		errors.push(...checkUnknownKeys(t, ["id", "file", "kind", "covers"], tp));

		if (typeof t.id !== "string") errors.push(err(`${tp}.id`, "Must be a string"));
		else {
			errors.push(...validateLocalId(t.id, `${tp}.id`));
			if (testIds.has(t.id)) errors.push(err(`${tp}.id`, `Duplicate test ID "${t.id}"`));
			testIds.add(t.id);
		}
		if (typeof t.file !== "string") errors.push(err(`${tp}.file`, "Must be a string"));
		else if (!isRepoRelativePath(t.file))
			errors.push(err(`${tp}.file`, "Must be a repo-relative POSIX path"));

		if (!includes(VALID_TEST_KINDS, t.kind)) {
			errors.push(err(`${tp}.kind`, `Must be one of: ${VALID_TEST_KINDS.join(", ")}`));
		}
		errors.push(
			...validateCoversArray(Array.isArray(t.covers) ? t.covers : [], `${tp}.covers`),
		);
	}
	return errors.length > 0 ? fail(errors) : ok();
}

export function validateDocsFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors: ValidationError[] = [];
	errors.push(...checkUnknownKeys(obj, ["version", "docs"], "$"));

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (!Array.isArray(obj.docs)) {
		errors.push(err("$.docs", "Must be an array"));
		return fail(errors);
	}

	const docIds = new Set<string>();
	for (let i = 0; i < obj.docs.length; i++) {
		const d = obj.docs[i] as JsonObject;
		const dp = `$.docs[${i}]`;
		errors.push(...checkUnknownKeys(d, ["id", "file", "kind", "covers"], dp));

		if (typeof d.id !== "string") errors.push(err(`${dp}.id`, "Must be a string"));
		else {
			errors.push(...validateLocalId(d.id, `${dp}.id`));
			if (docIds.has(d.id)) errors.push(err(`${dp}.id`, `Duplicate doc ID "${d.id}"`));
			docIds.add(d.id);
		}
		if (typeof d.file !== "string") errors.push(err(`${dp}.file`, "Must be a string"));
		else if (!isRepoRelativePath(d.file))
			errors.push(err(`${dp}.file`, "Must be a repo-relative POSIX path"));

		if (!includes(VALID_DOC_KINDS, d.kind)) {
			errors.push(err(`${dp}.kind`, `Must be one of: ${VALID_DOC_KINDS.join(", ")}`));
		}
		errors.push(
			...validateCoversArray(Array.isArray(d.covers) ? d.covers : [], `${dp}.covers`),
		);
	}
	return errors.length > 0 ? fail(errors) : ok();
}

export function validateExamplesFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors: ValidationError[] = [];
	errors.push(...checkUnknownKeys(obj, ["version", "examples"], "$"));

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (!Array.isArray(obj.examples)) {
		errors.push(err("$.examples", "Must be an array"));
		return fail(errors);
	}

	const exIds = new Set<string>();
	for (let i = 0; i < obj.examples.length; i++) {
		const e = obj.examples[i] as JsonObject;
		const ep = `$.examples[${i}]`;
		errors.push(...checkUnknownKeys(e, ["id", "file", "covers"], ep));

		if (typeof e.id !== "string") errors.push(err(`${ep}.id`, "Must be a string"));
		else {
			errors.push(...validateLocalId(e.id, `${ep}.id`));
			if (exIds.has(e.id)) errors.push(err(`${ep}.id`, `Duplicate example ID "${e.id}"`));
			exIds.add(e.id);
		}
		if (typeof e.file !== "string") errors.push(err(`${ep}.file`, "Must be a string"));
		else if (!isRepoRelativePath(e.file))
			errors.push(err(`${ep}.file`, "Must be a repo-relative POSIX path"));

		errors.push(
			...validateCoversArray(Array.isArray(e.covers) ? e.covers : [], `${ep}.covers`),
		);
	}
	return errors.length > 0 ? fail(errors) : ok();
}

export function validateGlossaryFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors: ValidationError[] = [];
	errors.push(...checkUnknownKeys(obj, ["version", "terms"], "$"));

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (!Array.isArray(obj.terms)) {
		errors.push(err("$.terms", "Must be an array"));
		return fail(errors);
	}

	const termIds = new Set<string>();
	const allCanonicals = new Map<string, string>(); // lowered → owning term id
	for (let i = 0; i < obj.terms.length; i++) {
		const t = obj.terms[i] as JsonObject;
		const tp = `$.terms[${i}]`;
		errors.push(
			...checkUnknownKeys(t, ["id", "canonical", "aliases", "deprecated", "docs"], tp),
		);

		if (typeof t.id !== "string") errors.push(err(`${tp}.id`, "Must be a string"));
		else {
			errors.push(...validateLocalId(t.id, `${tp}.id`));
			if (termIds.has(t.id)) errors.push(err(`${tp}.id`, `Duplicate term ID "${t.id}"`));
			termIds.add(t.id);
		}

		if (typeof t.canonical !== "string" || t.canonical.length === 0) {
			errors.push(err(`${tp}.canonical`, "Must be a non-empty string"));
		} else {
			const lower = t.canonical.toLowerCase();
			if (allCanonicals.has(lower)) {
				errors.push(
					err(
						`${tp}.canonical`,
						`"${t.canonical}" collides with term "${allCanonicals.get(lower)}"`,
					),
				);
			}
			allCanonicals.set(lower, t.id as string);
		}

		errors.push(...validateStringArray(t.aliases || [], `${tp}.aliases`));
		errors.push(...validateStringArray(t.deprecated || [], `${tp}.deprecated`));
		errors.push(...validateStringArray(t.docs || [], `${tp}.docs`));

		// Register aliases and deprecated for collision checking
		for (const alias of (t.aliases as string[]) || []) {
			const la = alias.toLowerCase();
			if (allCanonicals.has(la)) {
				errors.push(
					err(
						`${tp}.aliases`,
						`"${alias}" collides with term "${allCanonicals.get(la)}"`,
					),
				);
			}
			allCanonicals.set(la, t.id as string);
		}
		for (const dep of (t.deprecated as string[]) || []) {
			const ld = dep.toLowerCase();
			if (allCanonicals.has(ld)) {
				errors.push(
					err(
						`${tp}.deprecated`,
						`"${dep}" collides with term "${allCanonicals.get(ld)}"`,
					),
				);
			}
			allCanonicals.set(ld, t.id as string);
		}
	}
	return errors.length > 0 ? fail(errors) : ok();
}

export function validateLayersFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors: ValidationError[] = [];
	errors.push(...checkUnknownKeys(obj, ["version", "layers", "rules"], "$"));

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	const layerIds = new Set<string>();
	if (!Array.isArray(obj.layers)) {
		errors.push(err("$.layers", "Must be an array"));
	} else {
		for (let i = 0; i < obj.layers.length; i++) {
			const l = obj.layers[i] as JsonObject;
			const lp = `$.layers[${i}]`;
			errors.push(...checkUnknownKeys(l, ["id", "globs"], lp));

			if (typeof l.id !== "string") errors.push(err(`${lp}.id`, "Must be a string"));
			else {
				errors.push(...validateLocalId(l.id, `${lp}.id`));
				if (layerIds.has(l.id))
					errors.push(err(`${lp}.id`, `Duplicate layer ID "${l.id}"`));
				layerIds.add(l.id);
			}
			errors.push(...validateStringArray(l.globs || [], `${lp}.globs`));
		}
	}

	if (!Array.isArray(obj.rules)) {
		errors.push(err("$.rules", "Must be an array"));
	} else {
		for (let i = 0; i < obj.rules.length; i++) {
			const r = obj.rules[i] as JsonObject;
			const rp = `$.rules[${i}]`;
			errors.push(...checkUnknownKeys(r, ["from", "cannot_import", "reason"], rp));

			if (typeof r.from !== "string") errors.push(err(`${rp}.from`, "Must be a string"));
			else if (layerIds.size > 0 && !layerIds.has(r.from)) {
				errors.push(err(`${rp}.from`, `References undeclared layer "${r.from}"`));
			}

			if (!Array.isArray(r.cannot_import)) {
				errors.push(err(`${rp}.cannot_import`, "Must be an array"));
			} else {
				for (const ci of r.cannot_import as string[]) {
					if (layerIds.size > 0 && !layerIds.has(ci)) {
						errors.push(
							err(`${rp}.cannot_import`, `References undeclared layer "${ci}"`),
						);
					}
				}
			}

			if (typeof r.reason !== "string" || r.reason.length === 0) {
				errors.push(err(`${rp}.reason`, "Must be a non-empty string"));
			} else if (r.reason.length > 160) {
				errors.push(err(`${rp}.reason`, "Should be under 160 characters"));
			}
		}
	}
	return errors.length > 0 ? fail(errors) : ok();
}

export function validatePackagesFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors: ValidationError[] = [];
	errors.push(...checkUnknownKeys(obj, ["version", "packages"], "$"));

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (!Array.isArray(obj.packages)) {
		errors.push(err("$.packages", "Must be an array"));
		return fail(errors);
	}

	const pkgIds = new Set<string>();
	for (let i = 0; i < obj.packages.length; i++) {
		const p = obj.packages[i] as JsonObject;
		const pp = `$.packages[${i}]`;
		errors.push(...checkUnknownKeys(p, ["id", "root", "entrypoints"], pp));

		if (typeof p.id !== "string") errors.push(err(`${pp}.id`, "Must be a string"));
		else {
			errors.push(...validateLocalId(p.id, `${pp}.id`));
			if (pkgIds.has(p.id)) errors.push(err(`${pp}.id`, `Duplicate package ID "${p.id}"`));
			pkgIds.add(p.id);
		}
		if (typeof p.root !== "string") errors.push(err(`${pp}.root`, "Must be a string"));
		else if (!isRepoRelativePath(p.root))
			errors.push(err(`${pp}.root`, "Must be a repo-relative POSIX path"));

		errors.push(...validateStringArray(p.entrypoints || [], `${pp}.entrypoints`));
	}
	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// Dispatcher: validate any artifact file by key
// -------------------------------------------

const VALIDATORS: Record<ArtifactFileKey, (data: unknown) => ValidationResult> = {
	public_api: validatePublicApiFile,
	env: validateEnvFile,
	config: validateConfigFile,
	tests: validateTestsFile,
	docs: validateDocsFile,
	examples: validateExamplesFile,
	glossary: validateGlossaryFile,
	layers: validateLayersFile,
	packages: validatePackagesFile,
};

export function validateArtifactFile(key: ArtifactFileKey, data: unknown): ValidationResult {
	const validator = VALIDATORS[key];
	if (!validator) return fail([err("$", `Unknown artifact file key: ${key}`)]);
	return validator(data);
}

// -------------------------------------------
// File-existence validation for declared paths
// -------------------------------------------

export function validateDeclaredPaths(
	config: StructureConfig,
	repoRoot: string,
): ValidationError[] {
	const errors: ValidationError[] = [];

	// Check artifact file paths exist
	for (const [key, relPath] of Object.entries(config.artifacts)) {
		const absPath = resolve(repoRoot, "interlinked", relPath);
		if (!existsSync(absPath)) {
			errors.push(err(`$.artifacts.${key}`, `File not found: interlinked/${relPath}`));
		}
	}

	return errors;
}
