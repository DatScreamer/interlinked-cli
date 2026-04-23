// ===========================================
// Project Graph — Export Parser
// ===========================================
// Regex-based parser for TypeScript/JavaScript export statements.
// Extracted from project-graph.ts to keep the main module focused
// on the ProjectGraph class and its indexing logic.

import type { ExportedSymbol } from "../types.js";

/**
 * Public API — consumed by ProjectGraph.indexFile and structural-checks.
 *
 * Parse exports from TypeScript/JavaScript source content using regex.
 * Handles: named exports, default exports, re-exports, type exports.
 * Skips comment-only lines (best-effort).
 */
export function parseExports(content: string): ExportedSymbol[] {
	const exports: ExportedSymbol[] = [];
	const lines = content.split("\n");

	let inBlockComment = false;
	let exportBuffer = "";
	let exportBufferStartLine = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Track block comments
		if (inBlockComment) {
			if (trimmed.includes("*/")) {
				inBlockComment = false;
			}
			continue;
		}
		if (trimmed.startsWith("/*")) {
			if (!trimmed.includes("*/")) {
				inBlockComment = true;
			}
			continue;
		}
		if (trimmed.startsWith("//")) continue;

		// Handle multiline export { ... } statements
		if (exportBuffer) {
			exportBuffer += ` ${trimmed}`;
			if (trimmed.includes("}")) {
				// Multiline export complete — process the accumulated buffer
				processExportStatement(exportBuffer, exportBufferStartLine, exports);
				exportBuffer = "";
			}
			continue;
		}

		// Skip lines that don't start with "export"
		if (!trimmed.startsWith("export")) continue;

		// Detect start of multiline export { ... } (opening brace but no closing)
		if (/^export\s+(?:type\s+)?\{/.test(trimmed) && !trimmed.includes("}")) {
			exportBuffer = trimmed;
			exportBufferStartLine = i + 1;
			continue;
		}

		const lineNum = i + 1;

		// export type { Foo, Bar } from '...' or export type { Foo, Bar }
		const typeReExport = trimmed.match(/^export\s+type\s+\{([^}]+)\}/);
		if (typeReExport) {
			const names = typeReExport[1]
				.split(",")
				.map((n) =>
					n
						.trim()
						.split(/\s+as\s+/)
						.pop()!
						.trim(),
				)
				.filter(Boolean);
			for (const name of names) {
				exports.push({ name, kind: "type", isTypeOnly: true, line: lineNum });
			}
			continue;
		}

		// export { foo, bar as baz } or export { foo } from '...'
		const namedReExport = trimmed.match(/^export\s+\{([^}]+)\}/);
		if (namedReExport) {
			const names = namedReExport[1]
				.split(",")
				.map((n) =>
					n
						.trim()
						.replace(/^type\s+/, "")
						.split(/\s+as\s+/)
						.pop()!
						.trim(),
				)
				.filter(Boolean);
			const isReExport = /from\s+['"]/.test(trimmed);
			for (const name of names) {
				exports.push({
					name,
					kind: isReExport ? "re-export" : "const",
					isTypeOnly: false,
					line: lineNum,
				});
			}
			continue;
		}

		// export * from '...' or export * as ns from '...'
		if (/^export\s+\*\s/.test(trimmed)) {
			const nsMatch = trimmed.match(/^export\s+\*\s+as\s+(\w+)/);
			exports.push({
				name: nsMatch ? nsMatch[1] : "*",
				kind: "namespace",
				isTypeOnly: false,
				line: lineNum,
			});
			continue;
		}

		// export default class/function Name
		const defaultClassFn = trimmed.match(/^export\s+default\s+(class|function)\s*(\w*)/);
		if (defaultClassFn) {
			exports.push({
				name: "default",
				kind: "default",
				isTypeOnly: false,
				line: lineNum,
			});
			// Also track the named identifier if present
			if (defaultClassFn[2]) {
				exports.push({
					name: defaultClassFn[2],
					kind: defaultClassFn[1] as "class" | "function",
					isTypeOnly: false,
					line: lineNum,
				});
			}
			continue;
		}

		// export default <expression>
		if (/^export\s+default\s/.test(trimmed)) {
			exports.push({ name: "default", kind: "default", isTypeOnly: false, line: lineNum });
			continue;
		}

		// export async function name(
		const asyncFn = trimmed.match(/^export\s+async\s+function\s+(\w+)/);
		if (asyncFn) {
			exports.push({ name: asyncFn[1], kind: "function", isTypeOnly: false, line: lineNum });
			continue;
		}

		// export function name(
		const fn = trimmed.match(/^export\s+function\s+(\w+)/);
		if (fn) {
			exports.push({ name: fn[1], kind: "function", isTypeOnly: false, line: lineNum });
			continue;
		}

		// export const/let/var name
		const variable = trimmed.match(/^export\s+(const|let|var)\s+(\w+)/);
		if (variable) {
			exports.push({
				name: variable[2],
				kind: variable[1] as "const" | "let" | "var",
				isTypeOnly: false,
				line: lineNum,
			});
			continue;
		}

		// export class Name
		const cls = trimmed.match(/^export\s+class\s+(\w+)/);
		if (cls) {
			exports.push({ name: cls[1], kind: "class", isTypeOnly: false, line: lineNum });
			continue;
		}

		// export interface Name
		const iface = trimmed.match(/^export\s+interface\s+(\w+)/);
		if (iface) {
			exports.push({ name: iface[1], kind: "interface", isTypeOnly: true, line: lineNum });
			continue;
		}

		// export type Name =
		const typeAlias = trimmed.match(/^export\s+type\s+(\w+)\s*[=<]/);
		if (typeAlias) {
			exports.push({ name: typeAlias[1], kind: "type", isTypeOnly: true, line: lineNum });
			continue;
		}

		// export enum Name
		const enm = trimmed.match(/^export\s+enum\s+(\w+)/);
		if (enm) {
			exports.push({ name: enm[1], kind: "enum", isTypeOnly: false, line: lineNum });
			continue;
		}

		// export abstract class Name
		const abstractCls = trimmed.match(/^export\s+abstract\s+class\s+(\w+)/);
		if (abstractCls) {
			exports.push({ name: abstractCls[1], kind: "class", isTypeOnly: false, line: lineNum });
		}
	}

	return exports;
}

/**
 * Process a complete (possibly multiline) export statement.
 *
 * Internal helper used by parseExports when it detects an `export { ... }`
 * block that spans multiple lines and must be accumulated before extraction.
 */
function processExportStatement(
	statement: string,
	lineNum: number,
	exports: ExportedSymbol[],
): void {
	const isTypeExport = /^export\s+type\s+\{/.test(statement);
	const match = statement.match(/\{([^}]+)\}/);
	if (!match) return;

	const names = match[1]
		.split(",")
		.map((n) =>
			n
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)
				.pop()!
				.trim(),
		)
		.filter(Boolean);
	const isReExport = /from\s+['"]/.test(statement);

	let exportKind: "type" | "re-export" | "const";
	if (isTypeExport) {
		exportKind = "type";
	} else if (isReExport) {
		exportKind = "re-export";
	} else {
		exportKind = "const";
	}
	for (const name of names) {
		exports.push({
			name,
			kind: exportKind,
			isTypeOnly: isTypeExport,
			line: lineNum,
		});
	}
}
