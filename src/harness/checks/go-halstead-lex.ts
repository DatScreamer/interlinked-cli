// ===========================================
// Go tokenizer for Halstead counting
// ===========================================
// Tokenizes Go source so the walker can count the same operator/operand
// classes as github.com/luisantonioig/halstead-metrics (go/ast Inspect).

export type GoTokKind =
	| "ident"
	| "int"
	| "float"
	| "imag"
	| "string"
	| "rune"
	| "keyword"
	| "op"
	| "lparen"
	| "rparen"
	| "lbrack"
	| "rbrack"
	| "lbrace"
	| "rbrace"
	| "comma"
	| "semi"
	| "colon"
	| "eof";

export interface GoTok {
	kind: GoTokKind;
	text: string;
	line: number;
}

const KEYWORDS = new Set([
	"break",
	"case",
	"chan",
	"const",
	"continue",
	"default",
	"defer",
	"else",
	"fallthrough",
	"for",
	"func",
	"go",
	"goto",
	"if",
	"import",
	"interface",
	"map",
	"package",
	"range",
	"return",
	"select",
	"struct",
	"switch",
	"type",
	"var",
]);

const TWO = new Set([
	":=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"<<",
	">>",
	"<-",
	"++",
	"--",
	"...",
]);

const THREE = new Set(["<<=", ">>=", "&^="]);

export function lexGo(src: string): GoTok[] {
	const out: GoTok[] = [];
	let i = 0;
	let line = 1;
	const n = src.length;

	const push = (kind: GoTokKind, text: string, atLine: number): void => {
		out.push({ kind, text, line: atLine });
	};

	while (i < n) {
		const c = src[i] as string;
		if (c === "\n") {
			line += 1;
			i += 1;
			continue;
		}
		if (c === " " || c === "\t" || c === "\r") {
			i += 1;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			while (i < n && src[i] !== "\n") i += 1;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			i += 2;
			while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
				if (src[i] === "\n") line += 1;
				i += 1;
			}
			i += 2;
			continue;
		}
		if (isIdentStart(c)) {
			const start = i;
			const at = line;
			i += 1;
			while (i < n && isIdentPart(src[i] as string)) i += 1;
			const text = src.slice(start, i);
			push(KEYWORDS.has(text) ? "keyword" : "ident", text, at);
			continue;
		}
		if (c >= "0" && c <= "9") {
			i = lexNumber(src, i, line, push);
			continue;
		}
		if (c === '"') {
			const start = i;
			const at = line;
			i = skipString(src, i + 1, '"', (ch) => {
				if (ch === "\n") line += 1;
			});
			push("string", src.slice(start, i), at);
			continue;
		}
		if (c === "`") {
			const start = i;
			const at = line;
			i += 1;
			while (i < n && src[i] !== "`") {
				if (src[i] === "\n") line += 1;
				i += 1;
			}
			i += 1;
			push("string", src.slice(start, i), at);
			continue;
		}
		if (c === "'") {
			const start = i;
			const at = line;
			i = skipString(src, i + 1, "'");
			push("rune", src.slice(start, i), at);
			continue;
		}
		const three = src.slice(i, i + 3);
		if (THREE.has(three)) {
			push("op", three, line);
			i += 3;
			continue;
		}
		if (three === "...") {
			push("op", "...", line);
			i += 3;
			continue;
		}
		const two = src.slice(i, i + 2);
		if (TWO.has(two)) {
			push("op", two, line);
			i += 2;
			continue;
		}
		i = lexPunct(c, line, push, i);
	}
	push("eof", "", line);
	return out;
}

function lexPunct(c: string, line: number, push: (k: GoTokKind, t: string, l: number) => void, i: number): number {
	switch (c) {
		case "(":
			push("lparen", c, line);
			return i + 1;
		case ")":
			push("rparen", c, line);
			return i + 1;
		case "[":
			push("lbrack", c, line);
			return i + 1;
		case "]":
			push("rbrack", c, line);
			return i + 1;
		case "{":
			push("lbrace", c, line);
			return i + 1;
		case "}":
			push("rbrace", c, line);
			return i + 1;
		case ",":
			push("comma", c, line);
			return i + 1;
		case ";":
			push("semi", c, line);
			return i + 1;
		case ":":
			push("colon", c, line);
			return i + 1;
		default:
			push("op", c, line);
			return i + 1;
	}
}

function lexNumber(
	src: string,
	start: number,
	line: number,
	push: (k: GoTokKind, t: string, l: number) => void,
): number {
	let i = start;
	while (i < src.length && /[0-9a-fA-FxXoO_.]/.test(src[i] as string)) i += 1;
	if (src[i] === "i") i += 1;
	const text = src.slice(start, i);
	const kind: GoTokKind = text.endsWith("i") ? "imag" : text.includes(".") ? "float" : "int";
	push(kind, text, line);
	return i;
}

function skipString(src: string, from: number, end: string, onChar?: (ch: string) => void): number {
	let i = from;
	while (i < src.length) {
		const ch = src[i] as string;
		onChar?.(ch);
		if (ch === "\\") {
			i += 2;
			continue;
		}
		i += 1;
		if (ch === end) break;
	}
	return i;
}

function isIdentStart(c: string): boolean {
	return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isIdentPart(c: string): boolean {
	return isIdentStart(c) || (c >= "0" && c <= "9");
}

export const GO_BUILTINS = new Set([
	"append",
	"cap",
	"clear",
	"close",
	"complex",
	"copy",
	"delete",
	"imag",
	"len",
	"make",
	"max",
	"min",
	"new",
	"panic",
	"print",
	"println",
	"real",
	"recover",
]);
