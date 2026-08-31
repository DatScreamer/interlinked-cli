// ===========================================
// Examples Extractor — discovers example/demo files
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";
import { consumeWalkEntry, createWalkBudget, type WalkBudget, warnWalkTruncated } from "./bounded-walk.js";
import { isRootScratchDir, resolveIgnoredDirs, SHARED_SKIP_DIRS } from "./skip-dirs.js";

const EXAMPLE_DIRS = new Set(["examples", "sample", "samples", "demo"]);

const SKIP_DIRS = SHARED_SKIP_DIRS;

export const metadata: ExtractorMetadata = {
	name: "examples-extractor",
	supported_patterns: ["examples/**", "sample/**", "samples/**", "demo/**"],
	output_kinds: ["example"],
	provenance: "inferred",
	max_determinism: "heuristic",
	version: 1,
};

interface WalkContext {
	repoRoot: string;
	nodes: ArtifactNode[];
	budget: WalkBudget;
	ignoredDirs?: ReadonlySet<string>;
}

/** A file is an "example" iff one of its directory segments is in EXAMPLE_DIRS
 *  (examples/sample/samples/demo). Pure path logic — the single source of the
 *  example-node shape for the full walk and the per-edited-file refresh. */
export function classifyFile(_repoRoot: string, relPath: string): ExtractorResult {
	const dir = path.dirname(relPath);
	if (dir === "." || !dir.split("/").some((seg) => EXAMPLE_DIRS.has(seg))) {
		return { nodes: [], edges: [] };
	}
	const localId = relPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
	return {
		nodes: [
			{
				id: makeGlobalRef("example", localId),
				kind: "example",
				label: relPath,
				file: relPath,
				provenance: "inferred",
				determinism_ceiling: "heuristic",
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
			if (SKIP_DIRS.has(entry.name) || isRootScratchDir(ctx.repoRoot, sub) || ctx.ignoredDirs?.has(sub)) continue;
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
