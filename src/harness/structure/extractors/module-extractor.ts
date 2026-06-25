// ===========================================
// Module Extractor — discovers source modules by language extension
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";
import { consumeWalkEntry, createWalkBudget, type WalkBudget, warnWalkTruncated } from "./bounded-walk.js";
import { resolveIgnoredDirs, SHARED_SKIP_DIRS } from "./skip-dirs.js";

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
	ignoredDirs?: ReadonlySet<string>;
}

/** Classify ONE file into its module node, if its extension is a source one.
 *  Pure path logic (no fs read) — the single source of the module-node shape for
 *  both the full walk and the per-edited-file incremental refresh. `_repoRoot` is
 *  unused (paths are repo-relative) but kept for a uniform per-file signature. */
export function classifyFile(_repoRoot: string, relPath: string): ExtractorResult {
	if (!EXTENSIONS.has(path.extname(relPath))) return { nodes: [], edges: [] };
	const localId = relPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
	return {
		nodes: [
			{
				id: makeGlobalRef("module", localId),
				kind: "module",
				label: relPath,
				file: relPath,
				provenance: "extracted",
				determinism_ceiling: "partially_deterministic",
			},
		],
		edges: [],
	};
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
			const sub = path.join(dir, entry.name);
			if (SKIP_DIRS.has(entry.name) || ctx.ignoredDirs?.has(sub)) continue;
			walkDir(sub, ctx);
			if (ctx.budget.truncated) return;
		} else if (entry.isFile()) {
			const relPath = path.relative(ctx.repoRoot, path.join(dir, entry.name));
			ctx.nodes.push(...classifyFile(ctx.repoRoot, relPath).nodes);
		}
	}
}

export function extract(repoRoot: string, budget: WalkBudget = createWalkBudget()): ExtractorResult {
	const nodes: ArtifactNode[] = [];
	walkDir(repoRoot, { repoRoot, nodes, budget, ignoredDirs: resolveIgnoredDirs(repoRoot) });
	if (budget.truncated) warnWalkTruncated(metadata.name, repoRoot);
	return { nodes, edges: [] };
}
