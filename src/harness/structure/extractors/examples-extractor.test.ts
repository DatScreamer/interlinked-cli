import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { extract, metadata } from "./examples-extractor.js";

describe("examples-extractor", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "ex-ext-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("metadata declares it handles examples/ / samples/ / demo/ dirs", () => {
		expect(metadata.name).toBe("examples-extractor");
		expect(metadata.output_kinds).toEqual(["example"]);
	});

	it("discovers files under examples/", () => {
		mkdirSync(join(tmp, "examples"), { recursive: true });
		writeFileSync(join(tmp, "examples", "basic.ts"), "");
		writeFileSync(join(tmp, "examples", "advanced.ts"), "");
		writeFileSync(join(tmp, "src.ts"), ""); // NOT an example

		const { nodes } = extract(tmp);
		expect(nodes).toHaveLength(2);
		expect(nodes.every((n) => n.kind === "example")).toBe(true);
	});

	it("discovers files under samples/ and demo/ too", () => {
		mkdirSync(join(tmp, "samples"), { recursive: true });
		writeFileSync(join(tmp, "samples", "x.ts"), "");
		mkdirSync(join(tmp, "demo"), { recursive: true });
		writeFileSync(join(tmp, "demo", "y.ts"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toHaveLength(2);
	});

	it("returns empty when no example dirs exist", () => {
		writeFileSync(join(tmp, "src.ts"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toEqual([]);
	});

	it("recurses into nested example subdirectories", () => {
		mkdirSync(join(tmp, "examples", "subdir"), { recursive: true });
		writeFileSync(join(tmp, "examples", "subdir", "deep.ts"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toHaveLength(1);
		expect(nonNull(nodes[0]).label).toBe("examples/subdir/deep.ts");
	});

	it("skips heavy dirs (node_modules) even under an example dir", () => {
		mkdirSync(join(tmp, "examples", "node_modules", "dep"), { recursive: true });
		writeFileSync(join(tmp, "examples", "node_modules", "dep", "index.ts"), "");
		writeFileSync(join(tmp, "examples", "real.ts"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toHaveLength(1);
		expect(nodes[0]?.label).toBe("examples/real.ts");
	});

	it("returns empty for a missing/unreadable root (readdirSync catch)", () => {
		expect(extract(join(tmp, "does-not-exist")).nodes).toEqual([]);
	});
});
