import { isAbsolute, relative, resolve } from "node:path";
import { configNameToToolId } from "../check-engine/index.js";
import type { ToolId } from "../check-engine/types.js";
import type { QualityCheckConfig } from "../types.js";
import { isLikelyTestFile } from "./test-classifier.js";

export const MULTI_FILE_NAMED_EXTERNAL_CHECKS = new Set([
	"affected_tests",
	"dependency_audit",
]);

const PROJECT_BATCH_TOOLS = new Set<ToolId>([
	"tsc",
	"biome",
	"eslint",
	"oxlint",
	"semgrep",
	"gitleaks",
	"mypy",
	"ruff",
	"ruff-format",
	"cargo-check",
	"cargo-clippy",
	"rustfmt",
	"go-build",
	"golangci-lint",
	"swiftlint",
	"swift-build",
	"lizard",
	"knip",
	"actionlint",
]);

export interface ExternalCandidate {
	readonly name: string;
	readonly check: QualityCheckConfig;
	readonly toolId: ToolId;
}

export interface NamedExternalCandidate {
	readonly name: string;
	readonly check: QualityCheckConfig;
}

export interface DeferredCheck {
	readonly name: string;
	readonly reason: string;
}

export function pathMatchesCheck(path: string, check: QualityCheckConfig): boolean {
	if (!check.file_types.some((suffix) => path.endsWith(suffix))) return false;
	if (!check.skip_test_files) return true;
	const absolute = isAbsolute(path) ? path : resolve(path);
	const base = absolute.slice(absolute.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
	return !isLikelyTestFile(base, absolute);
}

export function normalizeProjectPath(projectRoot: string, path: string): string {
	const absolute = isAbsolute(path) ? path : resolve(projectRoot, path);
	return relative(projectRoot, absolute).replace(/\\/g, "/");
}

export function uniquePaths(paths: readonly string[]): string[] {
	return [...new Set(paths.filter((path) => path.length > 0))];
}

export function candidateChecks(options: {
	paths: readonly string[];
	checks: Record<string, QualityCheckConfig>;
}): {
	candidates: ExternalCandidate[];
	deferred: DeferredCheck[];
	affectedTests?: NamedExternalCandidate;
	dependencyAudit?: NamedExternalCandidate;
} {
	const candidates: ExternalCandidate[] = [];
	const deferred: DeferredCheck[] = [];
	let affectedTests: NamedExternalCandidate | undefined;
	let dependencyAudit: NamedExternalCandidate | undefined;
	const seenTools = new Set<ToolId>();
	for (const [name, check] of Object.entries(options.checks)) {
		if (!check.enabled) continue;
		if (!options.paths.some((path) => pathMatchesCheck(path, check))) continue;
		if (name === "affected_tests") {
			affectedTests = { name, check };
			continue;
		}
		if (name === "dependency_audit") {
			dependencyAudit = { name, check };
			continue;
		}
		if (!check.command) continue;
		const toolId = configNameToToolId(name);
		if (!toolId || toolId === "dep-audit") continue;
		if (!PROJECT_BATCH_TOOLS.has(toolId)) {
			deferred.push({
				name,
				reason: "the configured runner is file-only and has no bounded multi-file mode",
			});
			continue;
		}
		if (seenTools.has(toolId)) continue;
		seenTools.add(toolId);
		candidates.push({ name, check, toolId });
	}
	return {
		candidates,
		deferred,
		...(affectedTests ? { affectedTests } : {}),
		...(dependencyAudit ? { dependencyAudit } : {}),
	};
}
