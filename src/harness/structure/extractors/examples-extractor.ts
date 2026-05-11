// ===========================================
// Examples Extractor — discovers example/demo files
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";
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

function collectFiles(dir: string, repoRoot: string, nodes: ArtifactNode[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			collectFiles(fullPath, repoRoot, nodes);
		} else if (entry.isFile()) {
			const relPath = path.relative(repoRoot, fullPath);
			const localId = relPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
			nodes.push({
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

function walkDir(dir: string, repoRoot: string, nodes: ArtifactNode[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (SKIP_DIRS.has(entry.name)) continue;
		if (EXAMPLE_DIRS.has(entry.name)) {
			collectFiles(path.join(dir, entry.name), repoRoot, nodes);
		} else {
			walkDir(path.join(dir, entry.name), repoRoot, nodes);
		}
	}
}

export function extract(repoRoot: string): ExtractorResult {
	const nodes: ArtifactNode[] = [];
	walkDir(repoRoot, repoRoot, nodes);
	return { nodes, edges: [] };
}
