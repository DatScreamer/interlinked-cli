// ===========================================
// Per-edit mutation — stable identity derivation (build step 2)
// ===========================================
// Re-anchors an engine's raw line:col mutants to line-shift-invariant identities
// so "is this the same survivor as last run?" is a set-diff, not a guess. The
// crux of docs/design/per-edit-mutation-identity-and-manifest.md (§1–§2): anchor
// to the enclosing symbol + operator + token + ordinal, NEVER raw location.
//
// `typescript` is an optionalDependency (see cyclomatic-ast.ts for the identical
// load dance); absent ⇒ `mutationIdentityAvailable()` is false and the
// derivation returns null so callers degrade rather than crash. Loaded
// synchronously via createRequire; the self-contained hook never imports this.

// Stable mutant identity: the key that lets a manifest compare runs over time,
// across reorderings, and across unrelated edits made elsewhere in that file.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { extname } from "node:path";
import type * as TS from "typescript";
import type { MutantIdentity, RawMutant, StableId } from "./types.js";

type TsModule = typeof TS;

let tsCache: TsModule | null | undefined;

function loadTs(): TsModule | null {
	if (tsCache !== undefined) return tsCache;
	try {
		tsCache = createRequire(import.meta.url)("typescript") as TsModule;
	} catch {
		tsCache = null;
	}
	return tsCache;
}

/** True when the optional `typescript` dep is resolvable (→ identity available). */
export function mutationIdentityAvailable(): boolean {
	return loadTs() !== null;
}

/** 16-hex-char digest — short enough to read in a report, wide enough that a
 *  collision across one file's mutants is not a practical concern. */
/** 16 hex chars — short enough to read in a report, wide enough that a collision
 *  within one file's mutant set is not a practical concern. */
function sha16(parts: string[]): StableId {
	return createHash("sha256").update(parts.join("\x00")).digest("hex").slice(0, 16);
}

function scriptKindFor(ts: TsModule, filePath: string): TS.ScriptKind {
	switch (extname(filePath).toLowerCase()) {
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.ScriptKind.JS;
		default:
			return ts.ScriptKind.TS;
	}
}

function parseFile(ts: TsModule, file: string, content: string): TS.SourceFile {
	return ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
}

function isFunctionLike(ts: TsModule, node: TS.Node): boolean {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

/** Token-stream canonicalisation: spacing- and comment-insensitive (spec §2). */
function normalizeTokens(ts: TsModule, text: string): string {
	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest,
		/* skipTrivia */ true,
		ts.LanguageVariant.Standard,
		text,
	);
	const out: string[] = [];
	let tok = scanner.scan();
	while (tok !== ts.SyntaxKind.EndOfFileToken) {
		out.push(scanner.getTokenText());
		tok = scanner.scan();
	}
	return out.join(" ");
}

/** Best-effort local name for a function-like node (mirrors cyclomatic-ast). */
function localName(ts: TsModule, sf: TS.SourceFile, node: TS.Node): string {
	if (ts.isConstructorDeclaration(node)) return "constructor";
	const named = node as { name?: TS.Node };
	if (named.name && (ts.isIdentifier(named.name) || ts.isPrivateIdentifier(named.name))) {
		return named.name.getText(sf);
	}
	const p = node.parent;
	if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.getText(sf);
	if (p && ts.isPropertyAssignment(p)) return p.name.getText(sf);
	if (p && ts.isPropertyDeclaration(p)) return p.name.getText(sf);
	return "(anonymous)";
}

/** Qualified name "Outer.method" by walking enclosing classes / functions / namespaces. */
function qualifiedName(ts: TsModule, sf: TS.SourceFile, node: TS.Node): string {
	const parts: string[] = [];
	let cur: TS.Node | undefined = node;
	while (cur) {
		if (isFunctionLike(ts, cur)) parts.unshift(localName(ts, sf, cur));
		else if (ts.isClassDeclaration(cur) && cur.name) parts.unshift(cur.name.getText(sf));
		else if (ts.isModuleDeclaration(cur)) parts.unshift(cur.name.getText(sf));
		cur = cur.parent;
	}
	return parts.length > 0 ? parts.join(".") : "(module)";
}

function arityOf(node: TS.Node): number {
	return (node as TS.FunctionLikeDeclaration).parameters.length;
}

function symbolIdFor(file: string, qualified: string, arity: number): StableId {
	return sha16([file, qualified, String(arity)]);
}

/** Deepest function-like node whose span contains `offset`, or null (top level). */
function enclosingFunction(ts: TsModule, sf: TS.SourceFile, offset: number): TS.Node | null {
	let best: TS.Node | null = null;
	const visit = (node: TS.Node): void => {
		if (offset < node.getStart(sf) || offset >= node.getEnd()) return;
		if (isFunctionLike(ts, node)) best = node;
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return best;
}

interface ResolvedSite {
	symbolId: StableId;
	qualifiedName: string;
}

function resolveSite(ts: TsModule, sf: TS.SourceFile, file: string, offset: number): ResolvedSite {
	const fn = enclosingFunction(ts, sf, offset);
	const qn = fn ? qualifiedName(ts, sf, fn) : "(module)";
	const arity = fn ? arityOf(fn) : 0;
	return { symbolId: symbolIdFor(file, qn, arity), qualifiedName: qn };
}

function groupKey(symbolId: StableId, mutator: string, lexeme: string): string {
	return `${symbolId}\x00${mutator}\x00${lexeme}`;
}

/**
 * Re-anchor a file's raw mutants to stable identities. Ordinal is the rank of a
 * site's DISTINCT character offset within its (symbol, mutator, lexeme) group —
 * so two mutants at one token (same offset, different replacement) share a
 * `siteId` and differ only in `mutantId`. Returns null when typescript is absent.
 */
export function deriveIdentities(
	file: string,
	content: string,
	rawMutants: RawMutant[],
): MutantIdentity[] | null {
	const ts = loadTs();
	if (!ts) return null;
	const sf = parseFile(ts, file, content);

	const resolved = rawMutants.map((raw) => ({ raw, site: resolveSite(ts, sf, file, raw.startOffset) }));

	// ordinal = rank of distinct offset within each (symbol, mutator, lexeme) group
	const offsetsByGroup = new Map<string, Set<number>>();
	for (const r of resolved) {
		const key = groupKey(r.site.symbolId, r.raw.mutator, r.raw.originalLexeme);
		const set = offsetsByGroup.get(key) ?? new Set<number>();
		set.add(r.raw.startOffset);
		offsetsByGroup.set(key, set);
	}
	const rankByGroup = new Map<string, Map<number, number>>();
	for (const [key, set] of offsetsByGroup) {
		const sorted = [...set].sort((a, b) => a - b);
		rankByGroup.set(key, new Map(sorted.map((o, i) => [o, i])));
	}

	return resolved.map((r) => {
		const key = groupKey(r.site.symbolId, r.raw.mutator, r.raw.originalLexeme);
		const ordinal = rankByGroup.get(key)?.get(r.raw.startOffset) ?? 0;
		const siteId = sha16([r.site.symbolId, r.raw.mutator, r.raw.originalLexeme, String(ordinal)]);
		return {
			mutantId: sha16([siteId, r.raw.replacement]),
			siteId,
			symbolId: r.site.symbolId,
			qualifiedName: r.site.qualifiedName,
			mutator: r.raw.mutator,
			originalLexeme: r.raw.originalLexeme,
			replacement: r.raw.replacement,
			ordinalWithinSymbol: ordinal,
		};
	});
}

export interface SymbolHashEntry {
	qualifiedName: string;
	symbolHash: string;
}

/**
 * Per-symbol normalized-source hashes for the function-like symbols in a file —
 * the differential-skip / changed-region key (spec §3). Module/top-level scope
 * is deferred to a later increment. Returns null when typescript is absent.
 */
export function computeSymbolHashes(
	file: string,
	content: string,
): Map<StableId, SymbolHashEntry> | null {
	const ts = loadTs();
	if (!ts) return null;
	const sf = parseFile(ts, file, content);
	const out = new Map<StableId, SymbolHashEntry>();
	const walk = (node: TS.Node): void => {
		if (isFunctionLike(ts, node) && (node as TS.FunctionLikeDeclaration).body !== undefined) {
			const qn = qualifiedName(ts, sf, node);
			out.set(symbolIdFor(file, qn, arityOf(node)), {
				qualifiedName: qn,
				symbolHash: sha16([normalizeTokens(ts, node.getText(sf))]),
			});
		}
		ts.forEachChild(node, walk);
	};
	walk(sf);
	return out;
}
