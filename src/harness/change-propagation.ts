// ===========================================
// Change Propagation — Deterministic cross-file change reminders
// ===========================================
// When a file is edited, detect what OTHER artifacts may need updating.
// Pure deterministic checks — no LLM, <5ms per call.
//
// Propagation categories:
//   1. Documentation: README, CHANGELOG, docs/, API docs, JSDoc
//   2. Schema/Types: Zod schemas, JSON schemas, OpenAPI specs, DB migrations
//   3. Tests: test files, test fixtures, snapshot files
//   4. Configuration: CLI flags, env vars, config schemas, deployment configs
//   5. Contracts: API routes, MCP tool definitions, webhook handlers
//   6. Dependencies: package.json, lock files, import maps
//   7. Generated: type declarations, barrel exports, index files

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

// ===========================================
// Types
// ===========================================

interface PropagationTarget {
	/** File that may need updating */
	file: string;
	/** Why this file may need updating */
	reason: string;
	/** Category of relationship */
	category:
		| "documentation"
		| "schema"
		| "test"
		| "config"
		| "contract"
		| "dependency"
		| "generated";
	/** How confident we are (high = definitely needs update, low = maybe check) */
	confidence: "high" | "medium" | "low";
}

// ===========================================
// Main Entry Point
// ===========================================

/**
 * Given a file that was just edited, find other files that may need updating.
 * Returns propagation targets with reasons. Pure filesystem scan, no graph needed.
 */
export function findPropagationTargets(editedFile: string, cwd: string): PropagationTarget[] {
	const targets: PropagationTarget[] = [];
	const rel = relative(cwd, editedFile);
	const name = basename(editedFile);
	const ext = extname(editedFile);
	const dir = dirname(editedFile);
	const nameNoExt = basename(editedFile, ext);

	// ═══════════════════════════════════════
	// 1. DOCUMENTATION
	// ═══════════════════════════════════════

	// README files in same directory or parent
	for (const readmeName of ["README.md", "readme.md", "README.rst", "README"]) {
		const sameDir = join(dir, readmeName);
		const parentDir = join(dirname(dir), readmeName);
		const rootDir = join(cwd, readmeName);
		for (const candidate of [sameDir, parentDir, rootDir]) {
			if (existsSync(candidate) && candidate !== editedFile) {
				targets.push({
					file: candidate,
					reason: `README may reference ${rel} — update if API, usage, or behavior changed`,
					category: "documentation",
					confidence: "low",
				});
				break; // One README per level is enough
			}
		}
	}

	// CHANGELOG
	for (const changelogName of ["CHANGELOG.md", "changelog.md", "CHANGES.md", "HISTORY.md"]) {
		const changelog = join(cwd, changelogName);
		if (existsSync(changelog)) {
			targets.push({
				file: changelog,
				reason: `CHANGELOG should document this change to ${rel}`,
				category: "documentation",
				confidence: "low",
			});
			break;
		}
	}

	// Docs directory — look for docs that mention this file/module
	const docsDir = join(cwd, "docs");
	if (existsSync(docsDir)) {
		try {
			const docFiles = findFilesRecursive(docsDir, [".md", ".mdx", ".rst", ".txt"], 3);
			for (const docFile of docFiles) {
				try {
					const content = readFileSync(docFile, "utf-8");
					if (content.includes(nameNoExt) || content.includes(rel)) {
						targets.push({
							file: docFile,
							reason: `Documentation references "${nameNoExt}" — verify it's still accurate`,
							category: "documentation",
							confidence: "medium",
						});
					}
				} catch (e) {
					void e;
				}
			}
		} catch (e) {
			void e;
		}
	}

	// CLAUDE.md — project instructions may reference changed files
	for (const claudeMd of [join(cwd, "CLAUDE.md"), join(dir, "CLAUDE.md")]) {
		if (existsSync(claudeMd)) {
			try {
				const content = readFileSync(claudeMd, "utf-8");
				if (content.includes(nameNoExt) || content.includes(rel)) {
					targets.push({
						file: claudeMd,
						reason: `CLAUDE.md references "${nameNoExt}" — update if behavior or API changed`,
						category: "documentation",
						confidence: "high",
					});
				}
			} catch (e) {
				void e;
			}
		}
	}

	// ═══════════════════════════════════════
	// 2. SCHEMA / TYPES
	// ═══════════════════════════════════════

	// If editing a types file, check for Zod schemas or JSON schemas that mirror it
	if (name.includes("types") || name.includes("schema") || name.includes("interface")) {
		// Look for companion schema files
		for (const suffix of [".schema.ts", ".schema.json", ".zod.ts"]) {
			const schemaFile = join(dir, `${nameNoExt}${suffix}`);
			if (existsSync(schemaFile) && schemaFile !== editedFile) {
				targets.push({
					file: schemaFile,
					reason: `Schema file may need to mirror changes in ${rel}`,
					category: "schema",
					confidence: "high",
				});
			}
		}
	}

	// If editing a schema/types file, check for migration files
	if (name.includes("schema") || name.includes("migration")) {
		const migrationsDir = join(dir, "migrations");
		if (!existsSync(migrationsDir)) {
			// No migrations dir yet — might need one
			targets.push({
				file: join(dir, "migrations/"),
				reason: `Schema change in ${rel} may require a new migration`,
				category: "schema",
				confidence: "medium",
			});
		}
	}

	// OpenAPI / Swagger specs
	for (const specName of [
		"openapi.yaml",
		"openapi.json",
		"swagger.yaml",
		"swagger.json",
		"api.yaml",
	]) {
		const specFile = join(cwd, specName);
		if (existsSync(specFile)) {
			// Only flag if editing handler/route files
			if (
				rel.includes("handler") ||
				rel.includes("route") ||
				rel.includes("api") ||
				rel.includes("endpoint")
			) {
				targets.push({
					file: specFile,
					reason: `API spec may need updating after changes to ${rel}`,
					category: "schema",
					confidence: "medium",
				});
			}
		}
	}

	// ═══════════════════════════════════════
	// 3. TESTS
	// ═══════════════════════════════════════

	// This largely overlaps with test_proximity, but adds fixture/snapshot awareness
	if (!isTestFile(name)) {
		// Test fixtures
		const fixturesDir = join(dir, "__fixtures__");
		if (existsSync(fixturesDir)) {
			try {
				const fixtures = readdirSync(fixturesDir).filter((f) => f.includes(nameNoExt));
				for (const fixture of fixtures) {
					targets.push({
						file: join(fixturesDir, fixture),
						reason: `Test fixture for ${rel} may need updating`,
						category: "test",
						confidence: "medium",
					});
				}
			} catch (e) {
				void e;
			}
		}

		// Snapshot files
		const snapshotsDir = join(dir, "__snapshots__");
		if (existsSync(snapshotsDir)) {
			try {
				const snaps = readdirSync(snapshotsDir).filter((f) => f.includes(nameNoExt));
				for (const snap of snaps) {
					targets.push({
						file: join(snapshotsDir, snap),
						reason: `Snapshot for ${rel} is likely stale — run tests to update`,
						category: "test",
						confidence: "high",
					});
				}
			} catch (e) {
				void e;
			}
		}
	}

	// ═══════════════════════════════════════
	// 4. CONFIGURATION
	// ═══════════════════════════════════════

	// If editing CLI entry point or command files, check help text and completions
	if (rel.includes("commands/") || rel.includes("index.ts") || name.includes("cli")) {
		// Shell completions
		for (const compFile of [
			"completions.ts",
			"completions.sh",
			"completions.zsh",
			"completions.fish",
		]) {
			const comp = join(dirname(editedFile), compFile);
			if (existsSync(comp) && comp !== editedFile) {
				targets.push({
					file: comp,
					reason: `Shell completions may need updating after CLI changes in ${rel}`,
					category: "config",
					confidence: "medium",
				});
			}
		}

		// Package.json bin entries
		const pkgJson = join(cwd, "package.json");
		if (existsSync(pkgJson)) {
			targets.push({
				file: pkgJson,
				reason: `Check package.json bin/scripts after CLI changes in ${rel}`,
				category: "config",
				confidence: "low",
			});
		}

		// F2: CLI help text sync — check if README documents CLI commands
		for (const readmeName of ["README.md", "readme.md"]) {
			const readmeFile = join(cwd, readmeName);
			if (existsSync(readmeFile) && readmeFile !== editedFile) {
				try {
					const content = readFileSync(readmeFile, "utf-8");
					// Check if README has a commands/usage section
					if (/#{1,3}\s*(commands?|usage|cli|getting started)/i.test(content)) {
						targets.push({
							file: readmeFile,
							reason: `README CLI documentation may need updating after command changes in ${rel}`,
							category: "documentation",
							confidence: "medium",
						});
					}
				} catch (e) {
					void e;
				}
			}
		}
	}

	// If editing config-related files, check env documentation
	if (name.includes("config") || name.includes("env") || name.includes("settings")) {
		// .env.example
		for (const envExample of [".env.example", ".env.sample", ".env.template"]) {
			const envFile = join(cwd, envExample);
			if (existsSync(envFile)) {
				targets.push({
					file: envFile,
					reason: `Environment template may need updating after config changes in ${rel}`,
					category: "config",
					confidence: "medium",
				});
			}
		}
	}

	// If editing guard rules or harness config
	if (name === "guard-rules.json" || name.includes("rules-loader")) {
		const claudeMd = join(cwd, "CLAUDE.md");
		if (existsSync(claudeMd)) {
			targets.push({
				file: claudeMd,
				reason: "CLAUDE.md documents guard rules — update if behavior changed",
				category: "documentation",
				confidence: "high",
			});
		}
	}

	// ═══════════════════════════════════════
	// 5. CONTRACTS (API / MCP / Webhooks)
	// ═══════════════════════════════════════

	// If editing tool handler, check tool registry entry
	if (rel.includes("tools/handlers/") || rel.includes("tool-registry/entries/")) {
		// Look for tool registry index
		const registryIndex = join(cwd, "src", "tool-registry", "index.ts");
		if (existsSync(registryIndex) && registryIndex !== editedFile) {
			targets.push({
				file: registryIndex,
				reason: `Tool registry may need updating after handler changes in ${rel}`,
				category: "contract",
				confidence: "medium",
			});
		}
	}

	// If editing worker/router, check MCP endpoint docs
	if (name === "worker.ts" || name.includes("router") || name.includes("handler")) {
		const claudeMd = join(cwd, "CLAUDE.md");
		if (existsSync(claudeMd)) {
			try {
				const content = readFileSync(claudeMd, "utf-8");
				if (content.includes("API Endpoints") || content.includes("Endpoint")) {
					targets.push({
						file: claudeMd,
						reason: `CLAUDE.md API endpoint table may need updating after route changes in ${rel}`,
						category: "contract",
						confidence: "medium",
					});
				}
			} catch (e) {
				void e;
			}
		}
	}

	// ═══════════════════════════════════════
	// 6. DEPENDENCIES
	// ═══════════════════════════════════════

	// If editing package.json, remind about lock file
	if (name === "package.json") {
		for (const lockFile of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]) {
			const lock = join(dirname(editedFile), lockFile);
			if (existsSync(lock)) {
				targets.push({
					file: lock,
					reason: "Lock file should be regenerated after package.json changes (run install)",
					category: "dependency",
					confidence: "high",
				});
			}
		}
	}

	// ═══════════════════════════════════════
	// 7. GENERATED FILES
	// ═══════════════════════════════════════

	// If editing a source file, check for barrel/index re-exports
	const indexFile = join(dir, "index.ts");
	if (existsSync(indexFile) && indexFile !== editedFile && !isTestFile(name)) {
		try {
			const indexContent = readFileSync(indexFile, "utf-8");
			if (indexContent.includes(`./${nameNoExt}`)) {
				targets.push({
					file: indexFile,
					reason: `Barrel export in index.ts re-exports from ${rel} — update if exports changed`,
					category: "generated",
					confidence: "medium",
				});
			}
		} catch (e) {
			void e;
		}
	}

	// If editing types, check for generated type declarations
	if (ext === ".ts" || ext === ".tsx") {
		const dtsFile = join(dir, `${nameNoExt}.d.ts`);
		if (existsSync(dtsFile)) {
			targets.push({
				file: dtsFile,
				reason: `Type declaration file may be stale after changes to ${rel}`,
				category: "generated",
				confidence: "medium",
			});
		}
	}

	return targets;
}

// ===========================================
// Format as warnings
// ===========================================

export function formatPropagationWarnings(targets: PropagationTarget[], cwd: string): string[] {
	if (targets.length === 0) return [];

	// Group by confidence — only show high and medium by default
	const high = targets.filter((t) => t.confidence === "high");
	const medium = targets.filter((t) => t.confidence === "medium");

	const warnings: string[] = [];

	for (const t of high) {
		const rel = relative(cwd, t.file);
		warnings.push(`[interlinked:propagation] ${t.reason} → ${rel}`);
	}

	if (medium.length > 0) {
		const files = medium
			.slice(0, 4)
			.map((t) => relative(cwd, t.file))
			.join(", ");
		const more = medium.length > 4 ? ` +${medium.length - 4} more` : "";
		warnings.push(`[interlinked:propagation] Also check: ${files}${more}`);
	}

	return warnings;
}

// ===========================================
// Helpers
// ===========================================

function isTestFile(name: string): boolean {
	return /\.(test|spec)\.\w+$/.test(name) || name.includes("__test");
}

function findFilesRecursive(
	dir: string,
	extensions: string[],
	maxDepth: number,
	depth = 0,
): string[] {
	if (depth >= maxDepth) return [];
	const results: string[] = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (
				entry.isDirectory() &&
				!entry.name.startsWith(".") &&
				entry.name !== "node_modules"
			) {
				results.push(...findFilesRecursive(full, extensions, maxDepth, depth + 1));
			} else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
				results.push(full);
			}
		}
	} catch (e) {
		void e;
	}
	return results;
}
