#!/usr/bin/env node
// Read all the check/*.ts files and build an explicit named-export barrel
// for src/harness/generic-checks.ts. Uses explicit re-exports (not star
// exports) so the harness impact-analysis sees every symbol as a named
// surface.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const CHECKS_DIR = resolve(process.cwd(), "src/harness/checks");
const BARREL = resolve(process.cwd(), "src/harness/generic-checks.ts");

// Map: module -> { values: Set<string>, types: Set<string> }
const modules = new Map();

for (const file of readdirSync(CHECKS_DIR)) {
	if (!file.endsWith(".ts")) continue;
	if (file.endsWith(".test.ts")) continue;
	if (file === "shared.ts") continue; // shared exports handled separately
	const modName = file.replace(/\.ts$/, "");
	const src = readFileSync(`${CHECKS_DIR}/${file}`, "utf-8");
	const values = new Set();
	const types = new Set();

	// Strip comments (quick) — regex-based, not perfect but good enough
	const noComments = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

	// Match individual export statements
	// export function|const|class|let|var|enum NAME
	for (const m of noComments.matchAll(
		/^export\s+(?:async\s+)?(?:function|const|class|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm,
	)) {
		values.add(m[1]);
	}
	// export interface|type NAME
	for (const m of noComments.matchAll(/^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm)) {
		types.add(m[1]);
	}
	// export { X, Y as Z, type T } — already handled by explicit export statements
	for (const m of noComments.matchAll(/^export\s+\{([^}]+)\}/gm)) {
		for (const part of m[1].split(",")) {
			const name = part.trim().split(/\s+as\s+/).pop()?.trim();
			if (!name) continue;
			// We can't distinguish type-only here; add to values (TypeScript accepts re-export of types via `export { }`)
			if (part.trim().startsWith("type ")) types.add(name.replace(/^type\s+/, ""));
			else values.add(name);
		}
	}

	if (values.size + types.size > 0) modules.set(modName, { values, types });
}

// Build output lines
const lines = [
	"// ===========================================",
	"// Generic Checks — Language-agnostic and language-specific inline analysis",
	"// ===========================================",
	"// Pure functions that analyze file content (<1ms each for inline checks).",
	"// Each check returns matches (line number + text) or a boolean verdict.",
	"// Dependencies: Node.js stdlib only (fs, path, child_process for cross-file checks).",
	"//",
	"// As of 2026-04, implementation lives in the `./checks/` sub-package. This",
	"// module is kept as a thin named-export barrel so existing importers, the",
	"// harness impact-analyzer, and docs generators keep working. New code",
	"// should import from `./checks/<family>.js` directly.",
	"",
	"// ---- shared helpers ----",
	'export type { InlineMatch } from "./checks/shared.js";',
	'export {',
	'\tgetExtension,',
	'\tisCliFile,',
	'\tisTestFile,',
	'\tscanLinesStripped,',
	'\tstripComments,',
	'\tstripCommentsAndStrings,',
	'\tstripStrings,',
	'} from "./checks/shared.js";',
	"",
];

for (const [mod, { values, types }] of [...modules.entries()].sort()) {
	if (values.size > 0) {
		lines.push(`// ---- ${mod} ----`);
		lines.push(`export {`);
		for (const v of [...values].sort()) lines.push(`\t${v},`);
		lines.push(`} from "./checks/${mod}.js";`);
	}
	if (types.size > 0) {
		lines.push(`export type {`);
		for (const t of [...types].sort()) lines.push(`\t${t},`);
		lines.push(`} from "./checks/${mod}.js";`);
	}
}

writeFileSync(BARREL, lines.join("\n") + "\n");
console.log(`Barrel written with ${modules.size} modules`);
