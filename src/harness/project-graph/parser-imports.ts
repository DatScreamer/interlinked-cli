// ===========================================
// Project Graph — Import Parser
// ===========================================
// Regex-based parser for TypeScript/JavaScript import statements.
// Extracted from project-graph.ts to keep the main module focused
// on the ProjectGraph class and its indexing logic.

import type { ImportEdge } from "../types.js";

/**
 * Returns true when `keyword` (`"require("` or `"import("`) at `idx` in `text`
 * is embedded inside a string literal rather than real code. Conservative: only
 * rejects when the count of unescaped quote characters (of the same kind as
 * the most recent quote before `idx`) between that quote and `idx` is odd.
 */
function isInsideStringLiteral(text: string, idx: number): boolean {
	if (idx <= 0) return false;
	const before = text.slice(0, idx);
	const lastQuote = Math.max(
		before.lastIndexOf("'"),
		before.lastIndexOf('"'),
		before.lastIndexOf("`"),
	);
	if (lastQuote < 0) return false;
	const quoteChar = before[lastQuote];
	const between = before.slice(lastQuote);
	let occurrences = 0;
	for (let i = 0; i < between.length; i++) {
		if (between[i] !== quoteChar) continue;
		// Count the run of backslashes immediately preceding this quote.
		// Even count = quote is unescaped.
		let backslashes = 0;
		for (let j = i - 1; j >= 0 && between[j] === "\\"; j--) backslashes++;
		if (backslashes % 2 === 0) occurrences++;
	}
	return occurrences % 2 === 1;
}

/**
 * Public API — consumed by ProjectGraph.indexFile and structural-checks.
 *
 * Parse imports from TypeScript/JavaScript source content.
 * Returns raw specifiers (not resolved paths).
 */
export function parseImports(content: string, fromFile: string): Omit<ImportEdge, "toFile">[] {
	const imports: Omit<ImportEdge, "toFile">[] = [];
	const lines = content.split("\n");

	// Collapse multiline imports: join lines that start with import but don't have a closing quote.
	// Track template literal depth to skip imports embedded inside multi-line template strings
	// (e.g., code generation that produces `import "./helpers.js"` as string content).
	const collapsed: string[] = [];
	let buffer = "";
	let inTemplateLiteral = false;
	for (const line of lines) {
		const trimmed = line.trim();

		// Track multi-line template literal boundaries.
		// Count unescaped backticks — odd count toggles in/out of template literal.
		const backticks = (trimmed.match(/(?<!\\)`/g) || []).length;
		if (inTemplateLiteral) {
			if (backticks % 2 === 1) inTemplateLiteral = false;
			continue; // Skip lines inside template literals
		}
		if (backticks % 2 === 1) {
			// Check if the backtick opens a template that doesn't close on this line
			// (i.e., not a single-line template like `hello ${world}`)
			inTemplateLiteral = true;
			// Still process this line — the import may be before the opening backtick
		}

		if (buffer) {
			buffer += ` ${trimmed}`;
			if (/from\s+['"][^'"]+['"]/.test(buffer) || /['"][^'"]+['"]/.test(buffer)) {
				collapsed.push(buffer);
				buffer = "";
			}
			continue;
		}
		if (trimmed.startsWith("import") && /\{/.test(trimmed) && !/\}/.test(trimmed)) {
			buffer = trimmed;
			continue;
		}
		collapsed.push(trimmed);
	}
	if (buffer) collapsed.push(buffer);

	for (const line of collapsed) {
		// Strip inline comments from collapsed lines (e.g., // MCP Tasks Protocol handlers)
		const trimmed = line
			.trim()
			.replace(/\/\/[^\n]*/g, "")
			.trim();
		if (
			!trimmed.startsWith("import") &&
			!trimmed.includes("require(") &&
			!trimmed.includes("import(")
		)
			continue;
		// Skip comment lines
		if (trimmed.startsWith("//")) continue;

		// Skip lines where import/require appears inside a string literal.
		// If a quote character (' " `) opens an unclosed literal before the
		// keyword, the pattern is embedded in string content (e.g., test
		// fixtures or codegen), not a real import.
		if (!trimmed.startsWith("import")) {
			const reqIdx = trimmed.indexOf("require(");
			if (reqIdx > 0 && isInsideStringLiteral(trimmed, reqIdx)) continue;
			const dynIdx = trimmed.indexOf("import(");
			if (dynIdx > 0 && isInsideStringLiteral(trimmed, dynIdx)) continue;
		}

		const isTypeOnly = /^import\s+type\s/.test(trimmed);

		// import { a, b } from 'module'
		const namedImport = trimmed.match(
			/^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/,
		);
		if (namedImport) {
			const symbols = namedImport[1]
				.split(",")
				.map((s) =>
					s
						.trim()
						.replace(/^type\s+/, "")
						.split(/\s+as\s+/)[0]
						.trim(),
				)
				.filter(Boolean);
			imports.push({ fromFile, specifier: namedImport[2], symbols, isTypeOnly });
			continue;
		}

		// import DefaultName from 'module'
		const defaultImport = trimmed.match(
			/^import\s+(?:type\s+)?(\w+)\s+from\s+['"]([^'"]+)['"]/,
		);
		if (defaultImport) {
			imports.push({
				fromFile,
				specifier: defaultImport[2],
				symbols: [defaultImport[1]],
				isTypeOnly,
			});
			continue;
		}

		// import * as name from 'module'
		const nsImport = trimmed.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
		if (nsImport) {
			imports.push({ fromFile, specifier: nsImport[2], symbols: [], isTypeOnly });
			continue;
		}

		// import 'module' (side-effect)
		const sideEffect = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
		if (sideEffect) {
			imports.push({ fromFile, specifier: sideEffect[1], symbols: [], isTypeOnly: false });
			continue;
		}

		// require('module')
		const req = trimmed.match(/require\(['"]([^'"]+)['"]\)/);
		if (req) {
			imports.push({ fromFile, specifier: req[1], symbols: [], isTypeOnly: false });
			continue;
		}

		// Destructured dynamic import — matches const/let/var binding of a destructuring
		// pattern on the LHS with an (optionally awaited) import() call on the RHS.
		// Rename targets like `b: c` are recorded as `b`, since the export surface is
		// what matters for dead-export analysis. See parser-imports.test.ts for examples.
		const destructuredDynamic = trimmed.match(
			/^(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:await\s+)?import\(\s*['"]([^'"]+)['"]\s*\)/,
		);
		if (destructuredDynamic) {
			const symbols = destructuredDynamic[1]
				.split(",")
				.map((s) =>
					s
						.trim()
						.split(/\s*:\s*/)[0]
						.trim(),
				)
				.filter(Boolean);
			imports.push({
				fromFile,
				specifier: destructuredDynamic[2],
				symbols,
				isTypeOnly: false,
			});
			continue;
		}

		// Namespace-style dynamic import — a const/let/var bound to a single identifier
		// with an (optionally awaited) import() call on the RHS. Equivalent to
		// `import * as mod from 'module'` — records empty symbols so dead-export
		// analysis treats it as consuming every export. See parser-imports.test.ts.
		const namespaceDynamic = trimmed.match(
			/^(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?import\(\s*['"]([^'"]+)['"]\s*\)/,
		);
		if (namespaceDynamic) {
			imports.push({
				fromFile,
				specifier: namespaceDynamic[1],
				symbols: [],
				isTypeOnly: false,
			});
			continue;
		}

		// Dynamic import('module')
		const dynamic = trimmed.match(/import\(['"]([^'"]+)['"]\)/);
		if (dynamic) {
			imports.push({ fromFile, specifier: dynamic[1], symbols: [], isTypeOnly: false });
		}
	}

	return imports;
}
