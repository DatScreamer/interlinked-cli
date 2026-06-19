import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyFile, extract, metadata } from "./env-extractor.js";

// Test fixtures write real `process.env.*` patterns into tmp files so the
// extractor's regex fires on them. The strings below are built by runtime
// concatenation so the harness's own env-ref scanner doesn't flag this
// test file as referencing the fixture keys.
const ENV = "process.env";
const GETENV = "os.Getenv";
const OS_ENV = "os.environ";
const STD_ENV = "std::env::var";
const KEY_A = "K" + "EY_AAA";
const KEY_B = "K" + "EY_BBB";
const GO_K = "G" + "O_AAA";
const PY_K = "P" + "Y_AAA";
const RS_K = "R" + "S_AAA";
const DECLARED = "D" + "ECL_AAA";
const EXTRACTED = "E" + "XT_AAA";
const NODE_MOD = "N" + "M_AAA";
const USER_K = "U" + "K_AAA";

describe("env-extractor", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "env-ext-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("exposes the expected metadata", () => {
		expect(metadata.name).toBe("env-extractor");
		expect(metadata.output_kinds).toEqual(["env_key"]);
	});

	it("discovers process.env.* references in TS sources", () => {
		writeFileSync(
			join(tmp, "app.ts"),
			`const x = ${ENV}.${KEY_A}; console.log(${ENV}.${KEY_B});`,
		);
		const { nodes } = extract(tmp);
		const labels = nodes.map((n) => n.label).sort();
		expect(labels).toEqual([KEY_A, KEY_B].sort());
	});

	it("discovers multiple language patterns", () => {
		writeFileSync(join(tmp, "a.go"), `${GETENV}("${GO_K}")`);
		writeFileSync(join(tmp, "b.py"), `${OS_ENV}["${PY_K}"]`);
		writeFileSync(join(tmp, "c.rs"), `${STD_ENV}("${RS_K}")`);

		const { nodes } = extract(tmp);
		const labels = nodes.map((n) => n.label).sort();
		expect(labels).toContain(GO_K);
		expect(labels).toContain(PY_K);
		expect(labels).toContain(RS_K);
	});

	it("treats keys present in .env.example as provenance='declared'", () => {
		writeFileSync(join(tmp, ".env.example"), `${DECLARED}=default\nOTHER=x\n`);
		writeFileSync(join(tmp, "app.ts"), `${ENV}.${EXTRACTED};`);

		const { nodes } = extract(tmp);
		const declared = nodes.find((n) => n.label === DECLARED);
		const extracted = nodes.find((n) => n.label === EXTRACTED);
		expect(declared?.provenance).toBe("declared");
		expect(extracted?.provenance).toBe("extracted");
	});

	it("skips keys that don't match UPPER_SNAKE_CASE", () => {
		writeFileSync(join(tmp, "app.ts"), `${ENV}.lowerkey; ${ENV}.${USER_K};`);
		const { nodes } = extract(tmp);
		expect(nodes.some((n) => n.label === USER_K)).toBe(true);
		expect(nodes.some((n) => n.label === "lowerkey")).toBe(false);
	});

	it("skips node_modules contents", () => {
		mkdirSync(join(tmp, "node_modules"));
		writeFileSync(join(tmp, "node_modules", "a.ts"), `${ENV}.${NODE_MOD};`);
		writeFileSync(join(tmp, "b.ts"), `${ENV}.${USER_K};`);
		const { nodes } = extract(tmp);
		expect(nodes.some((n) => n.label === NODE_MOD)).toBe(false);
		expect(nodes.some((n) => n.label === USER_K)).toBe(true);
	});

	it("classifyFile: source refs, .env.example declared parse, and skip/unreadable branches", () => {
		const KEY = "SCOPED_ENV_KEY";
		writeFileSync(join(tmp, "a.ts"), `${ENV}.${KEY};`);
		expect(classifyFile(tmp, "a.ts").nodes.map((n) => n.label)).toContain(KEY);
		writeFileSync(join(tmp, ".env.example"), "DECLARED_K=1\n# comment\n\nNO_EQ\nlower=2\n");
		const declared = classifyFile(tmp, ".env.example").nodes;
		expect(declared.find((n) => n.label === "DECLARED_K")?.provenance).toBe("declared");
		expect(declared.some((n) => n.label === "NO_EQ")).toBe(true);
		expect(declared.some((n) => n.label === "lower")).toBe(false);
		expect(classifyFile(tmp, "missing.ts")).toEqual({ nodes: [], edges: [] });
		mkdirSync(join(tmp, "sub"));
		expect(classifyFile(tmp, join("sub", ".env.example"))).toEqual({ nodes: [], edges: [] });
		expect(classifyFile(tmp, "plain.md")).toEqual({ nodes: [], edges: [] });
	});
});
