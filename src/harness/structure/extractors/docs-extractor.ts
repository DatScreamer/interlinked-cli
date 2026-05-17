// ===========================================
// Docs Extractor — discovers documentation files
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode, DocKind, ExtractorMetadata, ExtractorResult } from "../types.js";
import { consumeWalkEntry, createWalkBudget, warnWalkTruncated, type WalkBudget } from "./bounded-walk.js";
import { SHARED_SKIP_DIRS } from "./skip-dirs.js";

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst"]);

/** Path segment that classifies a doc as reference material rather than a guide. */
const DOCS_DIR_SEGMENT = "docs";

const SKIP_DIRS = SHARED_SKIP_DIRS;

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
	if (parts.some((p) => p.toLowerCase() === DOCS_DIR_SEGMENT)) return "reference";
	return "guide";
}

interface WalkContext {
	repoRoot: string;
	nodes: ArtifactNode[];
	budget: WalkBudget;
}

function walkDir(dir: string, ctx: WalkContext): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		// Hard cap: stop descending/iterating once the entry or time budget trips.
		if (!consumeWalkEntry(ctx.budget)) return;
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walkDir(path.join(dir, entry.name), ctx);
			if (ctx.budget.truncated) return;
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name);
			const isReadme = /^README/i.test(entry.name);
			if (!DOC_EXTENSIONS.has(ext) && !isReadme) continue;
			const fullPath = path.join(dir, entry.name);
			const relPath = path.relative(ctx.repoRoot, fullPath);
			const localId = relPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
			const docKind = classifyDoc(relPath, entry.name);
			ctx.nodes.push({
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

export function extract(repoRoot: string, budget: WalkBudget = createWalkBudget()): ExtractorResult {
	const nodes: ArtifactNode[] = [];
	walkDir(repoRoot, { repoRoot, nodes, budget });
	if (budget.truncated) warnWalkTruncated(metadata.name, repoRoot);
	return { nodes, edges: [] };
}
