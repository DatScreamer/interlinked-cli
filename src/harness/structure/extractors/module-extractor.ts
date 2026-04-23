// ===========================================
// Module Extractor — discovers source modules by language extension
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";

const EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".rs",
	".go",
	".java",
	".c",
	".cpp",
	".h",
]);

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
	name: "module-extractor",
	supported_patterns: [...EXTENSIONS].map((e) => `*${e}`),
	output_kinds: ["module"],
	provenance: "extracted",
	max_determinism: "partially_deterministic",
	version: 1,
};

function walkDir(dir: string, repoRoot: string, nodes: ArtifactNode[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walkDir(path.join(dir, entry.name), repoRoot, nodes);
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name);
			if (!EXTENSIONS.has(ext)) continue;
			const fullPath = path.join(dir, entry.name);
			const relPath = path.relative(repoRoot, fullPath);
			const localId = relPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
			nodes.push({
				id: makeGlobalRef("module", localId),
				kind: "module",
				label: relPath,
				file: relPath,
				provenance: "extracted",
				determinism_ceiling: "partially_deterministic",
			});
		}
	}
}

export function extract(repoRoot: string): ExtractorResult {
	const nodes: ArtifactNode[] = [];
	walkDir(repoRoot, repoRoot, nodes);
	return { nodes, edges: [] };
}
