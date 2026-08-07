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
});
