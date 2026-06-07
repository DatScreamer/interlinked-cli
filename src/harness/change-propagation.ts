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

/** Pre-computed path context shared by every category helper. */
interface PropagationCtx {
	/** Absolute path of the file that was edited. */
	editedFile: string;
	/** Repo root the scan is relative to. */
	cwd: string;
	/** `relative(cwd, editedFile)`. */
	rel: string;
	/** `basename(editedFile)`. */
	name: string;
	/** `extname(editedFile)`. */
	ext: string;
	/** `dirname(editedFile)`. */
	dir: string;
	/** `basename(editedFile, ext)`. */
	nameNoExt: string;
}

/**
 * Given a file that was just edited, find other files that may need updating.
 * Returns propagation targets with reasons. Pure filesystem scan, no graph needed.
 *
 * Thin orchestrator: each propagation category lives in its own internal helper
 * (`docReadme`, `schemaCompanions`, … `genDts`) that takes the shared
 * `PropagationCtx` and returns the targets it found.
 */
export function findPropagationTargets(editedFile: string, cwd: string): PropagationTarget[] {
	const ext = extname(editedFile);
	const ctx: PropagationCtx = {
		editedFile,
		cwd,
		rel: relative(cwd, editedFile),
		name: basename(editedFile),
		ext,
		dir: dirname(editedFile),
		nameNoExt: basename(editedFile, ext),
	};
	const targets: PropagationTarget[] = [];

	// 1. DOCUMENTATION
	targets.push(...docReadme(ctx));
	targets.push(...docChangelog(ctx));
	targets.push(...docDocsDir(ctx));
	targets.push(...docClaudeMd(ctx));

	// 2. SCHEMA / TYPES
	targets.push(...schemaCompanions(ctx));
	targets.push(...schemaMigrations(ctx));
	targets.push(...schemaOpenApi(ctx));

	// 3. TESTS
	targets.push(...testFixturesSnapshots(ctx));

	// 4. CONFIGURATION
	targets.push(...configCli(ctx));
	targets.push(...configEnv(ctx));
	targets.push(...configGuardRules(ctx));

	// 5. CONTRACTS (API / MCP / Webhooks)
	targets.push(...contractToolRegistry(ctx));
	targets.push(...contractEndpointDocs(ctx));

	// 6. DEPENDENCIES
	targets.push(...depLockFiles(ctx));

	// 7. GENERATED FILES
	targets.push(...genBarrelIndex(ctx));
	targets.push(...genDts(ctx));

	return targets;
}

// ===========================================
// Category helpers (internal) — one cohesive propagation category each.
// ===========================================

/** 7. GENERATED — barrel index.ts that re-exports the edited module. */
function genBarrelIndex(c: PropagationCtx): PropagationTarget[] {
	const indexFile = join(c.dir, "index.ts");
	if (!(existsSync(indexFile) && indexFile !== c.editedFile && !isTestFile(c.name))) {
		return [];
	}
	try {
		const indexContent = readFileSync(indexFile, "utf-8");
		if (indexContent.includes(`./${c.nameNoExt}`)) {
			return [
				{
					file: indexFile,
					reason: `Barrel export in index.ts re-exports from ${c.rel} — update if exports changed`,
					category: "generated",
					confidence: "medium",
				},
			];
		}
	} catch (e) {
		void e;
	}
	return [];
}

/** 1. DOCUMENTATION — README in same dir / parent / root (one hit per name). */
function docReadme(c: PropagationCtx): PropagationTarget[] {
	const targets: PropagationTarget[] = [];
	for (const readmeName of ["README.md", "readme.md", "README.rst", "README"]) {
		const sameDir = join(c.dir, readmeName);
		const parentDir = join(dirname(c.dir), readmeName);
		const rootDir = join(c.cwd, readmeName);
		for (const candidate of [sameDir, parentDir, rootDir]) {
			if (existsSync(candidate) && candidate !== c.editedFile) {
				targets.push({
					file: candidate,
					reason: `README may reference ${c.rel} — update if API, usage, or behavior changed`,
					category: "documentation",
					confidence: "low",
				});
				break; // One README per level is enough
			}
		}
	}
	return targets;
}

/** 1. DOCUMENTATION — first matching CHANGELOG at repo root. */
function docChangelog(c: PropagationCtx): PropagationTarget[] {
	for (const changelogName of ["CHANGELOG.md", "changelog.md", "CHANGES.md", "HISTORY.md"]) {
		const changelog = join(c.cwd, changelogName);
		if (existsSync(changelog)) {
			return [
				{
					file: changelog,
					reason: `CHANGELOG should document this change to ${c.rel}`,
					category: "documentation",
					confidence: "low",
				},
			];
		}
	}
	return [];
}

/** 1. DOCUMENTATION — docs/ files that mention the module name or rel path. */
function docDocsDir(c: PropagationCtx): PropagationTarget[] {
	const docsDir = join(c.cwd, "docs");
	if (!existsSync(docsDir)) return [];
	const targets: PropagationTarget[] = [];
	try {
		const docFiles = findFilesRecursive(docsDir, [".md", ".mdx", ".rst", ".txt"], 3);
		for (const docFile of docFiles) {
			try {
				const content = readFileSync(docFile, "utf-8");
				if (content.includes(c.nameNoExt) || content.includes(c.rel)) {
					targets.push({
						file: docFile,
						reason: `Documentation references "${c.nameNoExt}" — verify it's still accurate`,
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
	return targets;
}

/** 1. DOCUMENTATION — CLAUDE.md (root + same dir) that references the file. */
function docClaudeMd(c: PropagationCtx): PropagationTarget[] {
	const targets: PropagationTarget[] = [];
	for (const claudeMd of [join(c.cwd, "CLAUDE.md"), join(c.dir, "CLAUDE.md")]) {
		if (existsSync(claudeMd)) {
			try {
				const content = readFileSync(claudeMd, "utf-8");
				if (content.includes(c.nameNoExt) || content.includes(c.rel)) {
					targets.push({
						file: claudeMd,
						reason: `CLAUDE.md references "${c.nameNoExt}" — update if behavior or API changed`,
						category: "documentation",
						confidence: "high",
					});
				}
			} catch (e) {
				void e;
			}
		}
	}
	return targets;
}

/** 2. SCHEMA — companion schema files mirroring a types/schema/interface file. */
function schemaCompanions(c: PropagationCtx): PropagationTarget[] {
	if (
		!(c.name.includes("types") || c.name.includes("schema") || c.name.includes("interface"))
	) {
		return [];
	}
	const targets: PropagationTarget[] = [];
	for (const suffix of [".schema.ts", ".schema.json", ".zod.ts"]) {
		const schemaFile = join(c.dir, `${c.nameNoExt}${suffix}`);
		if (existsSync(schemaFile) && schemaFile !== c.editedFile) {
			targets.push({
				file: schemaFile,
				reason: `Schema file may need to mirror changes in ${c.rel}`,
				category: "schema",
				confidence: "high",
			});
		}
	}
	return targets;
}

/** 2. SCHEMA — suggest a migrations dir when a schema/migration file lacks one. */
function schemaMigrations(c: PropagationCtx): PropagationTarget[] {
	if (!(c.name.includes("schema") || c.name.includes("migration"))) return [];
	const migrationsDir = join(c.dir, "migrations");
	if (existsSync(migrationsDir)) return [];
	return [
		{
			file: join(c.dir, "migrations/"),
			reason: `Schema change in ${c.rel} may require a new migration`,
			category: "schema",
			confidence: "medium",
		},
	];
}

/** 2. SCHEMA — OpenAPI / Swagger specs when editing a handler/route/api file. */
function schemaOpenApi(c: PropagationCtx): PropagationTarget[] {
	const isApiEdit =
		c.rel.includes("handler") ||
		c.rel.includes("route") ||
		c.rel.includes("api") ||
		c.rel.includes("endpoint");
	if (!isApiEdit) return [];
	const targets: PropagationTarget[] = [];
	for (const specName of [
		"openapi.yaml",
		"openapi.json",
		"swagger.yaml",
		"swagger.json",
		"api.yaml",
	]) {
		const specFile = join(c.cwd, specName);
		if (existsSync(specFile)) {
			targets.push({
				file: specFile,
				reason: `API spec may need updating after changes to ${c.rel}`,
				category: "schema",
				confidence: "medium",
			});
		}
	}
	return targets;
}

/** 3. TESTS — fixture and snapshot files matching the module name. */
function testFixturesSnapshots(c: PropagationCtx): PropagationTarget[] {
	if (isTestFile(c.name)) return [];
	const targets: PropagationTarget[] = [];

	const fixturesDir = join(c.dir, "__fixtures__");
	if (existsSync(fixturesDir)) {
		try {
			const fixtures = readdirSync(fixturesDir).filter((f) => f.includes(c.nameNoExt));
			for (const fixture of fixtures) {
				targets.push({
					file: join(fixturesDir, fixture),
					reason: `Test fixture for ${c.rel} may need updating`,
					category: "test",
					confidence: "medium",
				});
			}
		} catch (e) {
			void e;
		}
	}

	const snapshotsDir = join(c.dir, "__snapshots__");
	if (existsSync(snapshotsDir)) {
		try {
			const snaps = readdirSync(snapshotsDir).filter((f) => f.includes(c.nameNoExt));
			for (const snap of snaps) {
				targets.push({
					file: join(snapshotsDir, snap),
					reason: `Snapshot for ${c.rel} is likely stale — run tests to update`,
					category: "test",
					confidence: "high",
				});
			}
		} catch (e) {
			void e;
		}
	}
	return targets;
}

/** 4. CONFIGURATION — README usage section for a CLI/commands file. */
function configCliReadme(c: PropagationCtx): PropagationTarget[] {
	const targets: PropagationTarget[] = [];
	for (const readmeName of ["README.md", "readme.md"]) {
		const readmeFile = join(c.cwd, readmeName);
		if (existsSync(readmeFile) && readmeFile !== c.editedFile) {
			try {
				const content = readFileSync(readmeFile, "utf-8");
				if (/#{1,3}\s*(commands?|usage|cli|getting started)/i.test(content)) {
					targets.push({
						file: readmeFile,
						reason: `README CLI documentation may need updating after command changes in ${c.rel}`,
						category: "documentation",
						confidence: "medium",
					});
				}
			} catch (e) {
				void e;
			}
		}
	}
	return targets;
}

/** 4. CONFIGURATION — CLI block: completions, package.json, README usage. */
function configCli(c: PropagationCtx): PropagationTarget[] {
	const isCliEdit =
		c.rel.includes("commands/") || c.rel.includes("index.ts") || c.name.includes("cli");
	if (!isCliEdit) return [];
	const targets: PropagationTarget[] = [];

	for (const compFile of [
		"completions.ts",
		"completions.sh",
		"completions.zsh",
		"completions.fish",
	]) {
		const comp = join(dirname(c.editedFile), compFile);
		if (existsSync(comp) && comp !== c.editedFile) {
			targets.push({
				file: comp,
				reason: `Shell completions may need updating after CLI changes in ${c.rel}`,
				category: "config",
				confidence: "medium",
			});
		}
	}

	const pkgJson = join(c.cwd, "package.json");
	if (existsSync(pkgJson)) {
		targets.push({
			file: pkgJson,
			reason: `Check package.json bin/scripts after CLI changes in ${c.rel}`,
			category: "config",
			confidence: "low",
		});
	}

	targets.push(...configCliReadme(c));
	return targets;
}

/** 4. CONFIGURATION — env templates for a config/env/settings file. */
function configEnv(c: PropagationCtx): PropagationTarget[] {
	if (!(c.name.includes("config") || c.name.includes("env") || c.name.includes("settings"))) {
		return [];
	}
	const targets: PropagationTarget[] = [];
	for (const envExample of [".env.example", ".env.sample", ".env.template"]) {
		const envFile = join(c.cwd, envExample);
		if (existsSync(envFile)) {
			targets.push({
				file: envFile,
				reason: `Environment template may need updating after config changes in ${c.rel}`,
				category: "config",
				confidence: "medium",
			});
		}
	}
	return targets;
}

/** 4. CONFIGURATION — CLAUDE.md when editing guard rules / rules-loader. */
function configGuardRules(c: PropagationCtx): PropagationTarget[] {
	if (!(c.name === "guard-rules.json" || c.name.includes("rules-loader"))) return [];
	const claudeMd = join(c.cwd, "CLAUDE.md");
	if (!existsSync(claudeMd)) return [];
	return [
		{
			file: claudeMd,
			reason: "CLAUDE.md documents guard rules — update if behavior changed",
			category: "documentation",
			confidence: "high",
		},
	];
}

/** 5. CONTRACTS — tool registry index when editing a tool handler/entry. */
function contractToolRegistry(c: PropagationCtx): PropagationTarget[] {
	if (!(c.rel.includes("tools/handlers/") || c.rel.includes("tool-registry/entries/"))) {
		return [];
	}
	const registryIndex = join(c.cwd, "src", "tool-registry", "index.ts");
	if (!(existsSync(registryIndex) && registryIndex !== c.editedFile)) return [];
	return [
		{
			file: registryIndex,
			reason: `Tool registry may need updating after handler changes in ${c.rel}`,
			category: "contract",
			confidence: "medium",
		},
	];
}

/** 5. CONTRACTS — CLAUDE.md endpoint table when editing worker/router/handler. */
function contractEndpointDocs(c: PropagationCtx): PropagationTarget[] {
	if (!(c.name === "worker.ts" || c.name.includes("router") || c.name.includes("handler"))) {
		return [];
	}
	const claudeMd = join(c.cwd, "CLAUDE.md");
	if (!existsSync(claudeMd)) return [];
	try {
		const content = readFileSync(claudeMd, "utf-8");
		if (content.includes("API Endpoints") || content.includes("Endpoint")) {
			return [
				{
					file: claudeMd,
					reason: `CLAUDE.md API endpoint table may need updating after route changes in ${c.rel}`,
					category: "contract",
					confidence: "medium",
				},
			];
		}
	} catch (e) {
		void e;
	}
	return [];
}

/** 6. DEPENDENCIES — lock files when editing package.json. */
function depLockFiles(c: PropagationCtx): PropagationTarget[] {
	if (c.name !== "package.json") return [];
	const targets: PropagationTarget[] = [];
	for (const lockFile of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]) {
		const lock = join(dirname(c.editedFile), lockFile);
		if (existsSync(lock)) {
			targets.push({
				file: lock,
				reason: "Lock file should be regenerated after package.json changes (run install)",
				category: "dependency",
				confidence: "high",
			});
		}
	}
	return targets;
}

/** 7. GENERATED — sibling .d.ts declaration for a .ts/.tsx source. */
function genDts(c: PropagationCtx): PropagationTarget[] {
	if (!(c.ext === ".ts" || c.ext === ".tsx")) return [];
	const dtsFile = join(c.dir, `${c.nameNoExt}.d.ts`);
	if (!existsSync(dtsFile)) return [];
	return [
		{
			file: dtsFile,
			reason: `Type declaration file may be stale after changes to ${c.rel}`,
			category: "generated",
			confidence: "medium",
		},
	];
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
