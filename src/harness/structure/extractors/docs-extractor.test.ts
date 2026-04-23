import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extract, metadata } from "./docs-extractor.js";

describe("docs-extractor", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "docs-ext-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("exposes metadata + classifies README / docs/ / other .md", () => {
		expect(metadata.name).toBe("docs-extractor");
		expect(metadata.output_kinds).toEqual(["doc"]);
	});

	it("classifies README as doc_kind=readme", () => {
		writeFileSync(join(tmp, "README.md"), "# hi");
		const { nodes } = extract(tmp);
		expect(nodes[0].metadata?.doc_kind).toBe("readme");
	});

	it("classifies docs/*.md as doc_kind=reference", () => {
		mkdirSync(join(tmp, "docs"), { recursive: true });
		writeFileSync(join(tmp, "docs", "api.md"), "#");
		const { nodes } = extract(tmp);
		expect(nodes[0].metadata?.doc_kind).toBe("reference");
	});

	it("classifies standalone *.md as doc_kind=guide", () => {
		writeFileSync(join(tmp, "CONTRIBUTING.md"), "#");
		const { nodes } = extract(tmp);
		expect(nodes[0].metadata?.doc_kind).toBe("guide");
	});

	it("discovers .md, .mdx, and .rst files", () => {
		writeFileSync(join(tmp, "a.md"), "");
		writeFileSync(join(tmp, "b.mdx"), "");
		writeFileSync(join(tmp, "c.rst"), "");
		writeFileSync(join(tmp, "d.txt"), "");
		const { nodes } = extract(tmp);
		const labels = nodes.map((n) => n.label).sort();
		expect(labels).toEqual(["a.md", "b.mdx", "c.rst"]);
	});

	it("skips node_modules", () => {
		mkdirSync(join(tmp, "node_modules"));
		writeFileSync(join(tmp, "node_modules", "a.md"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toEqual([]);
	});
});
