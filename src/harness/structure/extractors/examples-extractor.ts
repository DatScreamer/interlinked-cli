// ===========================================
// Examples Extractor — discovers example/demo files
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";
import { consumeWalkEntry, createWalkBudget, warnWalkTruncated, type WalkBudget } from "./bounded-walk.js";
import { SHARED_SKIP_DIRS } from "./skip-dirs.js";

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
}

function collectFiles(dir: string, ctx: WalkContext): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		// Hard cap: stop descending/iterating once the entry or time budget trips.
		if (!consumeWalkEntry(ctx.budget)) return;
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			collectFiles(fullPath, ctx);
			if (ctx.budget.truncated) return;
		} else if (entry.isFile()) {
			const relPath = path.relative(ctx.repoRoot, fullPath);
			const localId = relPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
			ctx.nodes.push({
				id: makeGlobalRef("example", localId),
				kind: "example",
				label: relPath,
				file: relPath,
				provenance: "inferred",
				determinism_ceiling: "heuristic",
			});
		}
	}
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
		if (!entry.isDirectory()) continue;
		if (SKIP_DIRS.has(entry.name)) continue;
		if (EXAMPLE_DIRS.has(entry.name)) {
			collectFiles(path.join(dir, entry.name), ctx);
		} else {
			walkDir(path.join(dir, entry.name), ctx);
		}
		if (ctx.budget.truncated) return;
	}
}

export function extract(repoRoot: string, budget: WalkBudget = createWalkBudget()): ExtractorResult {
	const nodes: ArtifactNode[] = [];
	walkDir(repoRoot, { repoRoot, nodes, budget });
	if (budget.truncated) warnWalkTruncated(metadata.name, repoRoot);
	return { nodes, edges: [] };
}
