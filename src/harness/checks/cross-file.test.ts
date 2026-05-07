import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkEmptyBodyHandler,
	checkListenerPairing,
	checkMigrationParity,
	checkSchemaTypeDrift,
} from "./cross-file.js";

const TS = "src/lib/foo.ts";
const TEST = "src/lib/foo.test.ts";

describe("checkEmptyBodyHandler", () => {
	it("flags handler-named function with empty body", () => {
		const code = `export function handleRequest(req: Request) {}`;
		expect(checkEmptyBodyHandler(code, TS).length).toBe(1);
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
});

describe("checkListenerPairing", () => {
	it("flags addEventListener without removeEventListener anywhere", () => {
		const code = `el.addEventListener("click", onClick);`;
		expect(checkListenerPairing(code, TS).length).toBe(1);
	});

	it("does not fire when removeEventListener appears in the same file", () => {
		const code = `
el.addEventListener("click", onClick);
el.removeEventListener("click", onClick);
`;
		expect(checkListenerPairing(code, TS)).toEqual([]);
	});

	it("flags process.on without process.off", () => {
		const code = `process.on("SIGINT", handler);`;
		expect(checkListenerPairing(code, TS).length).toBe(1);
	});

	it("does not fire in tests", () => {
		expect(checkListenerPairing(`el.addEventListener("x", fn);`, TEST)).toEqual([]);
	});
});

describe("checkSchemaTypeDrift", () => {
	it("flags Zod schema vs interface with different keys", () => {
		const code = `
import { z } from "zod";
const UserSchema = z.object({ id: z.string(), name: z.string(), email: z.string() });
interface User { id: string; name: string; }
`;
		const matches = checkSchemaTypeDrift(code, TS);
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("email");
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
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("0001_down.sql");
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
});
