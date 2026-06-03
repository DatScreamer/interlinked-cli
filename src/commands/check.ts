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

export async function checkCommand(opts: {
	only?: string;
	json?: boolean;
	cwd?: string;
	tools?: boolean | string;
	report?: boolean;
}): Promise<void> {
	const cwd = opts.cwd || process.cwd();

	// --- Resolve --only against both namespaces ---
	const onlyCheck = opts.only;
	const isStructuralOnly =
		onlyCheck && (STRUCTURAL_CHECKS as readonly string[]).includes(onlyCheck);
	const isEngineOnly = onlyCheck && ALL_TOOL_IDS.includes(onlyCheck as ToolId);

	if (onlyCheck && !isStructuralOnly && !isEngineOnly) {
		process.stderr.write(
			`Unknown check: "${onlyCheck}". Available: ${[...STRUCTURAL_CHECKS, ...ALL_TOOL_IDS].join(", ")}\n`,
		);
		process.exitCode = 1;
		return;
	}

	// Determine if engine checks should run
	const runEngine = opts.tools !== undefined || opts.report || isEngineOnly;
	const runStructural = !isEngineOnly;

	// Determine which tools to run
	let engineToolFilter: ToolId[] | undefined;
	if (isEngineOnly) {
		engineToolFilter = [onlyCheck as ToolId];
	} else if (typeof opts.tools === "string") {
		engineToolFilter = opts.tools.split(",").map((t) => t.trim()) as ToolId[];
	}

	// --- Tool report ---
	if (opts.report) {
		const engine = new CheckEngine(cwd);
		process.stderr.write(`\n  ${engine.formatToolReport()}\n\n`);
		if (!opts.tools && !onlyCheck) return;
	}

	// Build the project graph (needed for structural checks)
	let graph: ProjectGraph | undefined;
	if (runStructural) {
		graph = new ProjectGraph(cwd);
		graph.initialize();
	}

	const results: StructuralCheckResult[] = [];

	function shouldRun(name: string): boolean {
		return !onlyCheck || onlyCheck === name;
	}

	// --- Structural checks (instant, graph-based) ---
	if (runStructural && graph) {
		// --- 1. Broken imports ---
		if (shouldRun("broken-imports")) {
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
			results.push({ name: "broken-imports", files });
		}

		// --- 2. Import cycles ---
		if (shouldRun("cycles")) {
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
			results.push({ name: "cycles", files });
		}

		// --- 3. Duplicate exports (boundary-aware) ---
		if (shouldRun("duplicates")) {
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
			results.push({ name: "duplicates", files });
		}

		// --- 4. Missing test files ---
		if (shouldRun("missing-tests")) {
			const files = new Set<string>();
			for (const file of graph.allFiles()) {
				const ext = extname(file);
				if (![".ts", ".tsx", ".js", ".jsx"].includes(ext)) continue;
				const base = basename(file, ext);
				if (base.endsWith(".test") || base.endsWith(".spec") || base.endsWith(".d"))
					continue;
				if (base === "index") continue;
				if (file.endsWith(".d.ts")) continue;
				if (/\.config\.|\.setup\./.test(basename(file))) continue;
				if (file.includes("__tests__") || file.includes("__mocks__")) continue;
				if (file.includes("/test/") || file.includes("/tests/")) continue;
				if (file.includes("/fixtures/") || file.includes("/__fixtures__/")) continue;
				if (file.includes("/orchestration-scripts/") || file.includes("/templates/"))
					continue;

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
			results.push({ name: "missing-tests", files });
		}

		// --- 5. Secrets in source ---
		if (shouldRun("secrets")) {
			const files = new Set<string>();
			for (const file of graph.allFiles()) {
				const ext = extname(file);
				if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) continue;
				const base = basename(file, ext);
				if (base.endsWith(".test") || base.endsWith(".spec")) continue;
				if (file.includes("__tests__") || file.includes("__mocks__")) continue;
				if (file.includes("/test/") || file.includes("/tests/")) continue;
				try {
					const content = readFileSync(file, "utf-8");
					if (containsSecrets(content).length > 0) {
						files.add(graph.toRelative(file));
					}
				} catch (_) {
					/* intentional: unreadable file during scan, skip secrets check */
				}
			}
			results.push({ name: "secrets", files });
		}

		// --- 6. Explicit `any` types ---
		if (shouldRun("any-types")) {
			const files = new Set<string>();
			for (const file of graph.allFiles()) {
				const ext = extname(file);
				if (![".ts", ".tsx"].includes(ext)) continue;
				if (file.endsWith(".d.ts")) continue;
				const base = basename(file, ext);
				if (base.endsWith(".test") || base.endsWith(".spec")) continue;
				try {
					const content = readFileSync(file, "utf-8");
					if (findAnyTypes(content).length > 0) {
						files.add(graph.toRelative(file));
					}
				} catch (_) {
					/* intentional: unreadable file during scan, skip any-types check */
				}
			}
			results.push({ name: "any-types", files });
		}

		// --- 7. High blast-radius files ---
		if (shouldRun("blast-radius")) {
			const files = new Set<string>();
			for (const file of graph.allFiles()) {
				const dependents = graph.getDependents(file);
				if (dependents.length >= 5) {
					files.add(graph.toRelative(file));
				}
			}
			results.push({ name: "blast-radius", files });
		}

		// --- 8. Dead imports ---
		if (shouldRun("dead-imports")) {
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
			results.push({ name: "dead-imports", files });
		}
	}

	// --- Engine checks (external tools, opt-in) ---
	let engineReport: CheckReport | null = null;

	if (runEngine) {
		const engine = new CheckEngine(cwd);
		const scope = { projectRoot: cwd, mode: "project" as const };
		process.stderr.write("  running external tools...\n");
		engineReport = engine.runChecks(scope, {
			...(engineToolFilter !== undefined ? { tools: engineToolFilter } : {}),
			timeoutMs: 30_000,
		});
	}

	// --- Output ---
	if (opts.json) {
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
		return;
	}

	if (onlyCheck) {
		if (isStructuralOnly) {
			const result = results.find((r) => r.name === onlyCheck);
			if (result && result.files.size > 0) {
				for (const f of [...result.files].sort()) {
					process.stdout.write(`${f}\n`);
				}
				process.stderr.write(`\n${result.files.size} files\n`);
			} else {
				process.stderr.write("0 files\n");
			}
		} else if (isEngineOnly && engineReport) {
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
		return;
	}

	// Severity classification
	const ERROR_CHECKS = new Set(["broken-imports", "cycles", "dead-imports", "secrets"]);

	// Full summary
	const allFlagged = new Set<string>();
	let hasErrors = false;
	const fileCount = graph?.fileCount ?? 0;
	process.stderr.write(`\n  Interlinked project check (${fileCount} files indexed)\n\n`);

	// Structural results
	if (results.length > 0) {
		process.stderr.write("  Structural checks:\n\n");
		for (const r of results) {
			const isError = ERROR_CHECKS.has(r.name);
			if (isError && r.files.size > 0) hasErrors = true;
			const icon =
				r.files.size === 0
					? "\x1b[32m\u2713\x1b[0m"
					: isError
						? "\x1b[31m\u2717\x1b[0m"
						: "\x1b[33m!\x1b[0m";
			const severity = isError ? "error" : "info";
			const count =
				r.files.size > 0
					? isError
						? `\x1b[31m${r.files.size}\x1b[0m`
						: `\x1b[33m${r.files.size}\x1b[0m`
					: "\x1b[32m0\x1b[0m";
			process.stderr.write(`  ${icon} ${r.name} [${severity}]: ${count} files\n`);
			for (const f of r.files) allFlagged.add(f);
		}
	}

	// Engine results
	if (engineReport) {
		process.stderr.write("\n  External tool checks:\n\n");

		for (const tool of engineReport.toolsRun) {
			const toolResults = engineReport.results.filter((r) => r.tool === tool.id);
			const errorCount = toolResults.filter((r) => r.severity === "error").length;
			const total = toolResults.length;

			if (total === 0) {
				process.stderr.write(
					`  \x1b[32m\u2713\x1b[0m ${tool.id} [${tool.version || "?"}]: \x1b[32m0\x1b[0m findings\n`,
				);
			} else {
				const icon = errorCount > 0 ? "\x1b[31m\u2717\x1b[0m" : "\x1b[33m!\x1b[0m";
				const countStr =
					errorCount > 0 ? `\x1b[31m${total}\x1b[0m` : `\x1b[33m${total}\x1b[0m`;
				const warnCount = total - errorCount;
				process.stderr.write(
					`  ${icon} ${tool.id} [${tool.version || "?"}]: ${countStr} findings (${errorCount} errors, ${warnCount} warnings)\n`,
				);
				if (errorCount > 0) hasErrors = true;
				for (const r of toolResults) allFlagged.add(r.file);
			}
		}

		for (const tool of engineReport.toolsSkipped.filter((t) => !t.available)) {
			process.stderr.write(`  \x1b[2m- ${tool.id}: ${tool.reason || "skipped"}\x1b[0m\n`);
		}

		process.stderr.write(
			`\x1b[2m  completed in ${(engineReport.elapsedMs / 1000).toFixed(1)}s\x1b[0m\n`,
		);
	}

	process.stderr.write(`\n  total unique: ${allFlagged.size} / ${fileCount} files\n\n`);

	if (hasErrors) {
		process.exitCode = 1;
	}
}

// ===========================================
// Dead Import Detection (shared with structural-checks.ts)
// ===========================================

/** Find import bindings that are not referenced in the file body */
export function findDeadImports(content: string): string[] {
	const lines = content.split("\n");
	const bindings: string[] = [];
	let lastImportLine = 0;
	let buffer = "";

	let importSectionEnded = false;
	for (let i = 0; i < lines.length; i++) {
		// Strip inline comments from import lines
		const trimmed = lines[i]
			.trim()
			.replace(/\/\/[^\n]*/g, "")
			.trim();
		if (buffer) {
			buffer += ` ${trimmed}`;
			if (/from\s+['"]/.test(buffer) || /['"]/.test(buffer)) {
				extractBindings(buffer, bindings);
				buffer = "";
			}
			lastImportLine = i;
			continue;
		}
		// Stop scanning once we hit non-import code (prevents matching imports
		// inside string literals, template HTML, generated scripts, etc.)
		if (importSectionEnded) continue;
		if (
			trimmed === "" ||
			trimmed.startsWith("*") ||
			trimmed.startsWith("/*") ||
			trimmed.startsWith("*/") ||
			trimmed.startsWith("#!")
		)
			continue;
		if (/^import\s/.test(trimmed) && trimmed.includes("{") && !trimmed.includes("}")) {
			buffer = trimmed;
			lastImportLine = i;
			continue;
		}
		if (/^import\s/.test(trimmed)) {
			extractBindings(trimmed, bindings);
			lastImportLine = i;
			continue;
		}
		// Non-import, non-blank line — import section is over
		importSectionEnded = true;
	}
	if (buffer) extractBindings(buffer, bindings);

	if (bindings.length === 0) return [];

	const body = lines.slice(lastImportLine + 1).join("\n");
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
