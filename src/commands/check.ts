// ===========================================
// Check Command — Project-wide structural issue scan
// ===========================================
// Scans the project using the same checks the harness runs in real-time,
// giving a full picture of existing issues before agents start working.
// Optionally runs external tool checks (tsc, biome, mypy, etc.) via CheckEngine.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { CheckEngine, type CheckReport, type ToolId } from "../harness/check-engine/index.js";
import { ProjectGraph } from "../harness/project-graph.js";
import { containsSecrets, findAnyTypes } from "../harness/quality-checks.js";
import type { JsonObject } from "../lib/json-types.js";

interface StructuralCheckResult {
	name: string;
	files: Set<string>;
}

// Helper: returns true if any symbol in the import edge is not exported by the target file.
function hasMissingSymbol(importSymbols: string[], exportedNames: Set<string>): boolean {
	for (const sym of importSymbols) {
		if (!exportedNames.has(sym)) return true;
	}
	return false;
}

interface CycleRecordContext {
	cycle: string[];
	files: Set<string>;
	visited: Set<string>;
	toRelative: (f: string) => string;
}

// Helper: records every file in a cycle as affected and marks them visited.
function recordCycleFiles(ctx: CycleRecordContext): void {
	for (const f of ctx.cycle) {
		ctx.files.add(ctx.toRelative(f));
		ctx.visited.add(f);
	}
}

// --- Individual structural-check scanners -------------------------------
// Each returns the set of (relative) files flagged by that check. They mirror
// the inline blocks that previously lived in checkCommand, extracted so the
// orchestrator stays a thin dispatcher.

function scanBrokenImports(graph: ProjectGraph): Set<string> {
	const files = new Set<string>();
	for (const file of graph.allFiles()) {
		const edges = graph.getDependencies(file);
		for (const edge of edges) {
			if (!edge.toFile) continue;
			if (edge.specifier.endsWith(".json")) continue;
			if (edge.toFile.includes("/node_modules/")) continue;
			if (!existsSync(edge.toFile)) {
				files.add(graph.toRelative(file));
				break;
			}
			if (edge.symbols.length > 0) {
				const targetExports = graph.getExports(edge.toFile);
				const targetNames = new Set(targetExports.map((e) => e.name));
				targetNames.add("default");
				if (hasMissingSymbol(edge.symbols, targetNames)) {
					files.add(graph.toRelative(file));
				}
			}
		}
	}
	return files;
}

function scanCycles(graph: ProjectGraph): Set<string> {
	const files = new Set<string>();
	const visited = new Set<string>();
	const toRel = (f: string): string => graph.toRelative(f);
	for (const file of graph.allFiles()) {
		if (visited.has(file)) continue;
		const cycles = graph.findCyclesThrough(file);
		for (const cycle of cycles) {
			recordCycleFiles({ cycle, files, visited, toRelative: toRel });
		}
	}
	return files;
}

function scanDuplicates(graph: ProjectGraph): Set<string> {
	const files = new Set<string>();
	const symbolIndex = new Map<string, string[]>();
	for (const file of graph.allFiles()) {
		const boundary = graph.getProjectBoundary(file);
		const exports = graph.getExports(file);
		for (const exp of exports) {
			if (exp.name === "default" || exp.name === "*" || exp.isTypeOnly) continue;
			if (exp.kind === "re-export") continue;
			const key = `${exp.name}::${boundary}`;
			const existing = symbolIndex.get(key);
			if (existing) {
				existing.push(file);
			} else {
				symbolIndex.set(key, [file]);
			}
		}
	}
	for (const [, dupes] of symbolIndex) {
		if (dupes.length > 1) {
			for (const f of dupes) {
				files.add(graph.toRelative(f));
			}
		}
	}
	return files;
}

// Helper: true if a source file is exempt from the missing-tests scan by path
// or name convention (test/spec/decl/index/config/setup/fixtures/etc.).
function isMissingTestExempt(file: string, base: string): boolean {
	if (base.endsWith(".test") || base.endsWith(".spec") || base.endsWith(".d")) return true;
	if (base === "index") return true;
	if (file.endsWith(".d.ts")) return true;
	if (/\.config\.|\.setup\./.test(basename(file))) return true;
	if (file.includes("__tests__") || file.includes("__mocks__")) return true;
	if (file.includes("/test/") || file.includes("/tests/")) return true;
	if (file.includes("/fixtures/") || file.includes("/__fixtures__/")) return true;
	if (file.includes("/orchestration-scripts/") || file.includes("/templates/")) return true;
	return false;
}

function scanMissingTests(graph: ProjectGraph): Set<string> {
	const files = new Set<string>();
	for (const file of graph.allFiles()) {
		const ext = extname(file);
		if (![".ts", ".tsx", ".js", ".jsx"].includes(ext)) continue;
		const base = basename(file, ext);
		if (isMissingTestExempt(file, base)) continue;

		const dir = dirname(file);
		const candidates = [
			join(dir, `${base}.test${ext}`),
			join(dir, `${base}.spec${ext}`),
			join(dir, "__tests__", `${base}.test${ext}`),
			join(dir, "__tests__", `${base}.spec${ext}`),
		];
		if (!candidates.some((c) => existsSync(c))) {
			files.add(graph.toRelative(file));
		}
	}
	return files;
}

interface ContentScanOpts {
	allowedExts: string[];
	skipDecl: boolean;
	skipTestDirs: boolean;
	detector: (content: string) => boolean;
}

// Helper: scans every source file's content through a detector, collecting
// relative paths of files whose detector reports at least one finding. Shared
// by the secrets and any-types scans (which differ in ext-filter, decl-skip,
// test-dir skip, and detector). Unreadable files are skipped.
function scanFileContent(graph: ProjectGraph, scan: ContentScanOpts): Set<string> {
	const files = new Set<string>();
	for (const file of graph.allFiles()) {
		const ext = extname(file);
		if (!scan.allowedExts.includes(ext)) continue;
		if (scan.skipDecl && file.endsWith(".d.ts")) continue;
		const base = basename(file, ext);
		if (base.endsWith(".test") || base.endsWith(".spec")) continue;
		if (scan.skipTestDirs) {
			if (file.includes("__tests__") || file.includes("__mocks__")) continue;
			if (file.includes("/test/") || file.includes("/tests/")) continue;
		}
		try {
			const content = readFileSync(file, "utf-8");
			if (scan.detector(content)) {
				files.add(graph.toRelative(file));
			}
		} catch (_) {
			/* intentional: unreadable file during scan, skip content check */
		}
	}
	return files;
}

function scanSecrets(graph: ProjectGraph): Set<string> {
	return scanFileContent(graph, {
		allowedExts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		skipDecl: false,
		skipTestDirs: true,
		detector: (content) => containsSecrets(content).length > 0,
	});
}

function scanAnyTypes(graph: ProjectGraph): Set<string> {
	return scanFileContent(graph, {
		allowedExts: [".ts", ".tsx"],
		skipDecl: true,
		skipTestDirs: false,
		detector: (content) => findAnyTypes(content).length > 0,
	});
}

function scanBlastRadius(graph: ProjectGraph): Set<string> {
	const files = new Set<string>();
	for (const file of graph.allFiles()) {
		const dependents = graph.getDependents(file);
		if (dependents.length >= 5) {
			files.add(graph.toRelative(file));
		}
	}
	return files;
}

function scanDeadImports(graph: ProjectGraph): Set<string> {
	const files = new Set<string>();
	for (const file of graph.allFiles()) {
		const ext = extname(file);
		if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) continue;
		try {
			const content = readFileSync(file, "utf-8");
			const deadBindings = findDeadImports(content);
			if (deadBindings.length > 0) {
				files.add(graph.toRelative(file));
			}
		} catch (_) {
			/* intentional: unreadable file during scan, skip dead-imports check */
		}
	}
	return files;
}

const STRUCTURAL_CHECKS = [
	"broken-imports",
	"cycles",
	"duplicates",
	"missing-tests",
	"secrets",
	"any-types",
	"blast-radius",
	"dead-imports",
] as const;

const ALL_TOOL_IDS: ToolId[] = [
	"tsc",
	"biome",
	"eslint",
	"oxlint",
	"knip",
	"semgrep",
	"gitleaks",
	"mypy",
	"ruff",
	"cargo-check",
	"cargo-clippy",
	"go-build",
	"golangci-lint",
	"c-compile",
	"clang-tidy",
];

// Dispatch table: structural check name -> scanner. Keyed by the names in
// STRUCTURAL_CHECKS so iteration order (and thus results order) is preserved.
const STRUCTURAL_SCANNERS: Record<
	(typeof STRUCTURAL_CHECKS)[number],
	(graph: ProjectGraph) => Set<string>
> = {
	"broken-imports": scanBrokenImports,
	cycles: scanCycles,
	duplicates: scanDuplicates,
	"missing-tests": scanMissingTests,
	secrets: scanSecrets,
	"any-types": scanAnyTypes,
	"blast-radius": scanBlastRadius,
	"dead-imports": scanDeadImports,
};

// Runs every structural check whose name passes `shouldRun`, in the canonical
// STRUCTURAL_CHECKS order, returning the accumulated results.
function runStructuralChecks(
	graph: ProjectGraph,
	shouldRun: (name: string) => boolean,
): StructuralCheckResult[] {
	const results: StructuralCheckResult[] = [];
	for (const name of STRUCTURAL_CHECKS) {
		if (!shouldRun(name)) continue;
		results.push({ name, files: STRUCTURAL_SCANNERS[name](graph) });
	}
	return results;
}

// Runs the external-tool engine when requested, returning its report (or null
// when the engine phase is skipped).
function runEngineChecks(
	cwd: string,
	runEngine: boolean,
	engineToolFilter: ToolId[] | undefined,
): CheckReport | null {
	if (!runEngine) return null;
	const engine = new CheckEngine(cwd);
	const scope = { projectRoot: cwd, mode: "project" as const };
	process.stderr.write("  running external tools...\n");
	return engine.runChecks(scope, {
		...(engineToolFilter !== undefined ? { tools: engineToolFilter } : {}),
		timeoutMs: 30_000,
	});
}

// Builds + writes the combined JSON payload (structural counts + engine
// findings) to stdout.
function emitJsonOutput(results: StructuralCheckResult[], engineReport: CheckReport | null): void {
	const jsonData: JsonObject = {};
	for (const r of results) {
		jsonData[r.name] = { count: r.files.size, files: [...r.files].sort() };
	}
	if (engineReport) {
		for (const tool of engineReport.toolsRun) {
			const toolResults = engineReport.results.filter((r) => r.tool === tool.id);
			jsonData[tool.id] = {
				count: toolResults.length,
				findings: toolResults.map((r) => ({
					file: r.file,
					line: r.line,
					severity: r.severity,
					message: r.message,
					ruleId: r.ruleId,
				})),
			};
		}
	}
	process.stdout.write(`${JSON.stringify(jsonData, null, 2)}\n`);
}

// Writes the single-check (`--only`) text output for a structural check:
// flagged files to stdout, the count to stderr.
function emitStructuralOnly(results: StructuralCheckResult[], onlyCheck: string): void {
	const result = results.find((r) => r.name === onlyCheck);
	if (result && result.files.size > 0) {
		for (const f of [...result.files].sort()) {
			process.stdout.write(`${f}\n`);
		}
		process.stderr.write(`\n${result.files.size} files\n`);
	} else {
		process.stderr.write("0 files\n");
	}
}

// Writes the single-check (`--only`) text output for an engine tool: findings
// (sorted by file) to stdout, the count to stderr.
function emitEngineOnly(engineReport: CheckReport, onlyCheck: string): void {
	const toolResults = engineReport.results.filter((r) => r.tool === onlyCheck);
	if (toolResults.length > 0) {
		for (const r of toolResults.sort((a, b) => a.file.localeCompare(b.file))) {
			process.stdout.write(`${r.file}:${r.line}: ${r.message}\n`);
		}
		process.stderr.write(`\n${toolResults.length} findings\n`);
	} else {
		process.stderr.write("0 findings\n");
	}
}

const SEVERITY_CHECK_ERRORS = new Set(["broken-imports", "cycles", "dead-imports", "secrets"]);

// Builds the colored icon + count fragment for one structural-summary row.
function structuralRowMarks(size: number, isError: boolean): { icon: string; count: string } {
	if (size === 0) {
		return { icon: "\x1b[32m✓\x1b[0m", count: "\x1b[32m0\x1b[0m" };
	}
	const icon = isError ? "\x1b[31m✗\x1b[0m" : "\x1b[33m!\x1b[0m";
	const count = isError ? `\x1b[31m${size}\x1b[0m` : `\x1b[33m${size}\x1b[0m`;
	return { icon, count };
}

// Writes the structural-checks section of the full summary. Accumulates flagged
// files into `allFlagged`; returns whether any error-severity check fired.
function emitStructuralSummary(results: StructuralCheckResult[], allFlagged: Set<string>): boolean {
	if (results.length === 0) return false;
	let hasErrors = false;
	process.stderr.write("  Structural checks:\n\n");
	for (const r of results) {
		const isError = SEVERITY_CHECK_ERRORS.has(r.name);
		if (isError && r.files.size > 0) hasErrors = true;
		const { icon, count } = structuralRowMarks(r.files.size, isError);
		const severity = isError ? "error" : "info";
		process.stderr.write(`  ${icon} ${r.name} [${severity}]: ${count} files\n`);
		for (const f of r.files) allFlagged.add(f);
	}
	return hasErrors;
}

// Writes one engine-tool row of the full summary. Accumulates flagged files
// into `allFlagged`; returns whether this tool reported any error-severity
// finding.
function emitEngineToolRow(
	tool: CheckReport["toolsRun"][number],
	engineReport: CheckReport,
	allFlagged: Set<string>,
): boolean {
	const toolResults = engineReport.results.filter((r) => r.tool === tool.id);
	const errorCount = toolResults.filter((r) => r.severity === "error").length;
	const total = toolResults.length;
	const version = tool.version || "?";

	if (total === 0) {
		process.stderr.write(
			`  \x1b[32m✓\x1b[0m ${tool.id} [${version}]: \x1b[32m0\x1b[0m findings\n`,
		);
		return false;
	}
	const icon = errorCount > 0 ? "\x1b[31m✗\x1b[0m" : "\x1b[33m!\x1b[0m";
	const countStr = errorCount > 0 ? `\x1b[31m${total}\x1b[0m` : `\x1b[33m${total}\x1b[0m`;
	const warnCount = total - errorCount;
	process.stderr.write(
		`  ${icon} ${tool.id} [${version}]: ${countStr} findings (${errorCount} errors, ${warnCount} warnings)\n`,
	);
	for (const r of toolResults) allFlagged.add(r.file);
	return errorCount > 0;
}

// Writes the external-tool-checks section of the full summary. Accumulates
// flagged files into `allFlagged`; returns whether any tool reported errors.
function emitEngineSummary(engineReport: CheckReport, allFlagged: Set<string>): boolean {
	let hasErrors = false;
	process.stderr.write("\n  External tool checks:\n\n");
	for (const tool of engineReport.toolsRun) {
		if (emitEngineToolRow(tool, engineReport, allFlagged)) hasErrors = true;
	}
	for (const tool of engineReport.toolsSkipped.filter((t) => !t.available)) {
		process.stderr.write(`  \x1b[2m- ${tool.id}: ${tool.reason || "skipped"}\x1b[0m\n`);
	}
	process.stderr.write(
		`\x1b[2m  completed in ${(engineReport.elapsedMs / 1000).toFixed(1)}s\x1b[0m\n`,
	);
	return hasErrors;
}

interface ResolvedCheckPlan {
	onlyCheck: string | undefined;
	isStructuralOnly: boolean;
	isEngineOnly: boolean;
	runEngine: boolean;
	runStructural: boolean;
	engineToolFilter: ToolId[] | undefined;
	unknown: boolean;
}

// Resolves the --only / --tools / --report options into a check plan. `unknown`
// is set when --only names neither a structural check nor an engine tool.
function resolveCheckPlan(opts: {
	only?: string;
	tools?: boolean | string;
	report?: boolean;
}): ResolvedCheckPlan {
	const onlyCheck = opts.only;
	const isStructuralOnly = Boolean(
		onlyCheck && (STRUCTURAL_CHECKS as readonly string[]).includes(onlyCheck),
	);
	const isEngineOnly = Boolean(onlyCheck && ALL_TOOL_IDS.includes(onlyCheck as ToolId));
	const unknown = Boolean(onlyCheck) && !isStructuralOnly && !isEngineOnly;

	const runEngine = opts.tools !== undefined || Boolean(opts.report) || isEngineOnly;
	const runStructural = !isEngineOnly;

	let engineToolFilter: ToolId[] | undefined;
	if (isEngineOnly && onlyCheck) {
		engineToolFilter = [onlyCheck as ToolId];
	} else if (typeof opts.tools === "string") {
		engineToolFilter = opts.tools.split(",").map((t) => t.trim()) as ToolId[];
	}

	return {
		onlyCheck,
		isStructuralOnly,
		isEngineOnly,
		runEngine,
		runStructural,
		engineToolFilter,
		unknown,
	};
}

// Writes the full (no-filter) summary: header, structural section, engine
// section, totals, and the process exit code on error.
function emitFullSummary(
	results: StructuralCheckResult[],
	engineReport: CheckReport | null,
	fileCount: number,
): void {
	const allFlagged = new Set<string>();
	let hasErrors = false;
	process.stderr.write(`\n  Interlinked project check (${fileCount} files indexed)\n\n`);

	if (emitStructuralSummary(results, allFlagged)) hasErrors = true;
	if (engineReport && emitEngineSummary(engineReport, allFlagged)) hasErrors = true;

	process.stderr.write(`\n  total unique: ${allFlagged.size} / ${fileCount} files\n\n`);

	if (hasErrors) {
		process.exitCode = 1;
	}
}

export async function checkCommand(opts: {
	only?: string;
	json?: boolean;
	cwd?: string;
	tools?: boolean | string;
	report?: boolean;
}): Promise<void> {
	const cwd = opts.cwd || process.cwd();

	// --- Resolve --only / --tools / --report against both namespaces ---
	const plan = resolveCheckPlan(opts);
	const { onlyCheck, isStructuralOnly, isEngineOnly } = plan;

	if (plan.unknown) {
		process.stderr.write(
			`Unknown check: "${onlyCheck}". Available: ${[...STRUCTURAL_CHECKS, ...ALL_TOOL_IDS].join(", ")}\n`,
		);
		process.exitCode = 1;
		return;
	}

	// --- Tool report ---
	if (opts.report) {
		const engine = new CheckEngine(cwd);
		process.stderr.write(`\n  ${engine.formatToolReport()}\n\n`);
		if (!opts.tools && !onlyCheck) return;
	}

	// Build the project graph (needed for structural checks)
	let graph: ProjectGraph | undefined;
	if (plan.runStructural) {
		graph = new ProjectGraph(cwd);
		graph.initialize();
	}

	const shouldRun = (name: string): boolean => !onlyCheck || onlyCheck === name;

	// --- Structural checks (instant, graph-based) ---
	const results: StructuralCheckResult[] =
		plan.runStructural && graph ? runStructuralChecks(graph, shouldRun) : [];

	// --- Engine checks (external tools, opt-in) ---
	const engineReport = runEngineChecks(cwd, plan.runEngine, plan.engineToolFilter);

	// --- Output ---
	if (opts.json) {
		emitJsonOutput(results, engineReport);
		return;
	}

	if (onlyCheck) {
		if (isStructuralOnly) {
			emitStructuralOnly(results, onlyCheck);
		} else if (isEngineOnly && engineReport) {
			emitEngineOnly(engineReport, onlyCheck);
		}
		return;
	}

	// --- Full summary ---
	emitFullSummary(results, engineReport, graph?.fileCount ?? 0);
}

// ===========================================
// Dead Import Detection (shared with structural-checks.ts)
// ===========================================

// Helper: true for lines that precede / interleave with imports but are not
// themselves import statements (blank, JSDoc/star comments, shebang).
function isNonImportPrefixLine(trimmed: string): boolean {
	return (
		trimmed === "" ||
		trimmed.startsWith("*") ||
		trimmed.startsWith("/*") ||
		trimmed.startsWith("*/") ||
		trimmed.startsWith("#!")
	);
}

interface ImportScanState {
	bindings: string[];
	lastImportLine: number;
	buffer: string;
	importSectionEnded: boolean;
}

// Helper: processes a single source line during the import-collection scan,
// mutating `state` (buffer continuation, binding extraction, section end).
function scanImportLine(state: ImportScanState, lineIndex: number, trimmed: string): void {
	if (state.buffer) {
		state.buffer += ` ${trimmed}`;
		if (/from\s+['"]/.test(state.buffer) || /['"]/.test(state.buffer)) {
			extractBindings(state.buffer, state.bindings);
			state.buffer = "";
		}
		state.lastImportLine = lineIndex;
		return;
	}
	// Stop scanning once we hit non-import code (prevents matching imports
	// inside string literals, template HTML, generated scripts, etc.)
	if (state.importSectionEnded) return;
	if (isNonImportPrefixLine(trimmed)) return;
	if (/^import\s/.test(trimmed) && trimmed.includes("{") && !trimmed.includes("}")) {
		state.buffer = trimmed;
		state.lastImportLine = lineIndex;
		return;
	}
	if (/^import\s/.test(trimmed)) {
		extractBindings(trimmed, state.bindings);
		state.lastImportLine = lineIndex;
		return;
	}
	// Non-import, non-blank line — import section is over
	state.importSectionEnded = true;
}

// Helper: returns the subset of import bindings that never appear in the file
// body below the import section.
function filterDeadBindings(bindings: string[], body: string): string[] {
	const dead: string[] = [];
	for (const name of bindings) {
		if (!name || name.length < 2) continue;
		const regex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
		if (!regex.test(body)) {
			dead.push(name);
		}
	}
	return dead;
}

/** Find import bindings that are not referenced in the file body */
export function findDeadImports(content: string): string[] {
	const lines = content.split("\n");
	const state: ImportScanState = {
		bindings: [],
		lastImportLine: 0,
		buffer: "",
		importSectionEnded: false,
	};

	for (let i = 0; i < lines.length; i++) {
		// Strip inline comments from import lines
		const trimmed = lines[i]
			.trim()
			.replace(/\/\/[^\n]*/g, "")
			.trim();
		scanImportLine(state, i, trimmed);
	}
	if (state.buffer) extractBindings(state.buffer, state.bindings);

	if (state.bindings.length === 0) return [];

	const body = lines.slice(state.lastImportLine + 1).join("\n");
	return filterDeadBindings(state.bindings, body);
}

export function extractBindings(line: string, bindings: string[]): void {
	const trimmed = line.trim();
	if (trimmed.startsWith("//")) return;
	if (/^import\s+['"]/.test(trimmed)) return;
	if (/^import\s+\*\s+as\s/.test(trimmed)) return;

	const namedMatch = trimmed.match(/^import\s+(?:type\s+)?\{([^}]+)\}/);
	if (namedMatch) {
		const names = namedMatch[1]
			.split(",")
			.map((s) => {
				const parts = s
					.trim()
					.replace(/^type\s+/, "")
					.split(/\s+as\s+/);
				return parts[parts.length - 1].trim();
			})
			.filter(Boolean);
		for (const name of names) {
			if (name !== "type") bindings.push(name);
		}
		return;
	}

	const defaultMatch = trimmed.match(/^import\s+(?:type\s+)?(\w+)\s+from/);
	if (defaultMatch && defaultMatch[1] !== "type") {
		bindings.push(defaultMatch[1]);
	}
}
