import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkEmptyBodyHandler,
	checkListenerPairing,
	checkMigrationParity,
	checkSchemaTypeDrift,
} from "./cross-file.js";

const TS = "src/lib/foo.ts";
const TEST = "src/lib/foo.test.ts";
const PY = "src/lib/foo.py";

const EMPTY_BODY_TEXT = (name: string) =>
	`handler-named function \`${name}\` has an empty / no-op body. Either implement it, throw a typed not-implemented error, or rename so the API surface doesn't lie.`;

const LISTENER_TEXT = (label: string, target: string) =>
	`${label} on \`${target}\` without paired cleanup elsewhere in this file. Listeners outlive the registering scope — pair with the matching off / removeListener / removeEventListener call in a teardown path.`;

describe("checkEmptyBodyHandler", () => {
	it("flags handler-named function with empty body", () => {
		const code = `export function handleRequest(req: Request) {}`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([{ line: 1, text: EMPTY_BODY_TEXT("handleRequest") }]);
	});

	it("flags handler with only console.log body", () => {
		const code = `function handleRequest(req) { console.log("got"); }`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("flags handler with only return;", () => {
		const code = `function onClick(e) { return; }`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("does not fire on a non-handler-named function", () => {
		expect(checkEmptyBodyHandler(`function foo() {}`, TS)).toEqual([]);
	});

	it("does not fire on a real implementation", () => {
		const code = `function handleRequest(req) { return new Response(); }`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("does not fire in test files", () => {
		expect(checkEmptyBodyHandler(`function handleRequest() {}`, TEST)).toEqual([]);
	});

	it("does not fire on non-JS/TS files", () => {
		expect(checkEmptyBodyHandler(`function handleRequest() {}`, PY)).toEqual([]);
	});

	it("skips a match with no `{` anywhere after the signature (openIdx < 0)", () => {
		const code = `function handleRequest(req) return 1;`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("skips a match whose `{` is more than 200 chars away", () => {
		const pad = "\n".repeat(250);
		const code = `function handleRequest(req)${pad}{ return 1; }`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("does not fire (and does not hang) when the handler body braces never balance/close", () => {
		const code = `function handleRequest(req) { if (true) {`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("computes the correct line number, ignoring newlines that appear after the match (kills a slice-removal mutant)", () => {
		const code = "\n\nfunction handleRequest(req) {}\n\n\nfoo();\n";
		expect(checkEmptyBodyHandler(code, TS)).toEqual([{ line: 3, text: EMPTY_BODY_TEXT("handleRequest") }]);
	});

	it("matches with multiple spaces between `function` and the handler name (kills a whitespace-mandatory regex mutant)", () => {
		const code = `function   handleRequest(req) {}`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("matches an async handler when `async` sits on its own line (kills a whitespace-class regex mutant)", () => {
		const code = "async\nfunction handleRequest(req) {}";
		expect(checkEmptyBodyHandler(code, TS)).toEqual([{ line: 1, text: EMPTY_BODY_TEXT("handleRequest") }]);
	});

	it("matches an arrow-function handler with multiple spaces after the const/let/var keyword", () => {
		// The arrow regex's own match consumes the opening `{`, so the body
		// scan starts from the NEXT `{` — an inner empty block, here.
		const code = `const   handleRequest = (req) => { {} };`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("does not treat a lowercase-after-`on` arrow name as a handler (kills the on[A-Z] -> on[^A-Z] negated-class mutant)", () => {
		const code = `const online = (req) => { {} };`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("recognizes a two-character on-prefixed arrow handler name with nothing after the capital letter, e.g. `onX` (kills the on[A-Z]\\w* -> on[A-Z]\\w mutant)", () => {
		const code = `const onX = (req) => { {} };`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("does not treat `onX--extra` as an arrow handler name — a non-word char right after the capital letter breaks the match (kills the on[A-Z]\\w* -> on[A-Z]\\W* mutant)", () => {
		const code = `const onX--extra = (req) => { {} };`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("matches an arrow handler with zero incidental whitespace anywhere around the `=`, params, and `=>` (kills 4 \\s*->\\s single-char-required mutants on the arrow pattern)", () => {
		const code = `const handleRequest=(req)=>{{}};`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("matches `async(` with zero space after async in an arrow handler (kills the async\\s* -> async\\s mutant)", () => {
		const code = `const handleRequest = async(req) => { {} };`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("matches `async (` with a space after async in an arrow handler (kills the async\\s* -> async\\S* mutant)", () => {
		const code = `const handleRequest = async (req) => { {} };`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("matches a return-type annotation with zero space after the colon (kills the :\\s* -> :\\s mutant)", () => {
		const code = `const handleRequest = (req):Response => { {} };`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("matches a multi-character return-type annotation (kills the [^=]+ -> [^=] and [^=]+ -> [=]+ mutants)", () => {
		const code = `const handleRequest = (req): Response => { {} };`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("caps findings at MAX_MATCHES (5) with 6+ empty handlers", () => {
		const code = Array.from({ length: 6 }, (_, i) => `function handle${i}() {}`).join("\n");
		expect(checkEmptyBodyHandler(code, TS).length).toBe(5);
	});

	it("recognizes console.log body with no internal spacing", () => {
		const code = `function handleRequest(req) {console.log("x")}`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("recognizes console.log body with generous internal spacing", () => {
		const code = `function handleRequest(req) { console . log ( "x" ) ; }`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("recognizes logger.warn body with no internal spacing", () => {
		const code = `function handleRequest(req) {logger.warn("x")}`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("recognizes logger.fatal body with generous internal spacing", () => {
		const code = `function handleRequest(req) { logger . fatal ( "x" ) ; }`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("recognizes bare `return;` with no surrounding space", () => {
		const code = `function handleRequest(req) {return;}`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("recognizes `return` with generous internal spacing", () => {
		const code = `function handleRequest(req) {  return  ;  }`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("does not treat a real single no-whitespace statement as an empty body (kills an all-non-whitespace pattern mutant)", () => {
		const code = `function handleRequest(req) {log();}`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("filters blank and whitespace-only lines so a console.log-only body across multiple blank lines is still flagged (kills filter/trim-removal mutants)", () => {
		const code = `function handleRequest(req) {\n   \n  console.log("x");\n\n}`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("filters brace-only lines so a purely-nested empty block is still empty (kills brace-literal filter mutants)", () => {
		const code = `function handleRequest(req) {\n  {\n  }\n}`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("treats a body with more than one real line as non-empty even when the first line alone looks trivial (kills the lines.length>1 short-circuit-removal mutant)", () => {
		const code = `function handleRequest(req) {\n  return;\n  console.log("more");\n}`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("does not treat a body as empty when real content follows an empty nested bare block after a trivial return (kills the nested-brace depth-tracking disabled mutants)", () => {
		const code = `function handleRequest(req) {\n  return;\n  {\n  }\n  doExtra();\n}`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("still does not fire when the far-away `{` (>200 chars) happens to itself be an empty block (kills the skip-guard condition/body-removal mutants)", () => {
		const pad = "\n".repeat(250);
		const code = `function handleRequest(req)${pad}{}`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("processes a `{` exactly 200 chars past the signature match, not skipping at the inclusive boundary (kills the >= / arithmetic-operator off-by-one mutants)", () => {
		const code = `function handleRequest(${"x".repeat(200)}{}`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("consumes a multi-char (2+) whitespace gap between `async` and `function`, reporting the earlier line where `async` starts (kills the async\\s+ -> exactly-one-char mutant)", () => {
		const code = "async\n\nfunction handleRequest(req) {}";
		expect(checkEmptyBodyHandler(code, TS)).toEqual([{ line: 1, text: EMPTY_BODY_TEXT("handleRequest") }]);
	});

	it("recognizes a two-character on-prefixed handler name with nothing after the capital letter, e.g. `onX` (kills the on[A-Z]\\w* -> on[A-Z]\\w mutant)", () => {
		const code = `function onX(req) {}`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("does not treat `onX--extra` as a handler name — a non-word char right after the capital letter breaks the match (kills the on[A-Z]\\w* -> on[A-Z]\\W* mutant)", () => {
		const code = "function onX--extra(req) {}";
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("tolerates a space between the handler name and its parameter-list paren (kills the \\s*\\( -> \\S*\\( mutant)", () => {
		const code = `function handleRequest (req) {}`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("does not treat a body starting with stray non-whitespace text before `return` as empty (kills the ^-anchor-removal and ^\\s*->^\\S* mutants on the return pattern)", () => {
		const code = `function handleRequest(req) {xreturn}`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("treats a bare `return` with no semicolon at all as an empty body (kills the ;? -> ; mandatory-semicolon mutant)", () => {
		const code = `function handleRequest(req) {return}`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
	});

	it("does not treat `return;` followed by stray non-whitespace text as empty (kills the trailing \\s*->\\S* mutant on the return pattern)", () => {
		const code = `function handleRequest(req) {return;x}`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("does not treat a body starting with stray non-whitespace text before `console.log` as empty (kills the ^-anchor-removal and ^\\s*->^\\S* mutants on the console pattern)", () => {
		const code = `function handleRequest(req) {xconsole.log()}`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("does not treat `console.log()` followed by stray non-whitespace text as empty (kills the trailing-$-removal and trailing \\s*->\\S* mutants on the console pattern)", () => {
		const code1 = `function handleRequest(req) {console.log()x}`;
		expect(checkEmptyBodyHandler(code1, TS)).toEqual([]);
		const code2 = `function handleOther(req) {console.log();x}`;
		expect(checkEmptyBodyHandler(code2, TS)).toEqual([]);
	});

	it("does not treat a body starting with stray non-whitespace text before `logger.info` as empty (kills the ^-anchor-removal and ^\\s*->^\\S* mutants on the logger pattern)", () => {
		const code = `function handleRequest(req) {xlogger.info()}`;
		expect(checkEmptyBodyHandler(code, TS)).toEqual([]);
	});

	it("does not treat `logger.info()` followed by stray non-whitespace text as empty (kills the trailing-$-removal and trailing \\s*->\\S* mutants on the logger pattern)", () => {
		const code1 = `function handleRequest(req) {logger.info()x}`;
		expect(checkEmptyBodyHandler(code1, TS)).toEqual([]);
		const code2 = `function handleOther(req) {logger.info();x}`;
		expect(checkEmptyBodyHandler(code2, TS)).toEqual([]);
	});
});

describe("checkListenerPairing", () => {
	it("flags addEventListener without removeEventListener anywhere", () => {
		const code = `el.addEventListener("click", onClick);`;
		expect(checkListenerPairing(code, TS)).toEqual([{ line: 1, text: LISTENER_TEXT("addEventListener", "el") }]);
	});

	it("does not fire when removeEventListener appears in the same file", () => {
		const code = `
el.addEventListener("click", onClick);
el.removeEventListener("click", onClick);
`;
		expect(checkListenerPairing(code, TS)).toEqual([]);
	});

	it("flags process.on without process.off", () => {
		const code = `\n\nprocess.on("SIGINT", handler);`;
		expect(checkListenerPairing(code, TS)).toEqual([{ line: 3, text: LISTENER_TEXT("EventEmitter.on", "process") }]);
	});

	it("does not fire in tests", () => {
		expect(checkListenerPairing(`el.addEventListener("x", fn);`, TEST)).toEqual([]);
	});

	it("does not fire on non-JS/TS files", () => {
		expect(checkListenerPairing(`el.addEventListener("x", fn);`, PY)).toEqual([]);
	});

	it("computes the correct line number, ignoring newlines that appear after the match (kills a slice-removal mutant)", () => {
		const code = '\n\nel.addEventListener("click", onClick);\n\n\nfoo();\n';
		expect(checkListenerPairing(code, TS)).toEqual([{ line: 3, text: LISTENER_TEXT("addEventListener", "el") }]);
	});

	it("tolerates whitespace around the addEventListener member-access dot and call parens, and multi-char target names (kills whitespace/star-drop regex mutants)", () => {
		const code = `myElement . addEventListener ("click", onClick);`;
		expect(checkListenerPairing(code, TS).length).toBe(1);
	});

	it("recognizes a paired removeEventListener with a space before the parenthesis", () => {
		const code = 'el.addEventListener("click", onClick);\nel.removeEventListener ("click", onClick);';
		expect(checkListenerPairing(code, TS)).toEqual([]);
	});

	it("tolerates whitespace around process.on's member-access dot and call parens", () => {
		const code = `process . on ("SIGINT", handler);`;
		expect(checkListenerPairing(code, TS).length).toBe(1);
	});

	it("recognizes process.off with no space before the parenthesis as valid cleanup", () => {
		const code = 'process.on("SIGINT", handler);\nprocess.off("SIGINT", handler);';
		expect(checkListenerPairing(code, TS)).toEqual([]);
	});

	it("recognizes process.off with a space before the parenthesis as valid cleanup", () => {
		const code = 'process.on("SIGINT", handler);\nprocess.off ("SIGINT", handler);';
		expect(checkListenerPairing(code, TS)).toEqual([]);
	});

	it("stops scanning entirely once MAX_MATCHES is reached, even if a second listener kind is also unpaired", () => {
		const code = `
el1.addEventListener("a", f1);
el2.addEventListener("a", f2);
el3.addEventListener("a", f3);
el4.addEventListener("a", f4);
el5.addEventListener("a", f5);
process.on("SIGINT", handler);
`;
		const matches = checkListenerPairing(code, TS);
		expect(matches.length).toBe(5);
		expect(matches.every((m) => m.text.startsWith("addEventListener"))).toBe(true);
	});

	it("caps a single listener kind at MAX_MATCHES (5) with 6+ unpaired occurrences", () => {
		const code = Array.from({ length: 6 }, (_, i) => `el${i}.addEventListener("click", fn${i});`).join("\n");
		expect(checkListenerPairing(code, TS).length).toBe(5);
	});
});

describe("checkSchemaTypeDrift", () => {
	it("flags Zod schema vs interface with different keys", () => {
		const code = `
const UserSchema = z.object({ id: z.string(), name: z.string(), email: z.string() });
interface User { id: string; name: string; }
`;
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("email");
	});

	it("does not fire when shapes match", () => {
		const code = `
const UserSchema = z.object({ id: z.string(), name: z.string() });
interface User { id: string; name: string; }
`;
		expect(checkSchemaTypeDrift(code, TS)).toEqual([]);
	});

	it("does not fire when there's no matching type", () => {
		const code = `const UserSchema = z.object({ id: z.string() });`;
		expect(checkSchemaTypeDrift(code, TS)).toEqual([]);
	});

	it("does not pair a schema with an unrelated type name declared nearby (kills a forced-true partner-match mutant)", () => {
		const code = `
const FooSchema = z.object({ a: z.string() });
interface Bar { a: string; b: string; }
`;
		expect(checkSchemaTypeDrift(code, TS)).toEqual([]);
	});

	it("does not fire in test files", () => {
		const code = `const UserSchema = z.object({ id: z.string() }); interface User { name: string; }`;
		expect(checkSchemaTypeDrift(code, TEST)).toEqual([]);
	});

	it("does not fire on non-JS/TS files", () => {
		const code = `const UserSchema = z.object({ id: z.string() }); interface User { name: string; }`;
		expect(checkSchemaTypeDrift(code, PY)).toEqual([]);
	});

	it("flags drift when the type has an extra key the schema lacks (onlyInType), with the exact message pinned", () => {
		const code = `
const UserSchema = z.object({ id: z.string() });
interface User { id: string; name: string; }
`;
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches).toEqual([
			{
				line: 2,
				text: "schema/type drift between `UserSchema` and `User` — only in type: name. The type and the runtime validator should agree; derive one from the other.",
			},
		]);
	});

	it("flags drift when the schema has an extra key the type lacks (onlyInSchema), with the exact message pinned", () => {
		const code = `
const UserSchema = z.object({ id: z.string(), email: z.string() });
interface User { id: string; }
`;
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches).toEqual([
			{
				line: 2,
				text: "schema/type drift between `UserSchema` and `User` — only in schema: email. The type and the runtime validator should agree; derive one from the other.",
			},
		]);
	});

	it("flags drift with BOTH onlyInSchema and onlyInType present, exact joined message pinned", () => {
		const code = `
const UserSchema = z.object({ id: z.string(), email: z.string() });
interface User { id: string; age: number; }
`;
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches).toEqual([
			{
				line: 2,
				text: "schema/type drift between `UserSchema` and `User` — only in schema: email; only in type: age. The type and the runtime validator should agree; derive one from the other.",
			},
		]);
	});

	it("ignores an unclosed zod schema block (unbalanced braces never extract a key set)", () => {
		const code = `const UserSchema = z.object({ id: z.string()
interface User { id: string; name: string; }`;
		expect(checkSchemaTypeDrift(code, TS)).toEqual([]);
	});

	it("ignores an unclosed interface block (unbalanced braces never extract a key set)", () => {
		const code = `
const UserSchema = z.object({ id: z.string(), name: z.string() });
interface User { id: string; name: string
`;
		expect(checkSchemaTypeDrift(code, TS)).toEqual([]);
	});

	it("caps drift findings at MAX_MATCHES (3) even with 4+ drifting pairs", () => {
		const code = `
const AlphaSchema = z.object({ a: z.string(), extra1: z.string() });
interface Alpha { a: string; }
const BetaSchema = z.object({ b: z.string(), extra2: z.string() });
interface Beta { b: string; }
const GammaSchema = z.object({ c: z.string(), extra3: z.string() });
interface Gamma { c: string; }
const DeltaSchema = z.object({ d: z.string(), extra4: z.string() });
interface Delta { d: string; }
`;
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches.length).toBe(3);
	});

	it("does not pair a schema whose name merely CONTAINS a suffix word mid-string with an unrelated same-rooted type (anchors the suffix strip to end-of-string)", () => {
		const code = `
const SchemaAlpha = z.object({ a: z.string(), b: z.string() });
interface Alpha { a: string; }
`;
		expect(checkSchemaTypeDrift(code, TS)).toEqual([]);
	});

	it("does not pair two schemas with each other even when their stripped names collide (the types-only filter is real, not a passthrough)", () => {
		const code = `
const AlphaSchema = z.object({ a: z.string() });
const AlphaValidator = z.object({ a: z.string(), b: z.string() });
`;
		expect(checkSchemaTypeDrift(code, TS)).toEqual([]);
	});

	it("matches Zod schemas and interfaces with no incidental whitespace anywhere (kills whitespace-mandatory regex mutants)", () => {
		const code = `const TightSchema=z.object({a:z.string(),b:z.string()});\ninterface Tight{a:string;}`;
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("only in schema: b");
	});

	it("matches Zod schemas and interfaces with generous incidental whitespace everywhere (kills whitespace-forbidding regex mutants)", () => {
		const code = `const  LooseSchema  =  z . object ( {  a : z.string() ,  b : z.string()  } ) ;\ninterface  Loose  {  a : string ;  }`;
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("only in schema: b");
	});

	it("matches a `type Foo = { ... }` alias form (not just `interface`), with generous whitespace", () => {
		const code = `const ThingSchema = z.object({ a: z.string(), b: z.string() });\ntype  Thing  =  {  a : string ;  }`;
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("only in schema: b");
	});

	it("captures a schema's very first key (immediately after the opening brace, no preceding delimiter) — kills the ^-anchor-removal regex mutant on the key extractor", () => {
		const code = `
const UserSchema = z.object({ uniqueFirst: z.string(), shared: z.string() });
interface User { shared: string; }
`;
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("only in schema: uniqueFirst");
	});

	it("consumes a multi-char gap between `export` and `const`, reporting the earlier line where `export` starts (kills the export\\s+ -> exactly-one-char and export\\s+ -> export\\S+ mutants)", () => {
		const code =
			"export\n\nconst UserSchema = z.object({ a: z.string(), b: z.string() });\ninterface User { a: string; }";
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(1);
	});

	it("matches a Zod schema declaration carrying its own multi-character TS type annotation, e.g. `: ZodType` (kills the [^=]+ -> [^=] and [^=]+ -> [=]+ mutants on the schema's own type-annotation group)", () => {
		const code = "const UserSchema: ZodType = z.object({ a: z.string(), b: z.string() });\ninterface User { a: string; }";
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("only in schema: b");
	});

	it("reports line 1 for a schema/type pair declared on the very first line, not line 2 (kills the match-fallback-array mutant on the newline-count computation)", () => {
		const code = `const AlphaSchema = z.object({ a: z.string(), b: z.string() });\ninterface Alpha { a: string; }`;
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches).toEqual([
			{
				line: 1,
				text: "schema/type drift between `AlphaSchema` and `Alpha` — only in schema: b. The type and the runtime validator should agree; derive one from the other.",
			},
		]);
	});

	it("locates its own `{` even when an earlier unrelated `{` exists in the file (kills the indexOf-search-start arithmetic-operator mutant)", () => {
		const code = `
interface Decoy { z: string; }
const UserSchema = z.object({ id: z.string(), name: z.string() });
interface User { id: string; name: string; }
`;
		expect(checkSchemaTypeDrift(code, TS)).toEqual([]);
	});

	it("truncates the reported onlyInSchema drift keys to the first 4 even when more exist (kills the .slice(0,4) removal / string-blanking mutants)", () => {
		const code = `
const BigSchema = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string(), e: z.string() });
interface Big { }
`;
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("only in schema: a, b, c, d");
		expect(nonNull(matches[0]).text).not.toMatch(/\be\b/);
	});

	it("truncates the reported onlyInType drift keys to the first 4 even when more exist (kills the .slice(0,4) removal / string-blanking mutants on the type side)", () => {
		const code = `
const SmallSchema = z.object({ });
interface Small { a: string; b: string; c: string; d: string; e: string; }
`;
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("only in type: a, b, c, d");
		expect(nonNull(matches[0]).text).not.toMatch(/\be\b/);
	});
});

describe("checkMigrationParity", () => {
	let migrationsDir: string;

	beforeEach(() => {
		migrationsDir = mkdtempSync(join(tmpdir(), "migrations-"));
		const subDir = join(migrationsDir, "migrations");
		mkdirSync(subDir, { recursive: true });
		migrationsDir = subDir;
	});

	afterEach(() => {
		// best-effort cleanup; OS will reap tmp dirs.
	});

	it("flags up.sql without down.sql in the same dir", () => {
		writeFileSync(join(migrationsDir, "0001_up.sql"), "CREATE TABLE foo();");
		const filePath = join(migrationsDir, "0001_up.sql");
		const matches = checkMigrationParity("CREATE TABLE foo();", filePath);
		expect(matches).toEqual([
			{
				line: 1,
				text: `migration 0001_up.sql has no matching 0001_down.sql in ${migrationsDir} — every up should have a paired down so the migration is reversible.`,
			},
		]);
	});

	it("does not fire when paired down.sql exists", () => {
		writeFileSync(join(migrationsDir, "0001_up.sql"), "CREATE TABLE foo();");
		writeFileSync(join(migrationsDir, "0001_down.sql"), "DROP TABLE foo;");
		const filePath = join(migrationsDir, "0001_up.sql");
		expect(checkMigrationParity("", filePath)).toEqual([]);
	});

	it("does not fire on files outside migrations dirs", () => {
		expect(checkMigrationParity("", "/tmp/random/0001_up.sql")).toEqual([]);
	});

	it("does not fire in test files even inside a migrations dir", () => {
		writeFileSync(join(migrationsDir, "0001_up.test.sql"), "");
		const filePath = join(migrationsDir, "0001_up.test.sql");
		expect(checkMigrationParity("", filePath)).toEqual([]);
	});

	it("does not duplicate-report when called on a sibling file in the same dir", () => {
		// 0001_up.sql is missing its down. The check is called per-file in
		// the verify pipeline. Only the file that IS the unpaired up should
		// trigger a finding — calling on a sibling (the orphan down's twin,
		// a README, the next migration) must return [].
		writeFileSync(join(migrationsDir, "0001_up.sql"), "CREATE TABLE foo();");
		writeFileSync(join(migrationsDir, "0002_up.sql"), "CREATE TABLE bar();");
		writeFileSync(join(migrationsDir, "0002_down.sql"), "DROP TABLE bar;");
		writeFileSync(join(migrationsDir, "README.md"), "");
		// Called on the orphan up — fires.
		expect(checkMigrationParity("", join(migrationsDir, "0001_up.sql")).length).toBe(1);
		// Called on a paired up — silent.
		expect(checkMigrationParity("", join(migrationsDir, "0002_up.sql"))).toEqual([]);
		// Called on the README in the same dir — silent (was firing before).
		expect(checkMigrationParity("", join(migrationsDir, "README.md"))).toEqual([]);
		// Called on the paired down — silent.
		expect(checkMigrationParity("", join(migrationsDir, "0002_down.sql"))).toEqual([]);
	});

	it("returns [] when the path matches the migrations dir pattern but the dir does not exist (existsSync false)", () => {
		const base = mkdtempSync(join(tmpdir(), "no-migrations-dir-"));
		const filePath = join(base, "migrations", "0001_up.sql");
		expect(checkMigrationParity("", filePath)).toEqual([]);
	});

	it("returns [] when the matched migrations path exists but is a file, not a directory (statSync().isDirectory() false)", () => {
		const base = mkdtempSync(join(tmpdir(), "migrations-is-file-"));
		writeFileSync(join(base, "migrations"), "not a directory");
		const filePath = join(base, "migrations", "0001_up.sql");
		expect(checkMigrationParity("", filePath)).toEqual([]);
	});

	it("returns [] when readdirSync throws (e.g. permission denied reading the migrations dir)", () => {
		writeFileSync(join(migrationsDir, "0001_up.sql"), "CREATE TABLE foo();");
		const filePath = join(migrationsDir, "0001_up.sql");
		chmodSync(migrationsDir, 0o000);
		try {
			expect(checkMigrationParity("", filePath)).toEqual([]);
		} finally {
			chmodSync(migrationsDir, 0o755);
		}
	});

	it("does not treat a file merely containing `_up.sql` mid-name (not at the very end) as a migration file", () => {
		writeFileSync(join(migrationsDir, "0001_up.sql.bak"), "");
		const filePath = join(migrationsDir, "0001_up.sql.bak");
		expect(checkMigrationParity("", filePath)).toEqual([]);
	});

	it("recognizes a bare `up.sql` file with no prefix delimiter", () => {
		writeFileSync(join(migrationsDir, "up.sql"), "");
		const filePath = join(migrationsDir, "up.sql");
		const matches = checkMigrationParity("", filePath);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("down.sql");
		expect(nonNull(matches[0]).text).not.toContain("undefineddown.sql");
	});

	it("computes the down-migration filename anchored to the true end, even when `up.sql` appears earlier in the name too", () => {
		writeFileSync(join(migrationsDir, "0001_up.sql_up.sql"), "");
		const filePath = join(migrationsDir, "0001_up.sql_up.sql");
		const matches = checkMigrationParity("", filePath);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("0001_up.sql_down.sql");
	});

	it("recognizes migrations dirs under the `migrate`, `db/migrations`, and `prisma/migrations` alternate spellings", () => {
		const base = mkdtempSync(join(tmpdir(), "migrate-alt-"));
		const dbMigrations = join(base, "db", "migrations");
		mkdirSync(dbMigrations, { recursive: true });
		writeFileSync(join(dbMigrations, "0001_up.sql"), "");
		const filePath = join(dbMigrations, "0001_up.sql");
		const matches = checkMigrationParity("", filePath);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("0001_down.sql");
	});

	it("does not fire on an up.sql inside a /tests/ directory, even though it's also inside a migrations dir (isolates the isTestFile guard from the UP_SQL_RE guard; kills the isTestFile-disabled mutant)", () => {
		const base = mkdtempSync(join(tmpdir(), "migrations-in-tests-"));
		const testsMigrations = join(base, "tests", "migrations");
		mkdirSync(testsMigrations, { recursive: true });
		writeFileSync(join(testsMigrations, "0001_up.sql"), "");
		const filePath = join(testsMigrations, "0001_up.sql");
		expect(checkMigrationParity("", filePath)).toEqual([]);
	});
});
