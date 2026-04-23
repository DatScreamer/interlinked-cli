// Structure Commands — Generic Artifact Structure V1 CLI
// All harness/structure imports are lazy (dynamic) to keep startup fast.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
	ArtifactFileKey,
	ArtifactKind,
	CatalogItem,
	Determinism,
	EnvFile,
	PublicApiFile,
	PublicModuleEntry,
	StructureConfig,
} from "../harness/structure/types.js";
import { c } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";

// --- Option shapes ---
interface StructureOpts {
	json?: boolean;
}
interface InitOpts extends StructureOpts {
	mode?: string;
	with?: string;
	write?: boolean;
}
interface ScanOpts extends StructureOpts {
	full?: boolean;
	incremental?: boolean;
}
type BaselineOpts = StructureOpts;

// --- Helpers ---
function out(json: boolean | undefined, data: unknown, text: string): void {
	console.log(json ? JSON.stringify(data, null, 2) : text);
}
function fatal(msg: string): never {
	console.error(c.red(`Error: ${msg}`));
	process.exitCode = 1;
	throw new Error(msg);
}
function relTo(cwd: string, p: string): string {
	return p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
}
function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return fallback;
	}
}
function writeJson(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}
function pctColor(pct: number): (s: string) => string {
	if (pct >= 80) return c.green;
	return pct >= 50 ? c.yellow : c.red;
}
function badge(sev: string): string {
	if (sev === "error") return c.red("ERROR");
	return sev === "warning" ? c.yellow("WARN") : c.dim("INFO");
}

const KEY_TO_KIND: Record<string, ArtifactKind> = {
	public_api: "public_symbol",
	env: "env_key",
	config: "config_key",
	tests: "test",
	docs: "doc",
	examples: "example",
	glossary: "term",
	layers: "layer",
	packages: "package",
};
const KIND_TO_CAT: Record<string, string> = {
	module: "modules",
	public_symbol: "public-symbols",
	package: "packages",
	env_key: "env-keys",
	config_key: "config-keys",
	test: "tests",
	doc: "docs",
	example: "examples",
	term: "glossary",
	layer: "layers",
};
const SCAFFOLDS: Record<string, { file: string; content: JsonObject }> = {
	public_api: { file: "artifacts/public-api.json", content: { version: 1, modules: [] } },
	env: {
		file: "artifacts/env.json",
		content: { version: 1, sources: { declarations: [], defaults: [] }, keys: [] },
	},
	config: { file: "artifacts/config.json", content: { version: 1, roots: [], keys: [] } },
	tests: { file: "artifacts/tests.json", content: { version: 1, tests: [] } },
	docs: { file: "artifacts/docs.json", content: { version: 1, docs: [] } },
	examples: { file: "artifacts/examples.json", content: { version: 1, examples: [] } },
	glossary: { file: "artifacts/glossary.json", content: { version: 1, terms: [] } },
	layers: { file: "artifacts/layers.json", content: { version: 1, layers: [], rules: [] } },
	packages: { file: "artifacts/packages.json", content: { version: 1, packages: [] } },
};

function catalogToNode(item: CatalogItem): import("../harness/structure/types.js").ArtifactNode {
	const idx = item.global_ref.indexOf(":");
	return {
		id: item.global_ref,
		kind: (idx > 0 ? item.global_ref.slice(0, idx) : "module") as ArtifactKind,
		label: item.local_id,
		file: item.file,
		provenance: item.provenance,
		determinism_ceiling: item.determinism_ceiling,
	};
}

// --- 1. structure init ---
export async function structureInitCommand(opts: InitOpts): Promise<void> {
	try {
		const cwd = process.cwd();
		const mode = opts.mode || "standard";
		const { VALID_MODES } = await import("../harness/structure/types.js");
		if (!(VALID_MODES as readonly string[]).includes(mode))
			fatal(`Invalid mode "${mode}". Must be one of: ${VALID_MODES.join(", ")}`);

		const cats = opts.with ? opts.with.split(",").map((s) => s.trim()) : [];
		for (const cat of cats) {
			if (!SCAFFOLDS[cat])
				fatal(`Unknown category "${cat}". Available: ${Object.keys(SCAFFOLDS).join(", ")}`);
		}

		const dir = join(cwd, "interlinked");
		const arts: Record<string, string> = {};
		for (const cat of cats) arts[cat] = SCAFFOLDS[cat].file;
		const cfg: JsonObject = { version: 1, mode };
		if (Object.keys(arts).length > 0) cfg.artifacts = arts;

		const files = [
			{ path: join(dir, "structure.json"), data: cfg },
			...cats.map((cat) => ({
				path: join(dir, SCAFFOLDS[cat].file),
				data: SCAFFOLDS[cat].content,
			})),
		];
		const names = files.map((f) => relTo(cwd, f.path));

		if (!opts.write) {
			const lines = [
				c.bold("Structure init (dry-run)"),
				"",
				`  Mode: ${c.cyan(mode)}`,
				`  Categories: ${cats.length > 0 ? cats.join(", ") : c.dim("(none)")}`,
				"",
				c.bold("Files that would be created:"),
			];
			for (const f of files) {
				const tag = existsSync(f.path) ? c.yellow("overwrite") : c.green("create");
				lines.push(`  ${tag}  ${relTo(cwd, f.path)}`);
			}
			lines.push("", c.dim("Run with --write to create files."));
			return out(
				opts.json,
				{ dry_run: true, mode, categories: cats, files: names },
				lines.join("\n"),
			);
		}

		for (const f of files) writeJson(f.path, f.data);
		const lines = [
			c.green("Structure initialized."),
			"",
			`  Mode: ${c.cyan(mode)}`,
			"  Config: interlinked/structure.json",
		];
		if (cats.length > 0) lines.push(`  Artifacts: ${cats.join(", ")}`);
		lines.push(
			"",
			c.dim("Next: run `interlinked structure scan` to build the artifact catalog."),
		);
		out(opts.json, { created: true, mode, categories: cats, files: names }, lines.join("\n"));
	} catch (e) {
		if (process.exitCode === 1) return;
		console.error(c.red(`structure init failed: ${(e as Error).message}`));
		process.exitCode = 1;
	}
}

// --- 2. structure scan ---
export async function structureScanCommand(opts: ScanOpts): Promise<void> {
	try {
		const cwd = process.cwd();
		const t0 = Date.now();
		const loader = await import("../harness/structure/structure-loader.js");
		const { runAllExtractors } = await import("../harness/structure/extractors/index.js");
		const { ArtifactGraph } = await import("../harness/structure/artifact-graph.js");
		const cm = await import("../harness/structure/cache-manager.js");

		const loaded = loader.loadStructureConfig(cwd);
		const config = loaded.config || loader.getImplicitConfig();
		for (const err of loaded.errors) console.error(c.yellow(`  Warning: ${err}`));

		const existing = cm.readCatalogMeta(cwd);
		const incremental = opts.incremental ?? (opts.full ? false : !!existing);
		if (incremental && !existing) console.log(c.dim("No cache found. Running full scan."));

		const result = runAllExtractors(cwd);
		const graph = new ArtifactGraph();
		for (const n of result.nodes) graph.addNode(n);
		for (const e of result.edges) graph.addEdge(e);

		// Layer declared artifacts from committed manifests onto the extracted graph
		const { layerDeclaredArtifacts } = await import("../harness/structure/structure-checks.js");
		layerDeclaredArtifacts(graph, cwd, config);

		cm.ensureCacheDir(cwd);
		const hash = cm.computeManifestHash(cwd);
		const meta = {
			schema_version: 1 as const,
			cli_version: "0.0.0",
			built_at: new Date().toISOString(),
			repo_root: cwd,
			last_scanned_commit: "",
			manifest_hash: hash,
			extractor_versions: {} as Record<string, number>,
		};
		try {
			const { execSync } = await import("node:child_process");
			meta.last_scanned_commit = execSync("git rev-parse HEAD", {
				cwd,
				encoding: "utf-8",
			}).trim();
		} catch {
			/* intentional: repo metadata is optional outside a git worktree */
		}
		cm.writeCatalogMeta(cwd, meta);

		// Write node/edge caches
		// n.id is the global ref (e.g. "public_symbol:pkg-index#createClient"). Extract local_id by stripping the kind prefix.
		const extractLocalId = (globalRef: string): string => {
			const idx = globalRef.indexOf(":");
			return idx >= 0 ? globalRef.slice(idx + 1) : globalRef;
		};
		const toItems = (nodes: import("../harness/structure/types.js").ArtifactNode[]) =>
			nodes.map((n) => ({
				local_id: extractLocalId(n.id),
				global_ref: n.id,
				file: n.file,
				provenance: n.provenance,
				determinism_ceiling: n.determinism_ceiling,
			}));
		cm.writeCategoryCache(cwd, "artifact-nodes", {
			schema_version: 1,
			items: toItems(graph.toNodesJson().nodes),
		});
		cm.writeCategoryCache(cwd, "artifact-edges", {
			schema_version: 1,
			items: graph.toEdgesJson().edges.map((e) => ({
				local_id: e.id,
				global_ref: e.id,
				file: "",
				provenance: e.provenance,
				determinism_ceiling: "fully_deterministic" as Determinism,
			})),
		});
		for (const [kind, cat] of Object.entries(KIND_TO_CAT))
			cm.writeCategoryCache(cwd, cat, {
				schema_version: 1,
				items: toItems(graph.getNodesByKind(kind as ArtifactKind)),
			});

		const adoption = {} as Record<ArtifactFileKey, number>;
		for (const key of Object.keys(SCAFFOLDS)) {
			const nodes = graph.getNodesByKind((KEY_TO_KIND[key] ?? key) as ArtifactKind);
			const decl = nodes.filter((n) => n.provenance === "declared").length;
			adoption[key as ArtifactFileKey] = nodes.length > 0 ? decl / nodes.length : 0;
		}
		cm.writeAdoptionReport(cwd, { schema_version: 1, categories: adoption });

		const ms = Date.now() - t0;
		const summary = {
			mode: incremental ? "incremental" : "full",
			nodes: graph.nodeCount,
			edges: graph.edgeCount,
			elapsed_ms: ms,
			config_mode: config.mode,
		};
		out(
			opts.json,
			summary,
			[
				c.green("Scan complete."),
				"",
				`  Mode:    ${c.cyan(summary.mode)} scan`,
				`  Config:  ${c.cyan(config.mode)}`,
				`  Nodes:   ${c.bold(String(summary.nodes))}`,
				`  Edges:   ${c.bold(String(summary.edges))}`,
				`  Time:    ${String(ms)}ms`,
			].join("\n"),
		);
	} catch (e) {
		if (process.exitCode === 1) return;
		console.error(c.red(`structure scan failed: ${(e as Error).message}`));
		process.exitCode = 1;
	}
}

// --- 3. structure status ---
export async function structureStatusCommand(opts: StructureOpts): Promise<void> {
	try {
		const cwd = process.cwd();
		const [loader, cm] = await Promise.all([
			import("../harness/structure/structure-loader.js"),
			import("../harness/structure/cache-manager.js"),
		]);
		const loaded = loader.loadStructureConfig(cwd);
		const config = loaded.config || loader.getImplicitConfig();
		const meta = cm.readCatalogMeta(cwd);
		const adopt = cm.readAdoptionReport(cwd);
		const stale = meta ? cm.isCacheStale(cwd, cm.computeManifestHash(cwd)) : true;

		const invalid: string[] = [];
		for (const [key, rel] of Object.entries(config.artifacts)) {
			if (rel && !existsSync(resolve(cwd, "interlinked", rel)))
				invalid.push(`${key}: interlinked/${rel}`);
		}

		const data = {
			config_mode: config.mode,
			implicit: loaded.implicit,
			cache_exists: !!meta,
			cache_stale: stale,
			cache_built_at: meta?.built_at || null,
			adoption: adopt?.categories || null,
			invalid_files: invalid,
			errors: loaded.errors,
		};
		if (opts.json) return out(opts.json, data, "");

		const imp = loaded.implicit ? c.dim(" (implicit, no structure.json)") : "";
		let cl = c.dim("not built");
		if (meta && stale) cl = c.yellow("stale");
		else if (meta) cl = c.green("fresh");
		const lines = [
			c.bold("Structure Status"),
			"",
			`  Mode:     ${c.cyan(config.mode)}${imp}`,
			`  Cache:    ${cl}`,
		];
		if (meta?.built_at) lines.push(`  Built:    ${c.dim(meta.built_at)}`);
		if (adopt) {
			lines.push("", c.bold("  Adoption:"));
			for (const [cat, score] of Object.entries(adopt.categories))
				lines.push(
					`    ${cat.padEnd(12)} ${pctColor(Math.round(score * 100))(`${String(Math.round(score * 100))}%`)}`,
				);
		}
		if (invalid.length > 0) {
			lines.push("", c.yellow("  Invalid manifest references:"));
			for (const f of invalid) lines.push(`    ${c.red("missing")}  ${f}`);
		}
		for (const err of loaded.errors) lines.push(`    ${c.red("error")}  ${err}`);
		console.log(lines.join("\n"));
	} catch (e) {
		console.error(c.red(`structure status failed: ${(e as Error).message}`));
		process.exitCode = 1;
	}
}

// --- 4. structure accept ---
interface AcceptBatch {
	category: string;
	count: number;
}
interface SkipEntry {
	category: string;
	item: string;
	reason: string;
}

function acceptSymbols(
	catalog: import("../harness/structure/types.js").CategoryCatalog,
	path: string,
): { accepted: number; skipped: SkipEntry[] } {
	const file: PublicApiFile = readJson(path, { version: 1, modules: [] });
	// Build set of existing "moduleId#symbolName" entries for dedup
	const have = new Set<string>();
	for (const m of file.modules) for (const s of m.symbols) have.add(`${m.id}#${s.name}`);
	const skipped: SkipEntry[] = [];
	let n = 0;
	for (const item of catalog.items) {
		// local_id is e.g. "pkg-index#createClient" (moduleId#symbolName)
		const localId = item.local_id;
		if (have.has(localId)) {
			skipped.push({ category: "public_api", item: localId, reason: "already declared" });
			continue;
		}
		const hashIdx = localId.indexOf("#");
		const moduleId = hashIdx >= 0 ? localId.slice(0, hashIdx) : localId;
		const symbolName = hashIdx >= 0 ? localId.slice(hashIdx + 1) : localId;
		let mod = file.modules.find((m: PublicModuleEntry) => m.id === moduleId);
		if (!mod) {
			mod = { id: moduleId, file: item.file, symbols: [] };
			file.modules.push(mod);
		}
		mod.symbols.push({
			name: symbolName,
			kind: "function",
			stability: "public",
			docs: [],
			tests: [],
			examples: [],
		});
		have.add(localId);
		n++;
	}
	if (n > 0) writeJson(path, file);
	return { accepted: n, skipped };
}

function acceptEnv(
	catalog: import("../harness/structure/types.js").CategoryCatalog,
	path: string,
): { accepted: number; skipped: SkipEntry[] } {
	const file: EnvFile = readJson(path, {
		version: 1,
		sources: { declarations: [], defaults: [] },
		keys: [],
	});
	const have = new Set(file.keys.map((k) => k.name));
	const skipped: SkipEntry[] = [];
	let n = 0;
	for (const item of catalog.items) {
		const name = item.local_id;
		if (have.has(name)) {
			skipped.push({ category: "env", item: name, reason: "already declared" });
			continue;
		}
		file.keys.push({
			name,
			required: false,
			docs: [],
			tests: [],
			examples: [],
			default_sources: [],
		});
		n++;
	}
	if (n > 0) writeJson(path, file);
	return { accepted: n, skipped };
}

export async function structureAcceptCommand(opts: StructureOpts): Promise<void> {
	try {
		const cwd = process.cwd();
		const { readCategoryCache } = await import("../harness/structure/cache-manager.js");
		const loader = await import("../harness/structure/structure-loader.js");
		const config = loader.loadStructureConfig(cwd).config || loader.getImplicitConfig();
		const dir = join(cwd, "interlinked");
		const accepted: AcceptBatch[] = [];
		const skipped: SkipEntry[] = [];

		const syms = readCategoryCache(cwd, "public-symbols");
		if (syms && syms.items.length > 0) {
			const r = acceptSymbols(
				syms,
				join(dir, config.artifacts?.public_api || "artifacts/public-api.json"),
			);
			if (r.accepted > 0) accepted.push({ category: "public_api", count: r.accepted });
			skipped.push(...r.skipped);
		}
		const envs = readCategoryCache(cwd, "env-keys");
		if (envs && envs.items.length > 0) {
			const r = acceptEnv(envs, join(dir, config.artifacts?.env || "artifacts/env.json"));
			if (r.accepted > 0) accepted.push({ category: "env", count: r.accepted });
			skipped.push(...r.skipped);
		}

		if (opts.json) return out(true, { accepted, skipped }, "");
		if (accepted.length === 0 && skipped.length === 0)
			return void console.log(
				c.dim("Nothing to accept. Run `interlinked structure scan` first."),
			);
		const lines = [c.bold("Structure Accept")];
		for (const a of accepted)
			lines.push(`  ${c.green("accepted")}  ${a.category}: ${String(a.count)} items`);
		if (skipped.length > 0) {
			lines.push("", c.dim("  Skipped (already declared):"));
			for (const s of skipped.slice(0, 10))
				lines.push(`    ${c.yellow("skip")}  ${s.category}/${s.item}: ${s.reason}`);
			if (skipped.length > 10)
				lines.push(c.dim(`    ... and ${String(skipped.length - 10)} more`));
		}
		console.log(lines.join("\n"));
	} catch (e) {
		console.error(c.red(`structure accept failed: ${(e as Error).message}`));
		process.exitCode = 1;
	}
}

// --- 5. structure doctor ---
interface Issue {
	severity: "error" | "warning" | "info";
	message: string;
}

function doctorValidateConfig(
	path: string,
	validateFn: (d: unknown) => import("../harness/structure/schema-validator.js").ValidationResult,
): Issue[] {
	if (!existsSync(path))
		return [
			{
				severity: "info",
				message: "No interlinked/structure.json found (implicit minimal mode)",
			},
		];
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		return [
			{ severity: "error", message: `structure.json: invalid JSON: ${(e as Error).message}` },
		];
	}
	const result = validateFn(parsed);
	return result.valid
		? []
		: result.errors.map((e) => ({
				severity: "error" as const,
				message: `structure.json ${e.path}: ${e.message}`,
			}));
}

function doctorCheckFiles(
	config: StructureConfig,
	cwd: string,
	load: (
		cwd: string,
		key: ArtifactFileKey,
		rel: string,
	) => { data: JsonObject | null; errors: string[] },
): Issue[] {
	const issues: Issue[] = [];
	for (const [key, rel] of Object.entries(config.artifacts)) {
		if (!rel) continue;
		if (!existsSync(resolve(cwd, "interlinked", rel))) {
			issues.push({
				severity: "error",
				message: `Artifact file missing: interlinked/${rel}`,
			});
			continue;
		}
		for (const err of load(cwd, key as ArtifactFileKey, rel).errors)
			issues.push({ severity: "error", message: `${key} (${rel}): ${err}` });
	}
	return issues;
}

function extractPathsFromData(data: JsonObject): string[] {
	const paths: string[] = [];
	for (const col of ["modules", "tests", "docs", "examples", "packages"]) {
		const arr = data[col];
		if (!Array.isArray(arr)) continue;
		for (const item of arr) {
			if (typeof item !== "object" || item === null) continue;
			const rec = item as JsonObject;
			if (typeof rec.file === "string") paths.push(rec.file);
			if (typeof rec.root === "string") paths.push(rec.root);
		}
	}
	return paths;
}

function doctorCheckPaths(
	config: StructureConfig,
	cwd: string,
	load: (
		cwd: string,
		key: ArtifactFileKey,
		rel: string,
	) => { data: JsonObject | null; errors: string[] },
): Issue[] {
	const issues: Issue[] = [];
	for (const [key, rel] of Object.entries(config.artifacts)) {
		if (!rel) continue;
		const { data } = load(cwd, key as ArtifactFileKey, rel);
		if (!data) continue;
		for (const fp of extractPathsFromData(data)) {
			if (!existsSync(resolve(cwd, fp)))
				issues.push({
					severity: "warning",
					message: `${key}: declared path not found: ${fp}`,
				});
		}
	}
	return issues;
}

export async function structureDoctorCommand(opts: StructureOpts): Promise<void> {
	try {
		const cwd = process.cwd();
		const loader = await import("../harness/structure/structure-loader.js");
		const { validateStructureJson } = await import("../harness/structure/schema-validator.js");
		const cm = await import("../harness/structure/cache-manager.js");

		const issues: Issue[] = [];
		issues.push(
			...doctorValidateConfig(
				join(cwd, "interlinked", "structure.json"),
				validateStructureJson,
			),
		);
		const loaded = loader.loadStructureConfig(cwd);
		const config = loaded.config || loader.getImplicitConfig();
		issues.push(...doctorCheckFiles(config, cwd, loader.loadArtifactFile));
		issues.push(...doctorCheckPaths(config, cwd, loader.loadArtifactFile));

		const meta = cm.readCatalogMeta(cwd);
		if (!meta)
			issues.push({
				severity: "warning",
				message: "No scan cache. Run `interlinked structure scan`.",
			});
		else if (cm.isCacheStale(cwd, cm.computeManifestHash(cwd)))
			issues.push({
				severity: "warning",
				message: "Scan cache is stale. Re-run `interlinked structure scan`.",
			});

		if (opts.json) return out(true, { issues, total: issues.length }, "");
		if (issues.length === 0)
			return void console.log(c.green("Structure doctor: no issues found."));
		const lines = [c.bold(`Structure Doctor: ${String(issues.length)} issue(s)`), ""];
		for (const i of issues) lines.push(`  ${badge(i.severity)}  ${i.message}`);
		console.log(lines.join("\n"));
		if (issues.some((i) => i.severity === "error")) process.exitCode = 1;
	} catch (e) {
		console.error(c.red(`structure doctor failed: ${(e as Error).message}`));
		process.exitCode = 1;
	}
}

// --- 6. structure baseline ---
async function blSave(cwd: string, opts: BaselineOpts): Promise<void> {
	const loader = await import("../harness/structure/structure-loader.js");
	const { ArtifactGraph } = await import("../harness/structure/artifact-graph.js");
	const { evaluateStructureRules } = await import("../harness/structure/rules/index.js");
	const { readCategoryCache, writeBaseline } = await import(
		"../harness/structure/cache-manager.js"
	);
	const config = loader.loadStructureConfig(cwd).config || loader.getImplicitConfig();
	const nodes = readCategoryCache(cwd, "artifact-nodes");
	if (!nodes) fatal("No scan cache. Run `interlinked structure scan` first.");
	const graph = new ArtifactGraph();
	for (const item of nodes.items) graph.addNode(catalogToNode(item));
	const findings = evaluateStructureRules(graph, config, [], cwd);
	const bl = {
		schema_version: 1 as const,
		entries: findings.map((f) => ({
			finding_name: f.name,
			artifact_ref: f.artifact_id,
			source_file: f.file,
			determinism: f.determinism,
			required_companion_files: f.required_updates.map((u) => u.file),
			context_hash: "",
		})),
	};
	writeBaseline(cwd, bl);
	out(
		opts.json,
		{ saved: true, entry_count: bl.entries.length },
		`${c.green("Baseline saved.")} ${String(bl.entries.length)} findings baselined.`,
	);
}

function blClear(cwd: string, opts: BaselineOpts): void {
	const p = join(cwd, ".interlinked", "structure-cache", "baseline.json");
	if (existsSync(p)) {
		rmSync(p);
		out(opts.json, { cleared: true }, c.green("Baseline cleared."));
	} else
		out(opts.json, { cleared: false, reason: "no baseline" }, c.dim("No baseline to clear."));
}

async function blStatus(cwd: string, opts: BaselineOpts): Promise<void> {
	const { readBaseline } = await import("../harness/structure/cache-manager.js");
	const bl = readBaseline(cwd);
	if (bl.entries.length === 0)
		return out(opts.json, { exists: false, entry_count: 0 }, c.dim("No baseline saved."));
	const byName: Record<string, number> = {};
	for (const e of bl.entries) byName[e.finding_name] = (byName[e.finding_name] || 0) + 1;
	if (opts.json)
		return out(true, { exists: true, entry_count: bl.entries.length, by_finding: byName }, "");
	const lines = [c.bold(`Baseline: ${String(bl.entries.length)} entries`), ""];
	for (const [name, n] of Object.entries(byName))
		lines.push(`  ${name.padEnd(30)} ${c.bold(String(n))}`);
	console.log(lines.join("\n"));
}

export async function structureBaselineCommand(sub: string, opts: BaselineOpts): Promise<void> {
	try {
		const cwd = process.cwd();
		if (sub === "save") await blSave(cwd, opts);
		else if (sub === "clear") blClear(cwd, opts);
		else if (sub === "status") await blStatus(cwd, opts);
		else fatal(`Unknown baseline subcommand "${sub}". Use: save, clear, status`);
	} catch (e) {
		if (process.exitCode === 1) return;
		console.error(c.red(`structure baseline failed: ${(e as Error).message}`));
		process.exitCode = 1;
	}
}
