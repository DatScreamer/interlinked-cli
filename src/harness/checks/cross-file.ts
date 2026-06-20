// Cross-file / structural checks (Batch 5).
//
// Four detectors covering empty-body handlers, generalized listener pairing,
// schema↔type drift inside the same file, and migration parity (filesystem
// glob over the file's migrations directory). The new-export-orphan check
// is intentionally deferred — it requires the trigram index and an
// import-graph walk, a different shape from these single-file detectors.

import { existsSync, readdirSync, statSync } from "node:fs";
import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

// ==========================================================================
// 1. Empty-body handler
// ==========================================================================

const HANDLER_NAME_RE =
	/\b(?:async\s+)?function\s+((?:handle|route|on[A-Z]\w*|get|post|put|patch|delete|fetch|serve)\w*)\s*\(/;
const HANDLER_ARROW_RE =
	/\b(?:const|let|var)\s+((?:handle|route|on[A-Z]\w*|get|post|put|patch|delete|fetch|serve)\w*)\s*[:=]\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?=>\s*\{/;

const HANDLER_EMPTY_BODY_PATTERNS: readonly RegExp[] = [
	/^\s*$/,
	/^\s*return\s*;?\s*$/,
	/^\s*console\s*\.\s*(?:log|info|debug|warn|error)\s*\([^)]*\)\s*;?\s*$/,
	/^\s*logger\s*\.\s*(?:log|info|debug|warn|error|trace|fatal)\s*\([^)]*\)\s*;?\s*$/,
];

function bodyLinesAreEffectivelyEmpty(body: string): boolean {
	const lines = body
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && l !== "{" && l !== "}");
	if (lines.length === 0) return true;
	if (lines.length > 1) return false;
	for (const re of HANDLER_EMPTY_BODY_PATTERNS) {
		if (re.test(nonNull(lines[0]))) return true;
	}
	return false;
}

function extractBalancedBlock(text: string, openIdx: number): string | null {
	if (text[openIdx] !== "{") return null;
	let depth = 1;
	for (let i = openIdx + 1; i < text.length; i++) {
		const ch = text[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(openIdx + 1, i);
		}
	}
	return null;
}

/** Public API — flags handler-named functions with empty/no-op bodies. */
export function checkEmptyBodyHandler(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (const re of [HANDLER_NAME_RE, HANDLER_ARROW_RE]) {
		const globalRe = new RegExp(re.source, "g");
		let m: RegExpExecArray | null = globalRe.exec(stripped);
		while (m !== null && matches.length < MAX_MATCHES) {
			const name = m[1];
			const openIdx = stripped.indexOf("{", m.index + m[0].length);
			if (openIdx < 0 || openIdx > m.index + m[0].length + 200) {
				m = globalRe.exec(stripped);
				continue;
			}
			const body = extractBalancedBlock(stripped, openIdx);
			if (body !== null && bodyLinesAreEffectivelyEmpty(body)) {
				const lineIdx = (stripped.slice(0, m.index).match(/\n/g) || []).length;
				matches.push({
					line: lineIdx + 1,
					text: `handler-named function \`${name}\` has an empty / no-op body. Either implement it, throw a typed not-implemented error, or rename so the API surface doesn't lie.`,
				});
			}
			m = globalRe.exec(stripped);
		}
	}
	return matches;
}

// ==========================================================================
// 2. Listener pairing (generalized)
// ==========================================================================

// Regexes operate on the strip-strings output (string contents are blanked
// to ""), so we match the call shape rather than the event-name literal.
const LISTENER_PAIRS: ReadonlyArray<{ add: RegExp; clean: RegExp; label: string }> = [
	{
		add: /\b([A-Za-z_$][\w$]*)\s*\.\s*addEventListener\s*\(/,
		clean: /\bremoveEventListener\s*\(/,
		label: "addEventListener",
	},
	{
		add: /\b(process|signal|emitter)\s*\.\s*on\s*\(/,
		clean: /\b(?:off|removeListener)\s*\(/,
		label: "EventEmitter.on",
	},
];

/** Public API — flags listener registrations without paired cleanup. */
export function checkListenerPairing(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (const pair of LISTENER_PAIRS) {
		if (matches.length >= MAX_MATCHES) break;
		// File-level cleanup-presence check first — avoids the per-occurrence
		// quadratic cost.
		if (pair.clean.test(stripped)) continue;
		const globalAdd = new RegExp(pair.add.source, "g");
		let m: RegExpExecArray | null = globalAdd.exec(stripped);
		while (m !== null && matches.length < MAX_MATCHES) {
			const target = m[1];
			const lineIdx = (stripped.slice(0, m.index).match(/\n/g) || []).length;
			matches.push({
				line: lineIdx + 1,
				text: `${pair.label} on \`${target}\` without paired cleanup elsewhere in this file. Listeners outlive the registering scope — pair with the matching off / removeListener / removeEventListener call in a teardown path.`,
			});
			m = globalAdd.exec(stripped);
		}
	}
	return matches;
}

// ==========================================================================
// 3. Schema ↔ type drift
// ==========================================================================

interface SchemaShape {
	name: string;
	line: number;
	keys: Set<string>;
	kind: "schema" | "type";
}

const ZOD_SCHEMA_RE =
	/\b(?:export\s+)?const\s+([A-Z][\w$]*)\s*(?::[^=]+)?=\s*(?:z|valibot|yup|t|s|v)\s*\.\s*(?:object|interface|record|strictObject)\s*\(\s*\{/g;
const TYPE_OR_INTERFACE_RE =
	/\b(?:export\s+)?(?:interface\s+([A-Z][\w$]*)\s*\{|type\s+([A-Z][\w$]*)\s*=\s*\{)/g;

function extractObjectKeys(block: string): Set<string> {
	const keys = new Set<string>();
	const KEY_RE = /(?:^|[\n,;{])\s*([A-Za-z_$][\w$]*)\s*[?:]/g;
	KEY_RE.lastIndex = 0;
	let m: RegExpExecArray | null = KEY_RE.exec(block);
	while (m !== null) {
		keys.add(nonNull(m[1]));
		m = KEY_RE.exec(block);
	}
	return keys;
}

function nameRoot(name: string): string {
	return name.replace(/(?:Schema|Type|Shape|Validator|Spec)$/, "").toLowerCase();
}

/** Public API — flags Zod schema vs TS interface drift in the same file. */
export function checkSchemaTypeDrift(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const shapes: SchemaShape[] = [];

	ZOD_SCHEMA_RE.lastIndex = 0;
	let m: RegExpExecArray | null = ZOD_SCHEMA_RE.exec(content);
	while (m !== null) {
		const openIdx = content.indexOf("{", m.index + m[0].length - 1);
		const block = openIdx >= 0 ? extractBalancedBlock(content, openIdx) : null;
		if (block) {
			shapes.push({
				name: nonNull(m[1]),
				line: (content.slice(0, m.index).match(/\n/g) || []).length + 1,
				keys: extractObjectKeys(block),
				kind: "schema",
			});
		}
		m = ZOD_SCHEMA_RE.exec(content);
	}

	TYPE_OR_INTERFACE_RE.lastIndex = 0;
	let t: RegExpExecArray | null = TYPE_OR_INTERFACE_RE.exec(content);
	while (t !== null) {
		const name = t[1] ?? t[2];
		if (name) {
			const openIdx = content.indexOf("{", t.index);
			const block = openIdx >= 0 ? extractBalancedBlock(content, openIdx) : null;
			if (block) {
				shapes.push({
					name,
					line: (content.slice(0, t.index).match(/\n/g) || []).length + 1,
					keys: extractObjectKeys(block),
					kind: "type",
				});
			}
		}
		t = TYPE_OR_INTERFACE_RE.exec(content);
	}

	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 3;
	const schemas = shapes.filter((s) => s.kind === "schema");
	const types = shapes.filter((s) => s.kind === "type");

	for (const schema of schemas) {
		if (matches.length >= MAX_MATCHES) break;
		const root = nameRoot(schema.name);
		const partner = types.find((tt) => nameRoot(tt.name) === root);
		if (!partner) continue;
		const onlyInSchema = [...schema.keys].filter((k) => !partner.keys.has(k));
		const onlyInType = [...partner.keys].filter((k) => !schema.keys.has(k));
		if (onlyInSchema.length === 0 && onlyInType.length === 0) continue;
		const desc = [
			onlyInSchema.length > 0 ? `only in schema: ${onlyInSchema.slice(0, 4).join(", ")}` : "",
			onlyInType.length > 0 ? `only in type: ${onlyInType.slice(0, 4).join(", ")}` : "",
		]
			.filter(Boolean)
			.join("; ");
		matches.push({
			line: schema.line,
			text: `schema/type drift between \`${schema.name}\` and \`${partner.name}\` — ${desc}. The type and the runtime validator should agree; derive one from the other.`,
		});
	}
	return matches;
}

// ==========================================================================
// 4. Migration parity
// ==========================================================================

const MIGRATION_DIR_RE = /(?:^|\/)(?:migrations|migrate|db\/migrations|prisma\/migrations)(?:\/|$)/;

function findMigrationsDir(file: string): string | null {
	const norm = file.replace(/\\/g, "/");
	const match = MIGRATION_DIR_RE.exec(norm);
	if (!match) return null;
	const idx = norm.indexOf(match[0]);
	if (idx < 0) return null;
	const dirEnd = idx + match[0].length - (match[0].endsWith("/") ? 1 : 0);
	const absLike = file.slice(0, dirEnd);
	return existsSync(absLike) && statSync(absLike).isDirectory() ? absLike : null;
}

const UP_SQL_RE = /(?:^|[._-])up\.sql$/;

/**
 * Public API — flags THIS file when it is an unpaired `*_up.sql`. Scoped
 * to the file passed in (rather than walking the whole migrations dir on
 * every per-file invocation) so a single missing `_down.sql` reports
 * exactly once across a `verify` run, not once per sibling file.
 */
export function checkMigrationParity(content: string, filePath: string): InlineMatch[] {
	void content;
	if (isTestFile(filePath)) return [];
	const dir = findMigrationsDir(filePath);
	if (!dir) return [];

	const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
	if (!UP_SQL_RE.test(fileName)) return [];

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	const expectedDown = fileName.replace(/(?:^|([._-]))up\.sql$/, "$1down.sql");
	if (entries.includes(expectedDown)) return [];

	return [
		{
			line: 1,
			text: `migration ${fileName} has no matching ${expectedDown} in ${dir} — every up should have a paired down so the migration is reversible.`,
		},
	];
}
