// ===========================================
// Test Extractor — discovers test files by naming conventions
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactEdge, ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";
import { SHARED_SKIP_DIRS } from "./skip-dirs.js";

const TEST_PATTERNS = [
	/\.test\.[tj]sx?$/,
	/\.spec\.[tj]sx?$/,
	/_test\.go$/,
	/_test\.py$/,
	/^test_.*\.py$/,
];

const TEST_DIRS = new Set(["__tests__", "tests", "test"]);

const SKIP_DIRS = SHARED_SKIP_DIRS;

export const metadata: ExtractorMetadata = {
	name: "test-extractor",
	supported_patterns: [
		"*.test.ts",
		"*.spec.ts",
		"*.test.js",
		"*.spec.js",
		"*_test.go",
		"*_test.py",
		"test_*.py",
	],
	output_kinds: ["test"],
	provenance: "inferred",
	max_determinism: "heuristic",
	version: 1,
};

function isTestFile(name: string): boolean {
	return TEST_PATTERNS.some((p) => p.test(name));
}

function isUnderTestDir(relPath: string): boolean {
	const parts = relPath.split("/");
	return parts.some((p) => TEST_DIRS.has(p));
}

function inferTestedModule(relPath: string): string | null {
	const dir = path.dirname(relPath);
	const base = path.basename(relPath);
	// src/foo.test.ts -> src/foo.ts
	const stripped = base
		.replace(/\.test(\.[tj]sx?)$/, "$1")
		.replace(/\.spec(\.[tj]sx?)$/, "$1")
		.replace(/_test(\.go)$/, "$1")
		.replace(/_test(\.py)$/, "$1")
		.replace(/^test_(.*\.py)$/, "$1");
	if (stripped === base) return null;
	// If under __tests__/, look one directory up
	const parentDir = path.basename(dir);
	const moduleDir = TEST_DIRS.has(parentDir) ? path.dirname(dir) : dir;
	return path.join(moduleDir, stripped);
}

interface WalkContext {
	repoRoot: string;
	nodes: ArtifactNode[];
	edges: ArtifactEdge[];
}

function walkDir(dir: string, ctx: WalkContext): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walkDir(path.join(dir, entry.name), ctx);
		} else if (entry.isFile()) {
			const relPath = path.relative(ctx.repoRoot, path.join(dir, entry.name));
			if (!isTestFile(entry.name) && !isUnderTestDir(relPath)) continue;
			const localId = relPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
			const testRef = makeGlobalRef("test", localId);
			ctx.nodes.push({
				id: testRef,
				kind: "test",
				label: relPath,
				file: relPath,
				provenance: "inferred",
				determinism_ceiling: "heuristic",
			});
			const testedPath = inferTestedModule(relPath);
			if (testedPath) {
				const moduleLocalId = testedPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
				const moduleRef = makeGlobalRef("module", moduleLocalId);
				ctx.edges.push({
					id: makeEdgeId(testRef, moduleRef),
					kind: "tests",
					from: testRef,
					to: moduleRef,
					provenance: "inferred",
					confidence: 0.7,
				});
			}
		}
	}
}

export function extract(repoRoot: string): ExtractorResult {
	const nodes: ArtifactNode[] = [];
	const edges: ArtifactEdge[] = [];
	walkDir(repoRoot, { repoRoot, nodes, edges });
	return { nodes, edges };
}
