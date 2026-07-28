import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../../../lib/non-null.js";
import { metadata as configMetadata, extract as extractConfig } from "../config-extractor.js";
import { metadata as docsMetadata, extract as extractDocs } from "../docs-extractor.js";
import { metadata as envMetadata, extract as extractEnv } from "../env-extractor.js";
import { metadata as examplesMetadata, extract as extractExamples } from "../examples-extractor.js";
import { allExtractors, runAllExtractors } from "../index.js";
import { extract as extractModules, metadata as moduleMetadata } from "../module-extractor.js";
import {
	extract as extractPackages,
	linkModulesToPackages,
	metadata as packageMetadata,
} from "../package-extractor.js";
import { extract as extractTests, metadata as testMetadata } from "../test-extractor.js";

let tmpDir: string;

function write(relPath: string, content = ""): void {
	const full = path.join(tmpDir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "extractors-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("module-extractor", () => {
	it("discovers source files by extension", () => {
		write("src/app.ts", "export const x = 1;");
		write("src/utils/helper.js", "");
		write("lib/main.py", "");
		write("README.md", "# Hi");
		const result = extractModules(tmpDir);
		expect(result.nodes).toHaveLength(3);
		expect(result.nodes.map((n) => n.kind)).toEqual(["module", "module", "module"]);
		expect(result.edges).toHaveLength(0);
	});

	it("skips node_modules and dist", () => {
		write("node_modules/foo/index.js", "");
		write("dist/bundle.js", "");
		write("src/real.ts", "");
		const result = extractModules(tmpDir);
		expect(result.nodes).toHaveLength(1);
		expect(nonNull(result.nodes[0]).file).toBe("src/real.ts");
	});

	it("has correct metadata", () => {
		expect(moduleMetadata.name).toBe("module-extractor");
		expect(moduleMetadata.output_kinds).toEqual(["module"]);
		expect(moduleMetadata.provenance).toBe("extracted");
	});
});

describe("package-extractor", () => {
	it("discovers package.json files", () => {
		write("package.json", '{"name":"root"}');
		write("packages/lib/package.json", '{"name":"lib"}');
		const result = extractPackages(tmpDir);
		expect(result.nodes).toHaveLength(2);
		expect(result.nodes.map((n) => n.kind)).toEqual(["package", "package"]);
	});

	it("falls back to root package when no markers found", () => {
		write("src/index.ts", "");
		const result = extractPackages(tmpDir);
		expect(result.nodes).toHaveLength(1);
		expect(nonNull(result.nodes[0]).label).toBe("root");
	});

	it("links modules to packages", () => {
		write("package.json", "{}");
		write("packages/lib/package.json", "{}");
		write("packages/lib/src/index.ts", "");
		write("src/main.ts", "");
		const pkgResult = extractPackages(tmpDir);
		const modResult = extractModules(tmpDir);
		const edges = linkModulesToPackages(modResult.nodes, pkgResult.nodes);
		expect(edges.length).toBeGreaterThan(0);
		expect(edges.every((e) => e.kind === "belongs_to_package")).toBe(true);
	});

	it("has correct metadata", () => {
		expect(packageMetadata.name).toBe("package-extractor");
		expect(packageMetadata.output_kinds).toEqual(["package"]);
	});
});

describe("env-extractor", () => {
	it("finds process.env references in JS/TS", () => {
		write(
			"src/config.ts",
			"const url = process.env.DATABASE_URL;\nconst key = process.env.API_KEY;",
		);
		const result = extractEnv(tmpDir);
		expect(result.nodes).toHaveLength(2);
		const labels = result.nodes.map((n) => n.label).sort();
		expect(labels).toEqual(["API_KEY", "DATABASE_URL"]);
	});

	it("finds env vars from .env.example with declared provenance", () => {
		write(".env.example", "DATABASE_URL=postgres://localhost\nSECRET_KEY=");
		const result = extractEnv(tmpDir);
		expect(result.nodes).toHaveLength(2);
		expect(result.nodes.every((n) => n.provenance === "declared")).toBe(true);
	});

	it("deduplicates env keys across files", () => {
		write("src/a.ts", "process.env.MY_VAR");
		write("src/b.ts", "process.env.MY_VAR");
		const result = extractEnv(tmpDir);
		expect(result.nodes).toHaveLength(1);
	});

	it("has correct metadata", () => {
		expect(envMetadata.name).toBe("env-extractor");
		expect(envMetadata.output_kinds).toEqual(["env_key"]);
	});
});

describe("test-extractor", () => {
	it("discovers test files by naming convention", () => {
		write("src/app.test.ts", "");
		write("src/utils.spec.js", "");
		write("src/app.ts", "");
		const result = extractTests(tmpDir);
		expect(result.nodes).toHaveLength(2);
		expect(result.nodes.every((n) => n.kind === "test")).toBe(true);
	});

	it("creates tests edges linking to modules", () => {
		write("src/app.test.ts", "");
		write("src/app.ts", "");
		const result = extractTests(tmpDir);
		expect(result.edges).toHaveLength(1);
		expect(nonNull(result.edges[0]).kind).toBe("tests");
		expect(nonNull(result.edges[0]).to).toBe("module:src-app");
	});

	it("discovers files under __tests__ directories", () => {
		write("src/__tests__/helper.ts", "");
		const result = extractTests(tmpDir);
		expect(result.nodes).toHaveLength(1);
	});

	it("has correct metadata", () => {
		expect(testMetadata.name).toBe("test-extractor");
		expect(testMetadata.provenance).toBe("inferred");
	});
});

describe("docs-extractor", () => {
	it("discovers markdown files", () => {
		write("README.md", "# Hello");
		write("docs/guide.md", "# Guide");
		write("src/main.ts", "");
		const result = extractDocs(tmpDir);
		expect(result.nodes).toHaveLength(2);
		expect(result.nodes.every((n) => n.kind === "doc")).toBe(true);
	});

	it("classifies README files as readme kind", () => {
		write("README.md", "# Project");
		const result = extractDocs(tmpDir);
		expect(nonNull(result.nodes[0]).metadata?.doc_kind).toBe("readme");
	});

	it("classifies docs/ files as reference kind", () => {
		write("docs/api.md", "# API");
		const result = extractDocs(tmpDir);
		expect(nonNull(result.nodes[0]).metadata?.doc_kind).toBe("reference");
	});

	it("has correct metadata", () => {
		expect(docsMetadata.name).toBe("docs-extractor");
		expect(docsMetadata.output_kinds).toEqual(["doc"]);
	});
});

describe("examples-extractor", () => {
	it("discovers files under examples/ directory", () => {
		write("examples/basic.ts", "");
		write("examples/advanced/multi.ts", "");
		write("src/main.ts", "");
		const result = extractExamples(tmpDir);
		expect(result.nodes).toHaveLength(2);
		expect(result.nodes.every((n) => n.kind === "example")).toBe(true);
	});

	it("discovers files under demo/ directory", () => {
		write("demo/app.js", "");
		const result = extractExamples(tmpDir);
		expect(result.nodes).toHaveLength(1);
	});

	it("returns empty for repos without example dirs", () => {
		write("src/main.ts", "");
		const result = extractExamples(tmpDir);
		expect(result.nodes).toHaveLength(0);
	});

	it("has correct metadata", () => {
		expect(examplesMetadata.name).toBe("examples-extractor");
		expect(examplesMetadata.output_kinds).toEqual(["example"]);
	});
});

describe("config-extractor", () => {
	it("finds config.get() patterns", () => {
		write(
			"src/db.ts",
			'const host = config.get("database.host");\nconst port = config.get("database.port");',
		);
		const result = extractConfig(tmpDir);
		expect(result.nodes).toHaveLength(2);
		const labels = result.nodes.map((n) => n.label).sort();
		expect(labels).toEqual(["database.host", "database.port"]);
	});

	it("finds config[key] bracket patterns", () => {
		write("src/app.ts", 'const val = config["app.secret"];');
		const result = extractConfig(tmpDir);
		expect(result.nodes).toHaveLength(1);
		expect(nonNull(result.nodes[0]).label).toBe("app.secret");
	});

	it("finds config.dotted.access patterns", () => {
		write("src/app.ts", "const v = config.server.port;");
		const result = extractConfig(tmpDir);
		expect(result.nodes).toHaveLength(1);
		expect(nonNull(result.nodes[0]).label).toBe("server.port");
	});

	it("has correct metadata", () => {
		expect(configMetadata.name).toBe("config-extractor");
		expect(configMetadata.output_kinds).toEqual(["config_key"]);
	});
});

describe("index barrel", () => {
	it("exports all 7 extractors", () => {
		expect(allExtractors).toHaveLength(7);
	});

	it("runAllExtractors merges results and creates package edges", () => {
		write("package.json", "{}");
		write("src/app.ts", "process.env.NODE_ENV");
		write("src/app.test.ts", "");
		write("README.md", "# Hi");
		const result = runAllExtractors(tmpDir);
		const kinds = new Set(result.nodes.map((n) => n.kind));
		expect(kinds.has("module")).toBe(true);
		expect(kinds.has("package")).toBe(true);
		expect(kinds.has("env_key")).toBe(true);
		expect(kinds.has("test")).toBe(true);
		expect(kinds.has("doc")).toBe(true);
		// Should have belongs_to_package edges
		const pkgEdges = result.edges.filter((e) => e.kind === "belongs_to_package");
		expect(pkgEdges.length).toBeGreaterThan(0);
	});
});
