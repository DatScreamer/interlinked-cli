// ===========================================
// Env Extractor — discovers environment variable references
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";
import { SHARED_SKIP_DIRS } from "./skip-dirs.js";

const SOURCE_EXTENSIONS = new Set([
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

const ENV_PATTERNS = [
	/process\.env\.([A-Z][A-Z0-9_]*)/g,
	/import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
	/os\.Getenv\("([A-Z][A-Z0-9_]*)"\)/g,
	/os\.environ\["([A-Z][A-Z0-9_]*)"\]/g,
	/getenv\("([A-Z][A-Z0-9_]*)"\)/g,
	/std::env::var\("([A-Z][A-Z0-9_]*)"\)/g,
];

export const metadata: ExtractorMetadata = {
	name: "env-extractor",
	supported_patterns: [
		"process.env.*",
		"import.meta.env.*",
		"os.Getenv()",
		"os.environ[]",
		"getenv()",
		"std::env::var()",
	],
	output_kinds: ["env_key"],
	provenance: "extracted",
	max_determinism: "partially_deterministic",
	version: 1,
};

function scanFile(
	filePath: string,
	content: string,
	envKeys: Map<string, { provenance: "extracted" | "declared"; file: string }>,
): void {
	for (const pattern of ENV_PATTERNS) {
		pattern.lastIndex = 0;
		for (;;) {
			const match = pattern.exec(content);
			if (match === null) break;
			const key = match[1];
			if (!envKeys.has(key)) {
				envKeys.set(key, { provenance: "extracted", file: filePath });
			}
		}
	}
}

function walkDir(
	dir: string,
	repoRoot: string,
	envKeys: Map<string, { provenance: "extracted" | "declared"; file: string }>,
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walkDir(path.join(dir, entry.name), repoRoot, envKeys);
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name);
			if (!SOURCE_EXTENSIONS.has(ext)) continue;
			const fullPath = path.join(dir, entry.name);
			const relPath = path.relative(repoRoot, fullPath);
			try {
				const content = fs.readFileSync(fullPath, "utf-8");
				scanFile(relPath, content, envKeys);
			} catch (_err) {
				void 0; /* intentional: skip unreadable files */
			}
		}
	}
}

function scanEnvExample(
	repoRoot: string,
	envKeys: Map<string, { provenance: "extracted" | "declared"; file: string }>,
): void {
	const examplePath = path.join(repoRoot, ".env.example");
	try {
		const content = fs.readFileSync(examplePath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.startsWith("#")) continue;
			const eqIdx = trimmed.indexOf("=");
			const key = eqIdx >= 0 ? trimmed.slice(0, eqIdx).trim() : trimmed;
			if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
				envKeys.set(key, { provenance: "declared", file: ".env.example" });
			}
		}
	} catch (_err) {
		void 0; /* intentional: no .env.example present */
	}
}

export function extract(repoRoot: string): ExtractorResult {
	const envKeys = new Map<string, { provenance: "extracted" | "declared"; file: string }>();
	scanEnvExample(repoRoot, envKeys);
	walkDir(repoRoot, repoRoot, envKeys);
	const nodes: ArtifactNode[] = [];
	for (const [key, info] of envKeys) {
		nodes.push({
			id: makeGlobalRef("env_key", key),
			kind: "env_key",
			label: key,
			file: info.file,
			provenance: info.provenance,
			determinism_ceiling: "partially_deterministic",
		});
	}
	return { nodes, edges: [] };
}
