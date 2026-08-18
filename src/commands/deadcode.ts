// ===========================================
// `interlinked deadcode` — whole-repo dead-code scan (plan 25 follow-on)
// ===========================================
// The SCAN half of the two dead-code controls (operator decision 2026-08-17):
// per-edit detection lives in the structural checks (`dead_imports` /
// `dead_exports`, gated by `structural_checks.enabled`); this verb sweeps the
// WHOLE repo on demand. Three layers, weakest-claim-first, and every section
// is labeled a CANDIDATE list — import analysis cannot see runtime-loaded
// files (fixtures loaded by path, dynamic imports), so a row here is a lead
// to verify, never a deletion order. The fourth layer — behaviorally inert
// code inside reachable functions — belongs to mutation adjudication
// (`interlinked mutation disposition`), not to reachability analysis.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { checkDeadExports } from "../harness/checks/dead-exports-inline.js";
import { ProjectGraph } from "../harness/project-graph.js";
import { isJsonObject } from "../lib/json-types.js";
import { findDeadImports } from "./check-dead-imports.js";

const WALK_SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".interlinked"]);

/** Plain recursive walk (no git dependency — the scan must work in any tree). */
function walkSourceFiles(root: string, dir = "src"): string[] {
	const out: string[] = [];
	const absDir = join(root, dir);
	if (!existsSync(absDir)) return out;
	for (const name of readdirSync(absDir)) {
		if (WALK_SKIP_DIRS.has(name)) continue;
		const rel = `${dir}/${name}`;
		try {
			if (statSync(join(root, rel)).isDirectory()) out.push(...walkSourceFiles(root, rel));
			else if (/\.[jt]sx?$/.test(name)) out.push(rel);
		} catch (err) {
			void err; // vanished mid-walk — skip
		}
	}
	return out;
}

const TEST_OR_FIXTURE_RE =
	/\.(test|spec)\.[jt]sx?$|(^|\/)__tests__\/|(^|\/)__fixtures__\/|(^|\/)__mocks__\/|\.d\.ts$|(^|\/)(?:generated|__generated__)\//;

export interface DeadImportBinding {
	file: string;
	binding: string;
}

export interface DeadExportFinding {
	file: string;
	detail: string;
}

export interface DeadCodeReport {
	/** Repo-relative files no other source file imports (entry points excluded). */
	unreachableFiles: string[];
	/** Import bindings never referenced in their own file's body. */
	deadImportBindings: DeadImportBinding[];
	/** Exported symbols the cross-file detector finds no consumer for. */
	deadExports: DeadExportFinding[];
	/** Files alive ONLY because test files import them (categorizer signal). */
	testOnlyImporterFiles?: string[];
	/** How many files the scan covered. */
	scannedFiles: number;
}

/** Entry points that are reachable by definition: package.json `bin` targets
 *  (mapped dist/x.js → src/x.ts) and any additional src entries named in the
 *  build script. Fail-soft: unreadable/missing package.json ⇒ only the
 *  conventional src/index.* entry survives. */
function entryPoints(cwd: string): Set<string> {
	const entries = new Set<string>(["src/index.ts", "src/index.tsx"]);
	try {
		const raw: unknown = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
		if (isJsonObject(raw)) {
			if (isJsonObject(raw.bin)) {
				for (const v of Object.values(raw.bin)) {
					if (typeof v === "string") {
						entries.add(v.replace(/^\.\//, "").replace(/^dist\//, "src/").replace(/\.js$/, ".ts"));
					}
				}
			}
			const scripts = isJsonObject(raw.scripts) ? raw.scripts : {};
			const build = typeof scripts.build === "string" ? scripts.build : "";
			for (const m of build.matchAll(/src\/\S+?\.tsx?\b/g)) entries.add(m[0]);
		}
	} catch (err) {
		void err; // fail-soft — conventional entries only
	}
	return entries;
}

const REEXPORT_FROM_RE = /export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*["']([^"']+)["']/g;

/** Mark every relative specifier the pattern captures as a reached file,
 *  under each resolvable extension. */
function markSpecTargets(reached: Set<string>, dir: string, content: string, re: RegExp): void {
	for (const m of content.matchAll(re)) {
		const spec = m[1];
		if (!spec || !spec.startsWith(".")) continue;
		const base = join(dir, spec).split(sep).join("/").replace(/\.js$/, "");
		for (const ext of [".ts", ".tsx", ".js", ".jsx", "/index.ts"]) {
			reached.add(`${base}${ext}`);
		}
	}
}

/** Files consumed through `export … from` barrels or dynamic `import()`:
 *  the project graph tracks static import statements only, so both edge
 *  kinds need their own pass (the checks/<family> barrel made every family
 *  file look importerless; the lazily-loaded categorizer module repeated the
 *  class for dynamic imports). */
function reExportTargets(cwd: string, files: string[]): Set<string> {
	const reached = new Set<string>();
	for (const rel of files) {
		let content: string;
		try {
			content = readFileSync(join(cwd, rel), "utf-8");
		} catch (err) {
			void err; // unreadable — no edges from it
			continue;
		}
		const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
		markSpecTargets(reached, dir, content, REEXPORT_FROM_RE);
		markSpecTargets(reached, dir, content, DYNAMIC_IMPORT_RE);
	}
	return reached;
}

/** Sweep the repo once and report the three reachability-layer candidates. */
export function scanDeadCode(cwd: string): DeadCodeReport {
	const graph = new ProjectGraph(cwd);
	graph.initialize();
	const entries = entryPoints(cwd);

	const files = walkSourceFiles(cwd);
	const reExported = reExportTargets(cwd, files);
	const unreachableFiles: string[] = [];
	const deadImportBindings: DeadImportBinding[] = [];
	const deadExports: DeadExportFinding[] = [];
	const testOnlyImporterFiles: string[] = [];

	for (const relRaw of files) {
		const rel = relRaw.split(sep).join("/");
		if (TEST_OR_FIXTURE_RE.test(rel)) continue;
		const abs = join(cwd, rel);
		if (!existsSync(abs)) continue;
		const content = readFileSync(abs, "utf-8");

		const importers = graph.getImporters(abs);
		if (!entries.has(rel) && !reExported.has(rel) && importers.length === 0) {
			unreachableFiles.push(rel);
		}
		if (
			importers.length > 0 &&
			importers.every((e) => TEST_OR_FIXTURE_RE.test(e.fromFile.split(sep).join("/")))
		) {
			testOnlyImporterFiles.push(rel);
		}
		for (const binding of findDeadImports(content)) {
			deadImportBindings.push({ file: rel, binding });
		}
		for (const m of checkDeadExports(content, abs, cwd)) {
			deadExports.push({ file: rel, detail: m.text });
		}
	}

	unreachableFiles.sort((a, b) => a.localeCompare(b));
	return {
		unreachableFiles,
		deadImportBindings,
		deadExports,
		testOnlyImporterFiles,
		scannedFiles: files.length,
	};
}

/** The `--categorize` path (operator decision 2026-08-17): every candidate
 *  buckets by mechanical signals; only the compiler/mutation-guarded buckets
 *  are recommended for deletion. */
async function printCategorized(
	cwd: string,
	report: DeadCodeReport,
	json: boolean,
): Promise<number> {
	const { categorizeDeadCode, formatCategorizeReport } = await import("./deadcode-categorize.js");
	const testOnly = new Set(report.testOnlyImporterFiles ?? []);
	const categories = categorizeDeadCode(cwd, {
		unreachableFiles: report.unreachableFiles,
		deadExports: report.deadExports,
		testOnlyImportersFor: (rel) => testOnly.has(rel),
	});
	if (json) {
		console.log(JSON.stringify({ ...report, categories }, null, 2));
		return 0;
	}
	console.log(
		`Dead-code categorization — ${categories.items.length} candidate(s) bucketed by deletion safety`,
	);
	for (const line of formatCategorizeReport(categories)) console.log(line);
	console.log(
		"\nSafe-to-act buckets: reexport-residue, orphaned-type, superseded, inert branches. keep/annotate buckets are deliberate or planned code.",
	);
	return 0;
}

/** CLI action: print the report, grouped, with the candidate caveat. */
export async function deadcodeCommand(opts: {
	json?: boolean;
	categorize?: boolean;
	cwd?: string;
}): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	const report = scanDeadCode(cwd);
	if (opts.categorize) {
		return printCategorized(cwd, report, opts.json === true);
	}
	if (opts.json) {
		console.log(JSON.stringify(report, null, 2));
		return 0;
	}
	console.log(`Dead-code scan — ${report.scannedFiles} files (reachability layers; candidates, not verdicts)`);
	console.log(`\nUnreachable files (${report.unreachableFiles.length}) — nothing imports them; verify no runtime path loads them:`);
	for (const f of report.unreachableFiles) console.log(`  ${f}`);
	console.log(`\nDead import bindings (${report.deadImportBindings.length}) — imported, never referenced:`);
	for (const b of report.deadImportBindings.slice(0, 40)) console.log(`  ${b.file}: ${b.binding}`);
	if (report.deadImportBindings.length > 40)
		console.log(`  … +${report.deadImportBindings.length - 40} more (use --json)`);
	console.log(`\nDead export candidates (${report.deadExports.length}) — no consumer found (type-only surfaces are common false positives):`);
	for (const d of report.deadExports.slice(0, 40)) console.log(`  ${d.file}: ${d.detail}`);
	if (report.deadExports.length > 40)
		console.log(`  … +${report.deadExports.length - 40} more (use --json)`);
	console.log(
		"\nSemantic (behaviorally inert) dead code is the mutation lane's job: interlinked mutation disposition --list dead_code.",
	);
	return 0;
}
