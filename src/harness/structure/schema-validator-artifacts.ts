// ===========================================
// Per-artifact file validators
// ===========================================
// Validates each of the 9 artifact file schemas (public_api, env, config,
// tests, docs, examples, glossary, layers, packages).
// Depends only on schema-validator-helpers.ts — no circular deps.

import type { JsonObject } from "../../lib/json-types.js";
import type { ArtifactFileKey } from "./types.js";
import {
	ENV_KEY_PATTERN,
	VALID_DOC_KINDS,
	VALID_STABILITY,
	VALID_SYMBOL_KINDS,
	VALID_TEST_KINDS,
} from "./types.js";
import {
	checkUnknownKeys,
	err,
	fail,
	includes,
	isRepoRelativePath,
	ok,
	validateCoversArray,
	validateLocalId,
	validateStringArray,
} from "./schema-validator-helpers.js";
import type { ValidationResult } from "./schema-validator-helpers.js";

// -------------------------------------------
// public_api
// -------------------------------------------

export function validatePublicApiFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "modules"], "$");

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

// -------------------------------------------
// env
// -------------------------------------------

export function validateEnvFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "sources", "keys"], "$");

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

// -------------------------------------------
// config
// -------------------------------------------

export function validateConfigFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "roots", "keys"], "$");

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

// -------------------------------------------
// tests
// -------------------------------------------

export function validateTestsFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "tests"], "$");

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

// -------------------------------------------
// docs
// -------------------------------------------

export function validateDocsFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "docs"], "$");

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

// -------------------------------------------
// examples
// -------------------------------------------

export function validateExamplesFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "examples"], "$");

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

// -------------------------------------------
// glossary
// -------------------------------------------

export function validateGlossaryFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "terms"], "$");

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

// -------------------------------------------
// layers
// -------------------------------------------

export function validateLayersFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "layers", "rules"], "$");

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

// -------------------------------------------
// packages
// -------------------------------------------

export function validatePackagesFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "packages"], "$");

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
