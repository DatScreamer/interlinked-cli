// interlinked-tdd: exempt
// ===========================================
// Per-artifact file validators (covers-based cluster)
// ===========================================
// Validators for the tests, docs, examples, and packages artifact files —
// the leaf cluster split out of schema-validator-artifacts.ts to keep that
// module under the per-file line cap. Depends only on
// schema-validator-helpers.ts and ./types.js — no circular deps (the parent
// module imports these back for its dispatcher table; this file never imports
// from the parent).

import type { JsonObject } from "../../lib/json-types.js";
import type { ValidationResult } from "./schema-validator-helpers.js";
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
import { VALID_DOC_KINDS, VALID_TEST_KINDS } from "./types.js";

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
