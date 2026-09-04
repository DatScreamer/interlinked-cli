// ===========================================
// Go Halstead inspector — luisantonioig/halstead-metrics policy
// ===========================================
// Mirrors ast_analyzer.go: operators are AST constructs (call, index, if,
// :=, …), not every punctuation token. package/import are not operators.
// Operands are classified without go/types using call/selector heuristics
// (pkg:fmt, func:Println, var:x, field:name, builtin:make).

import { GO_BUILTINS, type GoTok, type GoTokKind, lexGo } from "./go-halstead-lex.js";

export interface GoHalsteadCounts {
	operators: Map<string, number>;
	operands: Map<string, number>;
}

export interface GoFunctionHalstead {
	name: string;
	kind: "func_decl" | "func_lit";
	line: number;
	counts: GoHalsteadCounts;
}

export interface GoHalsteadReport {
	file: GoHalsteadCounts;
	functions: GoFunctionHalstead[];
}

function emptyCounts(): GoHalsteadCounts {
	return { operators: new Map(), operands: new Map() };
}

function bump(map: Map<string, number>, key: string, n = 1): void {
	map.set(key, (map.get(key) ?? 0) + n);
}

function addOp(c: GoHalsteadCounts, name: string, n = 1): void {
	if (n > 0) bump(c.operators, name, n);
}

function addOperand(c: GoHalsteadCounts, name: string): void {
	bump(c.operands, name);
}

const ASSIGN = new Set([":=", "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "&^="]);
const BINARY = new Set([
	"+",
	"-",
	"*",
	"/",
	"%",
	"&",
	"|",
	"^",
	"&^",
	"<<",
	">>",
	"==",
	"!=",
	"<",
	">",
	"<=",
	">=",
	"&&",
	"||",
]);
const UNARY = new Set(["+", "-", "!", "^", "&", "*", "<-"]);

/** Analyze one Go file. Returns null when the source is not a Go compilation unit. */
export function analyzeGoHalstead(src: string): GoHalsteadReport | null {
	const tokens = lexGo(src);
	if (!hasPackageClause(tokens)) return null;
	const file = emptyCounts();
	inspectRange(tokens, 0, tokens.length, file);
	return { file, functions: collectFunctions(tokens) };
}

function hasPackageClause(tokens: GoTok[]): boolean {
	return tokens.some((t) => t.kind === "keyword" && t.text === "package");
}

function collectFunctions(tokens: GoTok[]): GoFunctionHalstead[] {
	const out: GoFunctionHalstead[] = [];
	let i = 0;
	while (i < tokens.length) {
		const t = tokens[i];
		if (!t || t.kind !== "keyword" || t.text !== "func") {
			i += 1;
			continue;
		}
		const start = i;
		const name = readFuncName(tokens, i);
		const kind: GoFunctionHalstead["kind"] = braceDepthAt(tokens, i) > 0 ? "func_lit" : "func_decl";
		const end = skipFuncNode(tokens, i);
		const counts = emptyCounts();
		inspectRange(tokens, start, end, counts);
		out.push({ name, kind, line: t.line, counts });
		i = start + 1;
	}
	return out;
}

function braceDepthAt(tokens: GoTok[], index: number): number {
	let depth = 0;
	for (let i = 0; i < index; i++) {
		const t = tokens[i];
		if (t?.kind === "lbrace") depth += 1;
		else if (t?.kind === "rbrace") depth -= 1;
	}
	return depth;
}

function readFuncName(tokens: GoTok[], funcIdx: number): string {
	let i = funcIdx + 1;
	const t = tokens[i];
	if (t?.kind === "lparen") {
		const close = matchPair(tokens, i, "lparen", "rparen");
		const after = tokens[close + 1];
		const recv = receiverText(tokens, i + 1, close);
		const name = after?.kind === "ident" ? after.text : "func";
		return `${recv}.${name}`;
	}
	if (t?.kind === "ident") return t.text;
	return `func_literal@${tokens[funcIdx]?.line ?? 0}`;
}

function receiverText(tokens: GoTok[], from: number, to: number): string {
	for (let i = to - 1; i >= from; i--) {
		const t = tokens[i];
		if (t?.kind === "ident") {
			const prev = tokens[i - 1];
			return prev?.text === "*" ? `*${t.text}` : t.text;
		}
	}
	return "T";
}

function skipFuncNode(tokens: GoTok[], funcIdx: number): number {
	let i = funcIdx + 1;
	while (i < tokens.length) {
		const t = tokens[i];
		if (!t || t.kind === "eof") return i;
		if (t.kind === "lbrace") return matchPair(tokens, i, "lbrace", "rbrace") + 1;
		if (t.kind === "semi") return i + 1;
		i += 1;
	}
	return i;
}

function matchPair(tokens: GoTok[], open: number, l: GoTokKind, r: GoTokKind): number {
	let depth = 0;
	for (let i = open; i < tokens.length; i++) {
		const t = tokens[i];
		if (t?.kind === l) depth += 1;
		else if (t?.kind === r) {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return tokens.length - 1;
}

function inspectRange(tokens: GoTok[], from: number, to: number, c: GoHalsteadCounts): void {
	let i = from;
	while (i < to) {
		const t = tokens[i];
		if (!t || t.kind === "eof") break;
		if (t.kind === "keyword" && (t.text === "package" || t.text === "import")) {
			i = skipPackageOrImport(tokens, i);
			continue;
		}
		const next = stepInspect(tokens, i, to, c);
		if (next <= i) i += 1;
		else i = next;
	}
}

function skipPackageOrImport(tokens: GoTok[], i: number): number {
	const t = tokens[i];
	if (t?.text === "package") return i + 2;
	const n = tokens[i + 1];
	if (n?.kind === "lparen") return matchPair(tokens, i + 1, "lparen", "rparen") + 1;
	return i + 2;
}

function stepInspect(tokens: GoTok[], i: number, to: number, c: GoHalsteadCounts): number {
	const t = tokens[i];
	if (!t) return i + 1;
	if (t.kind === "keyword") return countKeyword(t.text, tokens, i, to, c);
	if (t.kind === "op") return countOpToken(tokens, i, to, c);
	if (t.kind === "lbrack") return countIndexOrSlice(tokens, i, to, c);
	if (t.kind === "lbrace") return countCompositeOrBlock(tokens, i, c);
	if (t.kind === "ident") return countIdent(tokens, i, c);
	if (t.kind === "int" || t.kind === "float" || t.kind === "imag" || t.kind === "string" || t.kind === "rune") {
		addOperand(c, t.text);
		return i + 1;
	}
	return i + 1;
}

function countKeyword(text: string, tokens: GoTok[], i: number, _to: number, c: GoHalsteadCounts): number {
	switch (text) {
		case "func":
		case "return":
		case "if":
		case "for":
		case "switch":
		case "select":
		case "go":
		case "defer":
		case "range":
		case "const":
		case "var":
		case "type":
			addOp(c, text);
			return i + 1;
		case "case":
			addOp(c, "case");
			return i + 1;
		case "default":
			addOp(c, "default");
			return i + 1;
		case "break":
		case "continue":
		case "goto":
		case "fallthrough":
			addOp(c, text);
			return i + 1;
		default:
			return i + 1;
	}
}

function countOpToken(tokens: GoTok[], i: number, to: number, c: GoHalsteadCounts): number {
	const t = tokens[i];
	if (!t) return i + 1;
	if (ASSIGN.has(t.text)) {
		addOp(c, t.text, countLhs(tokens, i));
		return i + 1;
	}
	if (t.text === "++" || t.text === "--") {
		addOp(c, t.text);
		return i + 1;
	}
	if (t.text === "<-") {
		addOp(c, "<-");
		return i + 1;
	}
	if (t.text === ".") return countDot(tokens, i, to, c);
	if (BINARY.has(t.text) || UNARY.has(t.text)) {
		addOp(c, t.text);
		return i + 1;
	}
	return i + 1;
}

function countLhs(tokens: GoTok[], assignAt: number): number {
	let commas = 0;
	for (let i = assignAt - 1; i >= 0; i--) {
		const t = tokens[i];
		if (!t) break;
		if (t.kind === "semi" || t.kind === "lbrace" || t.kind === "keyword") break;
		if (t.kind === "comma") commas += 1;
	}
	return commas + 1;
}

function countDot(tokens: GoTok[], i: number, to: number, c: GoHalsteadCounts): number {
	const next = tokens[i + 1];
	const after = tokens[i + 2];
	if (next?.kind === "lparen") {
		addOp(c, "type-assert");
		return i + 1;
	}
	addOp(c, ".");
	if (next?.kind === "ident" && after?.kind === "lparen") {
		// selector used as call: Fun is SelectorExpr; CallExpr still counted at ident+(
		return i + 1;
	}
	void to;
	return i + 1;
}

function countIndexOrSlice(tokens: GoTok[], i: number, to: number, c: GoHalsteadCounts): number {
	const close = matchPair(tokens, i, "lbrack", "rbrack");
	let slice = false;
	for (let j = i + 1; j < close && j < to; j++) {
		if (tokens[j]?.kind === "colon") slice = true;
	}
	addOp(c, slice ? "slice" : "index");
	return i + 1;
}

function countCompositeOrBlock(tokens: GoTok[], i: number, c: GoHalsteadCounts): number {
	const prev = tokens[i - 1];
	if (prev && (prev.kind === "ident" || prev.kind === "rbrack" || prev.text === "struct" || prev.kind === "rparen")) {
		addOp(c, "composite");
	}
	return i + 1;
}

function isFuncNameIdent(tokens: GoTok[], i: number): boolean {
	const prev = tokens[i - 1];
	if (prev?.kind === "keyword" && prev.text === "func") return true;
	if (prev?.kind !== "rparen") return false;
	let depth = 0;
	for (let j = i - 1; j >= 0; j--) {
		const t = tokens[j];
		if (t?.kind === "rparen") depth += 1;
		else if (t?.kind === "lparen") {
			depth -= 1;
			if (depth === 0) {
				const before = tokens[j - 1];
				return before?.kind === "keyword" && before.text === "func";
			}
		}
	}
	return false;
}

function countIdent(tokens: GoTok[], i: number, c: GoHalsteadCounts): number {
	const t = tokens[i];
	if (!t || t.text === "_") return i + 1;
	const next = tokens[i + 1];
	const prev = tokens[i - 1];
	if (next?.kind === "lparen") {
		if (isFuncNameIdent(tokens, i)) {
			addOperand(c, `func:${t.text}`);
			return i + 1;
		}
		addOp(c, "call");
		if (GO_BUILTINS.has(t.text)) addOperand(c, `builtin:${t.text}`);
		else addOperand(c, `func:${t.text}`);
		return i + 1;
	}
	if (prev?.kind === "op" && prev.text === ".") {
		// Call-shaped `recv.Name(` is handled by the `next?.kind === "lparen"`
		// branch above, so this is a field/selector operand.
		addOperand(c, `field:${t.text}`);
		return i + 1;
	}
	if (next?.kind === "op" && next.text === ".") {
		addOperand(c, `pkg:${t.text}`);
		return i + 1;
	}
	addOperand(c, `var:${t.text}`);
	return i + 1;
}
