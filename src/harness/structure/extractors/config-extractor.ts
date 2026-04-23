// ===========================================
// Config Extractor — discovers config access patterns in JS/TS files
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

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

const CONFIG_PATTERNS = [
	/config\.get\(["']([a-zA-Z0-9_.]+)["']\)/g,
	/config\[["']([a-zA-Z0-9_.]+)["']\]/g,
	/config\.([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)/g,
];

export const metadata: ExtractorMetadata = {
	name: "config-extractor",
	supported_patterns: ['config.get("key")', 'config["key"]', "config.key.subkey"],
	output_kinds: ["config_key"],
	provenance: "extracted",
	max_determinism: "heuristic",
	version: 1,
};

function scanFile(content: string, configKeys: Map<string, string>, relPath: string): void {
	for (const pattern of CONFIG_PATTERNS) {
		pattern.lastIndex = 0;
		for (;;) {
			const match = pattern.exec(content);
			if (match === null) break;
			const key = match[1];
			if (!configKeys.has(key)) {
				configKeys.set(key, relPath);
			}
		}
	}
}

function walkDir(dir: string, repoRoot: string, configKeys: Map<string, string>): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walkDir(path.join(dir, entry.name), repoRoot, configKeys);
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name);
			if (!SOURCE_EXTENSIONS.has(ext)) continue;
			const fullPath = path.join(dir, entry.name);
			const relPath = path.relative(repoRoot, fullPath);
			try {
				const content = fs.readFileSync(fullPath, "utf-8");
				scanFile(content, configKeys, relPath);
			} catch (_err) {
				void 0; /* intentional: skip unreadable files */
			}
		}
	}
}

export function extract(repoRoot: string): ExtractorResult {
	const configKeys = new Map<string, string>();
	walkDir(repoRoot, repoRoot, configKeys);
	const nodes: ArtifactNode[] = [];
	for (const [key, file] of configKeys) {
		const localId = key;
		nodes.push({
			id: makeGlobalRef("config_key", localId),
			kind: "config_key",
			label: key,
			file,
			provenance: "extracted",
			determinism_ceiling: "heuristic",
		});
	}
	return { nodes, edges: [] };
}
