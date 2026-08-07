// ===========================================
// CLI spec-surface ↔ test-surface audit (round 6)
// ===========================================
// Every commander `--option` the CLI registers is SPEC SURFACE: behavior a
// user can invoke. An option no test ever mentions is unbound behavior — the
// class that let `allowlist add --version-range` approve a release the
// screens never inspected (finding 2026-06: nothing pinned the flag's
// semantics, so screen and approval silently diverged).
//
// Deterministic audit: extract every long flag registered under src/, then
// require each to appear (as the flag literal or its camelCase opts key) in
// at least one test file. The currently-unbound surface is PINNED below as a
// ratchet — the list may only SHRINK, and a flag that gains a test must be
// removed from it (the same may-only-shrink contract as the registry-parity
// exception lists).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isStrictTestFile } from "../../harness/checks/shared.js";
import { nonNull } from "../../lib/non-null.js";

/** Flags with no test mention yet — tracked debt, may only shrink. */
const PINNED_UNTESTED = new Set<string>([]);

const OPTION_CALL_RE = /\.option\(\s*["'`]([^"'`]+)["'`]/g;
const LONG_FLAG_RE = /--[A-Za-z][\w-]*/;

function walk(dir: string, out: string[]): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		// Skip node_modules/dist/dotfiles, and single-underscore transient fixture
		// trees (_*_fixtures-*, _gate_*, _write_integration, _multi_edit_*): they are
		// gitignored, created/destroyed by other tests, and reading one mid-walk
		// caused an intermittent ENOENT flake under the concurrent full suite.
		// `__tests__` (double underscore) is kept — the audit needs those test files.
		if (
			entry.name === "node_modules" ||
			entry.name === "dist" ||
			entry.name.startsWith(".") ||
			(entry.name.startsWith("_") && !entry.name.startsWith("__"))
		) {
			continue;
		}
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (/\.(?:ts|tsx)$/.test(entry.name)) out.push(full);
	}
	return out;
}

function camelKeyOf(flag: string): string {
	return flag
		.replace(/^--(?:no-)?/, "")
		.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

describe("CLI spec surface — every registered option is exercised by a test", () => {
	const srcRoot = fileURLToPath(new URL("../..", import.meta.url));
	const auditFile = fileURLToPath(import.meta.url);
	const files = walk(srcRoot, []);
	const sources = files.filter((f) => !isStrictTestFile(f));
	// THIS file is excluded from the corpus: its pin list names flags as DATA,
	// and counting that as a "mention" let a pinned flag vouch for itself.
	const testCorpus = files
		.filter((f) => isStrictTestFile(f) && f !== auditFile)
		.map((f) => readFileSync(f, "utf-8"))
		.join("\n");

	const flags = new Set<string>();
	for (const file of sources) {
		const content = readFileSync(file, "utf-8");
		for (const m of content.matchAll(OPTION_CALL_RE)) {
			const flag = nonNull(m[1]).match(LONG_FLAG_RE)?.[0];
			if (flag) flags.add(flag);
		}
	}

	it("found a meaningful option surface (the walk works)", () => {
		expect(flags.size).toBeGreaterThan(10);
	});

	it("no UNPINNED option is test-silent, and the pinned list only shrinks", () => {
		const untested: string[] = [];
		for (const flag of [...flags].sort()) {
			const camel = camelKeyOf(flag);
			const mentioned =
				testCorpus.includes(flag) || new RegExp(`\\b${camel}\\b`).test(testCorpus);
			if (!mentioned) untested.push(flag);
		}
		const newlyUntested = untested.filter((f) => !PINNED_UNTESTED.has(f));
		expect(
			newlyUntested,
			"new CLI options with no test mention — add a behavior-pinning test (or, exceptionally, pin here with a comment)",
		).toEqual([]);
		const stale = [...PINNED_UNTESTED].filter((f) => !untested.includes(f));
		expect(
			stale,
			"pinned flags that now HAVE tests — remove them from PINNED_UNTESTED (the list only shrinks)",
		).toEqual([]);
	});
});
