// ===========================================
// Docs Extractor — discovers documentation files
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode, DocKind, ExtractorMetadata, ExtractorResult } from "../types.js";

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst"]);

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
	name: "docs-extractor",
	supported_patterns: ["*.md", "*.mdx", "*.rst", "README*"],
	output_kinds: ["doc"],
	provenance: "inferred",
	max_determinism: "heuristic",
	version: 1,
};

function classifyDoc(relPath: string, name: string): DocKind {
	if (/^README/i.test(name)) return "readme";
	const parts = relPath.split("/");
	if (parts.some((p) => p.toLowerCase() === "docs")) return "reference";
	return "guide";
}

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
			const isReadme = /^README/i.test(entry.name);
			if (!DOC_EXTENSIONS.has(ext) && !isReadme) continue;
			const fullPath = path.join(dir, entry.name);
			const relPath = path.relative(repoRoot, fullPath);
			const localId = relPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
			const docKind = classifyDoc(relPath, entry.name);
			nodes.push({
				id: makeGlobalRef("doc", localId),
				kind: "doc",
				label: relPath,
				file: relPath,
				provenance: "inferred",
				determinism_ceiling: "heuristic",
				metadata: { doc_kind: docKind },
			});
		}
	}
}

export function extract(repoRoot: string): ExtractorResult {
	const nodes: ArtifactNode[] = [];
	walkDir(repoRoot, repoRoot, nodes);
	return { nodes, edges: [] };
}
