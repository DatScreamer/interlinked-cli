// ===========================================
// Simplification review — local evidence adapters
// ===========================================

import { readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { runVerifyParityChecks } from "../harness/verify-parity.js";
import type {
	SimplificationEvidence,
	SimplificationEvidenceState,
	SimplificationRemedy,
	SimplificationSourceCoverage,
} from "../lib/simplification-types.js";
import { buildDocsCorpus, categorizeDeadCode } from "./deadcode-categorize.js";
import type { CategorizeReport, CategorizedItem, InertBranchItem } from "./deadcode-categorize.js";
import { scanDeadCode, type DeadCodeReport, type DeadImportBinding } from "./deadcode.js";

export const LOCAL_SIMPLIFICATION_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
]);

export interface SimplificationCandidateDraft {
	source: string;
	remedy: SimplificationRemedy;
	evidenceState: SimplificationEvidenceState;
	confidence: number;
	path: string;
	startLine: number | null;
	endLine: number | null;
	key: string;
	summary: string;
	replacement: string | null;
	evidence: SimplificationEvidence[];
	estimatedLoc: number | null;
	estimatedDependenciesRemoved?: string[];
	relatedPaths: string[];
}

export interface SimplificationDetectorResult {
	drafts: SimplificationCandidateDraft[];
	sources: SimplificationSourceCoverage[];
}

function normalizedRel(cwd: string, path: string): string {
	return relative(cwd, path).replace(/\\/g, "/");
}

function safeContent(cwd: string, path: string): string | null {
	try {
		return readFileSync(join(cwd, path), "utf-8");
	} catch {
		return null;
	}
}

function countLines(content: string | null): number | null {
	return content === null ? null : content.split("\n").length;
}

function lineFor(content: string | null, needle: string): number | null {
	if (content === null || needle.length === 0) return null;
	const offset = content.indexOf(needle);
	return offset < 0 ? null : content.slice(0, offset).split("\n").length;
}

function deadImportDraft(cwd: string, binding: DeadImportBinding): SimplificationCandidateDraft {
	const line = lineFor(safeContent(cwd, binding.file), binding.binding);
	return {
		source: "deadcode.unused_import_binding",
		remedy: "delete",
		evidenceState: "heuristic",
		confidence: 0.8,
		path: binding.file,
		startLine: line,
		endLine: line,
		key: binding.binding,
		summary: `Imported binding \`${binding.binding}\` is not referenced in this file.`,
		replacement: null,
		evidence: [{
			kind: "static-reference-scan",
			state: "heuristic",
			detail: "The existing dead-import scanner found no in-file reference.",
			path: binding.file,
		}],
		estimatedLoc: -1,
		relatedPaths: [],
	};
}

function categoryBase(item: CategorizedItem): string {
	return item.file.slice(item.file.lastIndexOf("/") + 1).replace(/\.[jt]sx?$/, "");
}

function categorizedDraft(
	cwd: string,
	item: CategorizedItem,
): SimplificationCandidateDraft {
	const content = safeContent(cwd, item.file);
	const line = item.symbol ? lineFor(content, item.symbol) : 1;
	const isCandidate = item.bucket === "ambiguous";
	const fileLines = countLines(content);
	return {
		source: "deadcode.categorization",
		remedy: "delete",
		evidenceState: isCandidate ? "candidate" : "heuristic",
		confidence: isCandidate ? 0.35 : 0.78,
		path: item.file,
		startLine: line,
		endLine: item.symbol ? line : fileLines,
		key: item.symbol ?? item.bucket,
		summary: `${item.symbol ? `Export \`${item.symbol}\`` : "File"} is a ${item.bucket} candidate: ${item.reason}.`,
		replacement: null,
		evidence: [{
			kind: "mechanical-deletion-safety-signals",
			state: isCandidate ? "candidate" : "heuristic",
			detail: item.reason,
			path: item.file,
		}],
		estimatedLoc: item.symbol ? -1 : fileLines === null ? null : -fileLines,
		relatedPaths: [],
	};
}

function inertDraft(branch: InertBranchItem): SimplificationCandidateDraft {
	return {
		source: "mutation.dead_code_disposition",
		remedy: "delete",
		evidenceState: "heuristic",
		confidence: 0.75,
		path: branch.file,
		startLine: null,
		endLine: null,
		key: branch.qualifiedName,
		summary: `Mutation evidence was adjudicated as dead code in \`${branch.qualifiedName}\`.`,
		replacement: null,
		evidence: [{
			kind: "mutation-disposition-ledger",
			state: "heuristic",
			detail: `${branch.records} dead-code disposition record(s); no removal patch was validated by this run.`,
			path: branch.file,
		}],
		estimatedLoc: null,
		relatedPaths: [],
	};
}

function categorizedDrafts(
	cwd: string,
	categories: CategorizeReport,
): SimplificationCandidateDraft[] {
	const docs = buildDocsCorpus(cwd);
	const drafts: SimplificationCandidateDraft[] = [];
	for (const item of categories.items) {
		if (item.recommendation === "keep" || item.recommendation === "annotate") continue;
		if (!item.symbol && item.bucket === "ambiguous" && docs.mentions(categoryBase(item))) continue;
		drafts.push(categorizedDraft(cwd, item));
	}
	return [...drafts, ...categories.inertBranches.map(inertDraft)];
}

function categorizeWithoutHistory(cwd: string, report: DeadCodeReport): CategorizeReport {
	const testOnly = new Set(report.testOnlyImporterFiles ?? []);
	return categorizeDeadCode(cwd, {
		unreachableFiles: report.unreachableFiles,
		deadExports: report.deadExports,
		testOnlyImportersFor: (path) => testOnly.has(path),
		// Unknown history is conservative: the bounded local pass never claims
		// that a file was never imported merely because archaeology was skipped.
		gitProbe: () => ({ everImported: true, hadImportersRemoved: false }),
	});
}

function unavailableSource(source: string, error: unknown): SimplificationDetectorResult {
	return {
		drafts: [],
		sources: [{
			source,
			status: "unavailable",
			files_considered: 0,
			analyzed_paths: [],
			findings_emitted: 0,
			notes: [error instanceof Error ? error.message : `${source} unavailable`],
		}],
	};
}

export function collectDeadCodeEvidence(cwd: string): SimplificationDetectorResult {
	try {
		const report = scanDeadCode(cwd);
		const drafts = [
			...report.deadImportBindings.map((binding) => deadImportDraft(cwd, binding)),
			...categorizedDrafts(cwd, categorizeWithoutHistory(cwd, report)),
		];
		return {
			drafts,
			sources: [{
				source: "deadcode.reachability-and-categorization",
				status: "partial",
				files_considered: report.scannedPaths.length,
				analyzed_paths: report.scannedPaths,
				findings_emitted: drafts.length,
				notes: [
					"Static reachability and deletion-safety signals are candidates, not semantic verdicts.",
					"Per-candidate git-history probes were skipped for bounded local latency.",
				],
			}],
		};
	} catch (error) {
		return unavailableSource("deadcode.reachability-and-categorization", error);
	}
}

function singleInterfaceDraft(
	cwd: string,
	result: ReturnType<typeof runVerifyParityChecks>["singleImplementationInterface"][number],
): SimplificationCandidateDraft {
	const path = normalizedRel(cwd, result.file);
	const parsedLine = Number.parseInt(result.message.match(/\(line (\d+)\)/)?.[1] ?? "", 10);
	const line = Number.isFinite(parsedLine) ? parsedLine : null;
	const affected = (result.affectedFiles ?? []).map((file) => normalizedRel(cwd, file));
	return {
		source: "verify.single_implementation_interface",
		remedy: "yagni",
		evidenceState: "heuristic",
		confidence: 0.45,
		path,
		startLine: line,
		endLine: line,
		key: result.message,
		summary: result.message,
		replacement: "Consider a concrete type only after checking public, framework, and test-seam consumers.",
		evidence: [{
			kind: "cross-file-implementor-count",
			state: "heuristic",
			detail: affected.length > 0
				? `Exactly one static implementor was found: ${affected.join(", ")}`
				: "Exactly one static implementor was found.",
			path,
		}],
		estimatedLoc: null,
		relatedPaths: affected,
	};
}

export function collectSingleInterfaceEvidence(
	cwd: string,
	files: string[],
): SimplificationDetectorResult {
	try {
		const results = runVerifyParityChecks(files).singleImplementationInterface;
		const drafts = results.map((result) => singleInterfaceDraft(cwd, result));
		const analyzedPaths = files
			.filter((file) => LOCAL_SIMPLIFICATION_EXTENSIONS.has(extname(file).toLowerCase()))
			.map((file) => normalizedRel(cwd, file))
			.sort((left, right) => left.localeCompare(right));
		return {
			drafts,
			sources: [{
				source: "verify.single_implementation_interface",
				status: "checked",
				files_considered: analyzedPaths.length,
				analyzed_paths: analyzedPaths,
				findings_emitted: drafts.length,
				notes: [
					"One static implementor is an abstraction signal, not proof that an interface is unnecessary.",
				],
			}],
		};
	} catch (error) {
		return unavailableSource("verify.single_implementation_interface", error);
	}
}
