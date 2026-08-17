// Tests for unvalidated_input_boundary (Plan 25 lane 8,
// docs/plans/25-refactor-readiness-program.md). Complements the existing
// `unvalidated_json_boundary` (checks/agent-safety-advanced-style.ts) —
// see unvalidated-input-boundary.ts for exactly how the two differ and why
// this detector must never fire on JSON.parse.

import { describe, expect, it } from "vitest";
import { detectUnvalidatedInputBoundary } from "./unvalidated-input-boundary.js";

const SRC = "src/example.ts";

describe("detectUnvalidatedInputBoundary — fetch/response .json()", () => {
	it("P1: awaited res.json() with no nearby schema-parse call fires", () => {
		const matches = detectUnvalidatedInputBoundary(
			[
				"async function load() {",
				"  const res = await fetch(url);",
				"  const data = await res.json();",
				"  return data.items;",
				"}",
			].join("\n"),
			SRC,
		);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0]?.text).toContain("unvalidated_input_boundary");
	});

	it("P2: a chained await fetch(...).json() with no nearby validation fires", () => {
		const matches = detectUnvalidatedInputBoundary(
			"async function load() {\n  return await fetch(url).json();\n}\n",
			SRC,
		);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("N1: a schema .parse( wrapping the same-line .json() call does not fire", () => {
		const matches = detectUnvalidatedInputBoundary(
			[
				"async function load() {",
				"  const parsed = MySchema.parse(await res.json());",
				"  return parsed.items;",
				"}",
			].join("\n"),
			SRC,
		);
		expect(matches).toEqual([]);
	});

	it("N2: a .safeParse( call one line below the .json() call does not fire", () => {
		const matches = detectUnvalidatedInputBoundary(
			[
				"async function load() {",
				"  const raw = await res.json();",
				"  const parsed = MySchema.safeParse(raw);",
				"  return parsed;",
				"}",
			].join("\n"),
			SRC,
		);
		expect(matches).toEqual([]);
	});

	it("N3: a local isFoo( type-predicate call nearby does not fire", () => {
		const matches = detectUnvalidatedInputBoundary(
			[
				"async function load() {",
				"  const raw = await res.json();",
				"  if (isFooPayload(raw)) return raw;",
				"}",
			].join("\n"),
			SRC,
		);
		expect(matches).toEqual([]);
	});

	it("N4: JSON.parse( never fires, even unvalidated (complements unvalidated_json_boundary)", () => {
		const matches = detectUnvalidatedInputBoundary(
			"const data = JSON.parse(raw);\nconsole.log(data.field);\n",
			SRC,
		);
		expect(matches).toEqual([]);
	});

	it("N5: Express-style res.json(payload) (a send, not a parse) does not fire", () => {
		const matches = detectUnvalidatedInputBoundary(
			"function handler(req, res) {\n  res.json({ ok: true });\n}\n",
			SRC,
		);
		expect(matches).toEqual([]);
	});

	it("N6: a non-awaited .then() chain does not fire (out of this detector's scope)", () => {
		const matches = detectUnvalidatedInputBoundary(
			"fetch(url).then((res) => res.json()).then((data) => use(data));\n",
			SRC,
		);
		expect(matches).toEqual([]);
	});
});

describe("detectUnvalidatedInputBoundary — process.argv indexing", () => {
	it("P3: process.argv[2] indexed directly in application logic fires", () => {
		const matches = detectUnvalidatedInputBoundary(
			"export function loadConfigPath() {\n  return process.argv[2];\n}\n",
			"src/lib/config-loader.ts",
		);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0]?.text).toContain("unvalidated_input_boundary");
	});

	it("N7: process.argv[2] in index.ts (an entry file) does not fire", () => {
		const matches = detectUnvalidatedInputBoundary(
			"const target = process.argv[2];\nrun(target);\n",
			"src/index.ts",
		);
		expect(matches).toEqual([]);
	});

	it("N8: process.argv[2] in cli.ts (an entry file) does not fire", () => {
		const matches = detectUnvalidatedInputBoundary(
			"const target = process.argv[2];\nrun(target);\n",
			"src/cli.ts",
		);
		expect(matches).toEqual([]);
	});

	it("N9: process.argv[2] under a bin/ directory does not fire", () => {
		const matches = detectUnvalidatedInputBoundary(
			"const target = process.argv[2];\nrun(target);\n",
			"bin/run.ts",
		);
		expect(matches).toEqual([]);
	});

	it("N10: process.argv with no numeric index does not fire", () => {
		const matches = detectUnvalidatedInputBoundary(
			"const rest = process.argv.slice(2);\n",
			"src/lib/config-loader.ts",
		);
		expect(matches).toEqual([]);
	});

	it("N12: process.argv[1] = <value> (a test-fixture WRITE, not a read) does not fire — the calibration fix", () => {
		const matches = detectUnvalidatedInputBoundary(
			'process.argv[1] = "/bin/interlinked";\nrun();\n',
			"src/lib/config-loader.test.ts",
		);
		expect(matches).toEqual([]);
	});

	it("P4: process.argv[2] === <literal> (a read used in a comparison) still fires", () => {
		const matches = detectUnvalidatedInputBoundary(
			'if (process.argv[2] === "--verbose") { setVerbose(); }\n',
			"src/lib/config-loader.ts",
		);
		expect(matches.length).toBeGreaterThan(0);
	});
});

describe("detectUnvalidatedInputBoundary — generic gates", () => {
	it("N11: a non-JS/TS file does not fire regardless of content", () => {
		const matches = detectUnvalidatedInputBoundary(
			"const data = await res.json();\ndata.items;\nprocess.argv[2];\n",
			"notes.md",
		);
		expect(matches).toEqual([]);
	});
});
