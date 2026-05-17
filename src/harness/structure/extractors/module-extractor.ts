// ===========================================
// Module Extractor — discovers source modules by language extension
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";
import { consumeWalkEntry, createWalkBudget, warnWalkTruncated, type WalkBudget } from "./bounded-walk.js";
import { SHARED_SKIP_DIRS } from "./skip-dirs.js";

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

const SKIP_DIRS = SHARED_SKIP_DIRS;

export const metadata: ExtractorMetadata = {
	name: "module-extractor",
	supported_patterns: [...EXTENSIONS].map((e) => `*${e}`),
	output_kinds: ["module"],
	provenance: "extracted",
	max_determinism: "partially_deterministic",
	version: 1,
};

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
			if (!EXTENSIONS.has(ext)) continue;
			const fullPath = path.join(dir, entry.name);
			const relPath = path.relative(ctx.repoRoot, fullPath);
			const localId = relPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
			ctx.nodes.push({
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

export function extract(repoRoot: string, budget: WalkBudget = createWalkBudget()): ExtractorResult {
	const nodes: ArtifactNode[] = [];
	walkDir(repoRoot, { repoRoot, nodes, budget });
	if (budget.truncated) warnWalkTruncated(metadata.name, repoRoot);
	return { nodes, edges: [] };
}
