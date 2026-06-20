import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactNode } from "../types.js";
import { classifyFile, extract, linkModulesToPackages, metadata } from "./package-extractor.js";
import { nonNull } from "../../../lib/non-null.js";

describe("package-extractor", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pkg-ext-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("metadata declares package markers it understands", () => {
		expect(metadata.name).toBe("package-extractor");
		expect(metadata.supported_patterns).toContain("package.json");
		expect(metadata.supported_patterns).toContain("Cargo.toml");
	});

	it("returns a synthetic `root` package when no manifest is present", () => {
		const { nodes } = extract(tmp);
		expect(nodes).toHaveLength(1);
		expect(nonNull(nodes[0]).label).toBe("root");
	});

	it("creates one node per manifest file (package.json + Cargo.toml)", () => {
		writeFileSync(join(tmp, "package.json"), "{}");
		mkdirSync(join(tmp, "crate"));
		writeFileSync(join(tmp, "crate", "Cargo.toml"), "");

		const { nodes } = extract(tmp);
		const labels = nodes.map((n) => n.label).sort();
		expect(labels).toContain("root");
		expect(labels).toContain("crate");
	});

	it("skips manifests inside node_modules", () => {
		mkdirSync(join(tmp, "node_modules", "lib"), { recursive: true });
		writeFileSync(join(tmp, "node_modules", "lib", "package.json"), "{}");
		writeFileSync(join(tmp, "package.json"), "{}");

		const { nodes } = extract(tmp);
		const labels = nodes.map((n) => n.label);
		expect(labels).toEqual(["root"]);
	});
});

describe("linkModulesToPackages", () => {
	it("links each module to the deepest containing package", () => {
		const modules: ArtifactNode[] = [
			{
				id: "module:a",
				kind: "module",
				label: "cli/src/x.ts",
				file: "cli/src/x.ts",
				provenance: "extracted",
				determinism_ceiling: "partially_deterministic",
			},
			{
				id: "module:b",
				kind: "module",
				label: "src/y.ts",
				file: "src/y.ts",
				provenance: "extracted",
				determinism_ceiling: "partially_deterministic",
			},
		];
		const packages: ArtifactNode[] = [
			{
				id: "package:root",
				kind: "package",
				label: "root",
				file: "package.json",
				provenance: "extracted",
				determinism_ceiling: "partially_deterministic",
			},
			{
				id: "package:cli",
				kind: "package",
				label: "cli",
				file: "cli/package.json",
				provenance: "extracted",
				determinism_ceiling: "partially_deterministic",
			},
		];
		const edges = linkModulesToPackages(modules, packages);
		expect(edges).toHaveLength(2);
		const aToCli = edges.find((e) => e.from === "module:a" && e.to === "package:cli");
		expect(aToCli).toBeDefined();
		const bToRoot = edges.find((e) => e.from === "module:b" && e.to === "package:root");
		expect(bToRoot).toBeDefined();
	});

	it("uses edge.kind=belongs_to_package", () => {
		const modules: ArtifactNode[] = [
			{
				id: "module:a",
				kind: "module",
				label: "x.ts",
				file: "x.ts",
				provenance: "extracted",
				determinism_ceiling: "partially_deterministic",
			},
		];
		const packages: ArtifactNode[] = [
			{
				id: "package:root",
				kind: "package",
				label: "root",
				file: ".",
				provenance: "extracted",
				determinism_ceiling: "partially_deterministic",
			},
		];
		const edges = linkModulesToPackages(modules, packages);
		expect(nonNull(edges[0]).kind).toBe("belongs_to_package");
	});

	it("classifyFile maps a marker file to its package node and ignores non-markers", () => {
		// classifyFile is path-only (repoRoot unused), so no tmp dir is needed.
		expect(classifyFile("/repo", "package.json").nodes[0]?.label).toBe("root");
		expect(classifyFile("/repo", join("pkgs", "a", "package.json")).nodes[0]?.label).toBe("pkgs/a");
		expect(classifyFile("/repo", "src/index.ts")).toEqual({ nodes: [], edges: [] });
	});
});
