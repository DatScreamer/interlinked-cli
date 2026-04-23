// ===========================================
// Rule: Public Symbol Test-Case Requirement
// ===========================================
// Complements `public_symbol_companions` (which checks companion files were
// TOUCHED when the source changed). This rule checks that a companion test
// file actually references the symbol by name — catching the case where the
// test file exists but contains no test case for the symbol.
//
// Fires when:
//   - A public symbol's source file is in changedFiles
//   - The symbol has at least one declared/inferred companion test file
//   - None of those test files contain a `\b<symbolLabel>\b` reference
//
// Why this matters: "test file exists" is not the same as "test case exists".
// An agent can land a new export whose test file was created months ago for
// a different symbol; static file presence misses the gap. Requiring the
// symbol NAME to appear in the test file surfaces the gap cheaply.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ArtifactGraph } from "../artifact-graph.js";
import type { Determinism, StructureFinding } from "../types.js";

export function checkPublicSymbolTestCase(
	graph: ArtifactGraph,
	changedFiles: string[],
	repoRoot?: string,
): StructureFinding[] {
	const findings: StructureFinding[] = [];
	const changedSet = new Set(changedFiles);
	const symbolNodes = graph.getNodesByKind("public_symbol");

	for (const symbol of symbolNodes) {
		if (!changedSet.has(symbol.file)) continue;

		const { tests } = graph.getCompanions(symbol.id);
		if (tests.length === 0) continue;

		const root = repoRoot ?? process.cwd();
		const pattern = symbolReferenceRegex(symbol.label);

		const referencingFiles: string[] = [];
		const nonReferencingFiles: string[] = [];

		for (const test of tests) {
			const absPath = resolve(root, test.file);
			if (!existsSync(absPath)) {
				nonReferencingFiles.push(test.file);
				continue;
			}
			let content = "";
			try {
				content = readFileSync(absPath, "utf-8");
			} catch {
				// Unreadable file is treated as "no reference" — the signal remains
				// actionable (add a test case here) even if the root cause is IO.
				nonReferencingFiles.push(test.file);
				continue;
			}
			if (pattern.test(content)) {
				referencingFiles.push(test.file);
			} else {
				nonReferencingFiles.push(test.file);
			}
		}

		// If at least one companion test file references the symbol, we're good.
		if (referencingFiles.length > 0) continue;

		const allDeclared =
			symbol.provenance === "declared" && tests.every((t) => t.provenance === "declared");
		const determinism: Determinism = allDeclared
			? "fully_deterministic"
			: "partially_deterministic";

		findings.push({
			name: "public_symbol_test_case_missing",
			severity: "warning",
			message: `Public symbol "${symbol.label}" has ${tests.length} companion test file(s) but none contain a reference to it. Add a test case that imports/invokes "${symbol.label}".`,
			file: symbol.file,
			affected_files: nonReferencingFiles,
			determinism,
			provenance: symbol.provenance,
			artifact_kind: "public_symbol",
			artifact_id: symbol.id,
			required_updates: nonReferencingFiles.map((f) => ({
				file: f,
				kind: "test",
				reason: `Add a test case referencing "${symbol.label}"`,
			})),
			confidence: allDeclared ? 1.0 : 0.75,
		});
	}

	return findings;
}

/**
 * Build a case-sensitive identifier-boundary regex matching the symbol label.
 * JS identifiers may legally contain `$` and `_` in addition to `[A-Za-z0-9]`,
 * so a plain `\b` won't anchor correctly around labels like `$foo`. Instead
 * we explicitly require the preceding and following characters to not be
 * identifier-constituent characters.
 */
function symbolReferenceRegex(label: string): RegExp {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Reason: `label` comes from the artifact graph, not user input. The regex
	// metacharacters above are escaped, and the pattern structure (fixed
	// lookbehind / lookahead) is static.
	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
}
