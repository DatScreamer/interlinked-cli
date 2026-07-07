// ===========================================
// Endpoint-security family gate (2026-07 noise review)
// ===========================================
// The five endpoint_* detectors fired ~57 findings on this repo's OWN test
// files and route-extraction fixtures — files that deliberately embed
// vulnerable routes as detector test cases (plus the detectors' own pattern
// literals in check-registry). Test files, fixtures, and vendored trees are
// not deployable endpoints, so the whole family skips them in one place:
//  - `isTestFile` — genuine test files AND interlinked-cli's own detector /
//    registry data files (patterns held AS DATA)
//  - `isVendoredOrFixturePath` — vendor/, examples/, fixtures/, dist/, …
//  - `__fixtures__/` — the vitest fixture-dir convention the shared
//    predicate's `fixtures/` segment doesn't cover
// Per shared.ts's contract ("Security checks call BOTH `isTestFile` and
// this helper at their gate") — this family predated that convention.
// Split out of `endpoint-security.ts` for the per-file line cap.

import { isTestFile, isVendoredOrFixturePath } from "./shared.js";

const DUNDER_FIXTURES_RE = /(^|\/)__fixtures__\//;

/** True when `filePath` is not a deployable endpoint surface (test file,
 * fixture tree, vendored/generated code) — the whole endpoint-security
 * family skips it. */
export function isEndpointSecurityExemptFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	if (isTestFile(normalized)) return true;
	if (isVendoredOrFixturePath(normalized)) return true;
	return DUNDER_FIXTURES_RE.test(normalized);
}
