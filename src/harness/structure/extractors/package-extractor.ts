// ===========================================
// Package Extractor — discovers packages from manifest files
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactEdge, ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";

const PACKAGE_MARKERS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"];

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"__pycache__",
	"target",
	".interlinked",
	"interlinked",
]);

export const metadata: ExtractorMetadata = {
	name: "package-extractor",
	supported_patterns: PACKAGE_MARKERS,
	output_kinds: ["package"],
	provenance: "extracted",
	max_determinism: "partially_deterministic",
	version: 1,
};

function findPackages(
	dir: string,
	repoRoot: string,
	results: Array<{ relDir: string; file: string }>,
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			findPackages(path.join(dir, entry.name), repoRoot, results);
		} else if (entry.isFile() && PACKAGE_MARKERS.includes(entry.name)) {
			const relDir = path.relative(repoRoot, dir) || ".";
			const relFile = path.relative(repoRoot, path.join(dir, entry.name));
			results.push({ relDir, file: relFile });
		}
	}
}

export function extract(repoRoot: string): ExtractorResult {
	const nodes: ArtifactNode[] = [];
	const edges: ArtifactEdge[] = [];
	const packages: Array<{ relDir: string; file: string }> = [];

	findPackages(repoRoot, repoRoot, packages);

	if (packages.length === 0) {
		const localId = "root";
		nodes.push({
			id: makeGlobalRef("package", localId),
			kind: "package",
			label: "root",
			file: ".",
			provenance: "extracted",
			determinism_ceiling: "partially_deterministic",
		});
		return { nodes, edges };
	}

	// Sort by directory depth (shallowest first) for containment matching
	packages.sort((a, b) => a.relDir.length - b.relDir.length);

	for (const pkg of packages) {
		const localId = pkg.relDir === "." ? "root" : pkg.relDir.replace(/\//g, "-");
		nodes.push({
			id: makeGlobalRef("package", localId),
			kind: "package",
			label: pkg.relDir === "." ? "root" : pkg.relDir,
			file: pkg.file,
			provenance: "extracted",
			determinism_ceiling: "partially_deterministic",
		});
	}

	return { nodes, edges };
}

/**
 * Creates belongs_to_package edges from module nodes to the nearest containing package.
 * Call after merging module-extractor and package-extractor results.
 */
export function linkModulesToPackages(
	moduleNodes: ArtifactNode[],
	packageNodes: ArtifactNode[],
): ArtifactEdge[] {
	const edges: ArtifactEdge[] = [];
	// Sort packages by path length descending so longest (most specific) match wins
	const sorted = [...packageNodes].sort((a, b) => b.file.length - a.file.length);

	for (const mod of moduleNodes) {
		for (const pkg of sorted) {
			const pkgDir = pkg.file === "." ? "" : path.dirname(pkg.file);
			const isRoot = pkgDir === "" || pkgDir === ".";
			if (isRoot || mod.file.startsWith(`${pkgDir}/`) || mod.file === pkgDir) {
				const edgeId = makeEdgeId(mod.id, pkg.id);
				edges.push({
					id: edgeId,
					kind: "belongs_to_package",
					from: mod.id,
					to: pkg.id,
					provenance: "extracted",
					confidence: 0.95,
				});
				break;
			}
		}
	}
	return edges;
}
