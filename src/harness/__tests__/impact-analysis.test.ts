// ===========================================
// Impact Analysis — Unit Tests
// ===========================================

import { describe, expect, it, vi } from "vitest";

import {
	checkFollowUpViolation,
	formatImpactWarning,
	recordImpactFollowUps,
	runImpactAnalysis,
} from "../impact-analysis.js";
import type {
	ExportedSymbol,
	ImpactAnalysisResult,
	ModuleRole,
	SessionTrajectory,
	StructuralCheckResult,
} from "../types.js";

// -------------------------------------------
// Helpers
// -------------------------------------------

// Deterministic fixtures.
const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

function makeSession(overrides?: Partial<SessionTrajectory>): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 10,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: FIXED_NOW,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		...overrides,
	};
}

function makeGraph(opts: {
	dependents?: string[];
	moduleRole?: ModuleRole;
	toRelative?: (f: string) => string;
}) {
	return {
		getDependents: vi.fn().mockReturnValue(opts.dependents || []),
		classifyModule: vi.fn().mockReturnValue(opts.moduleRole || "leaf"),
		getExports: vi.fn().mockReturnValue([]),
		toRelative: opts.toRelative || ((f: string) => f.replace(/^\/project\//, "")),
		isInitialized: true,
	} as any;
}

function makeExports(...names: string[]): ExportedSymbol[] {
	return names.map((name) => ({
		name,
		kind: "function" as const,
		isTypeOnly: false,
		line: 1,
	}));
}

// -------------------------------------------
// Severity classification
// -------------------------------------------

describe("runImpactAnalysis — severity", () => {
	const config = { highThreshold: 4 };

	it("classifies leaf file with no export change as low", () => {
		const graph = makeGraph({ dependents: [], moduleRole: "leaf" });
		const exports = makeExports("foo", "bar");

		const result = runImpactAnalysis(
			"/project/src/leaf.ts",
			graph,
			exports,
			exports,
			[],
			config,
		);

		expect(result.severity).toBe("low");
		expect(result.exportSurfaceChanged).toBe(false);
		expect(result.dependentCount).toBe(0);
	});

	it("classifies internal file with dependents but no export change as low", () => {
		const graph = makeGraph({
			dependents: ["/project/src/a.ts", "/project/src/b.ts"],
			moduleRole: "internal",
		});
		const exports = makeExports("foo");

		const result = runImpactAnalysis(
			"/project/src/utils.ts",
			graph,
			exports,
			exports,
			[],
			config,
		);

		expect(result.severity).toBe("low");
	});

	it("classifies file with 2 dependents and removed export as medium", () => {
		const graph = makeGraph({
			dependents: ["/project/src/a.ts", "/project/src/b.ts"],
			moduleRole: "internal",
		});
		const oldExports = makeExports("foo", "bar");
		const newExports = makeExports("foo");
		const structural: StructuralCheckResult[] = [
			{
				check: "export_surface",
				severity: "warning",
				message: "Removed export: bar",
				file: "/project/src/utils.ts",
				affectedFiles: ["/project/src/a.ts"],
			},
		];

		const result = runImpactAnalysis(
			"/project/src/utils.ts",
			graph,
			oldExports,
			newExports,
			structural,
			config,
		);

		expect(result.severity).toBe("medium");
		expect(result.breakingFiles).toEqual(["/project/src/a.ts"]);
	});

	it("classifies file with 5+ dependents and export change as high", () => {
		const deps = Array.from({ length: 5 }, (_, i) => `/project/src/dep${i}.ts`);
		const graph = makeGraph({ dependents: deps, moduleRole: "internal" });
		const oldExports = makeExports("foo", "bar");
		const newExports = makeExports("foo");

		const result = runImpactAnalysis(
			"/project/src/core.ts",
			graph,
			oldExports,
			newExports,
			[],
			config,
		);

		expect(result.severity).toBe("high");
	});

	it("classifies hub module with breaking changes as critical", () => {
		const deps = Array.from({ length: 10 }, (_, i) => `/project/src/dep${i}.ts`);
		const graph = makeGraph({ dependents: deps, moduleRole: "hub" });
		const structural: StructuralCheckResult[] = [
			{
				check: "export_surface",
				severity: "error",
				message: "Removed export: doStuff",
				file: "/project/src/hub.ts",
				affectedFiles: ["/project/src/a.ts", "/project/src/b.ts"],
			},
		];

		const result = runImpactAnalysis(
			"/project/src/hub.ts",
			graph,
			makeExports("doStuff"),
			makeExports(),
			structural,
			config,
		);

		expect(result.severity).toBe("critical");
		expect(result.dependentCount).toBe(10);
	});
});

// -------------------------------------------
// Follow-up tracking
// -------------------------------------------

describe("recordImpactFollowUps", () => {
	it("creates pending completions for follow-up files", () => {
		const session = makeSession();
		const result: ImpactAnalysisResult = {
			file: "/project/src/utils.ts",
			severity: "medium",
			moduleRole: "internal",
			dependentCount: 2,
			breakingFiles: ["/project/src/a.ts"],
			testFiles: [],
			followUpFiles: ["/project/src/a.ts", "/project/src/b.ts"],
			exportSurfaceChanged: true,
			summary: "MEDIUM: utils.ts export surface changed.",
		};

		recordImpactFollowUps(result, session);

		expect(session.pending_completions.has("/project/src/utils.ts")).toBe(true);
		const completion = session.pending_completions.get("/project/src/utils.ts")!;
		expect(completion.affected_files).toEqual(["/project/src/a.ts", "/project/src/b.ts"]);
		expect(completion.resolved_files.size).toBe(0);
	});

	it("merges with existing completion for same source file", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: ["/project/src/a.ts"],
			resolved_files: new Set(),
			recorded_at_tool_call: 5,
			description: "old description",
		});

		const result: ImpactAnalysisResult = {
			file: "/project/src/utils.ts",
			severity: "medium",
			moduleRole: "internal",
			dependentCount: 2,
			breakingFiles: [],
			testFiles: [],
			followUpFiles: ["/project/src/a.ts", "/project/src/c.ts"],
			exportSurfaceChanged: true,
			summary: "MEDIUM: new description",
		};

		recordImpactFollowUps(result, session);

		const completion = session.pending_completions.get("/project/src/utils.ts")!;
		expect(completion.affected_files).toContain("/project/src/a.ts");
		expect(completion.affected_files).toContain("/project/src/c.ts");
		expect(completion.description).toBe("MEDIUM: new description");
	});

	it("does nothing when no follow-up files", () => {
		const session = makeSession();
		const result: ImpactAnalysisResult = {
			file: "/project/src/leaf.ts",
			severity: "low",
			moduleRole: "leaf",
			dependentCount: 0,
			breakingFiles: [],
			testFiles: [],
			followUpFiles: [],
			exportSurfaceChanged: false,
			summary: "LOW: no impact.",
		};

		recordImpactFollowUps(result, session);
		expect(session.pending_completions.size).toBe(0);
	});
});

// -------------------------------------------
// Follow-up violation check
// -------------------------------------------

describe("checkFollowUpViolation", () => {
	it("returns null when no pending completions", () => {
		const session = makeSession();
		expect(checkFollowUpViolation("/project/src/other.ts", session)).toBeNull();
	});

	it("returns null when writing to an affected file", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: ["/project/src/a.ts", "/project/src/b.ts"],
			resolved_files: new Set(),
			recorded_at_tool_call: 5,
			description: "Export changed",
		});

		expect(checkFollowUpViolation("/project/src/a.ts", session)).toBeNull();
	});

	it("returns null when writing to the source file itself", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: ["/project/src/a.ts"],
			resolved_files: new Set(),
			recorded_at_tool_call: 5,
			description: "Export changed",
		});

		expect(checkFollowUpViolation("/project/src/utils.ts", session)).toBeNull();
	});

	it("returns warning when writing to unrelated file", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: ["/project/src/a.ts", "/project/src/b.ts"],
			resolved_files: new Set(),
			recorded_at_tool_call: 5,
			description: "Export changed",
		});

		const result = checkFollowUpViolation("/project/src/unrelated.ts", session);
		expect(result).not.toBeNull();
		expect(result).toContain("Unresolved follow-ups");
		expect(result).toContain("/project/src/utils.ts");
	});

	it("returns null when all affected files are resolved", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: ["/project/src/a.ts"],
			resolved_files: new Set(["/project/src/a.ts"]),
			recorded_at_tool_call: 5,
			description: "Export changed",
		});

		expect(checkFollowUpViolation("/project/src/other.ts", session)).toBeNull();
	});
});

// -------------------------------------------
// Warning formatting
// -------------------------------------------

describe("formatImpactWarning", () => {
	const graph = makeGraph({});

	it("returns empty array for low severity", () => {
		const result: ImpactAnalysisResult = {
			file: "/project/src/leaf.ts",
			severity: "low",
			moduleRole: "leaf",
			dependentCount: 0,
			breakingFiles: [],
			testFiles: [],
			followUpFiles: [],
			exportSurfaceChanged: false,
			summary: "LOW: leaf file.",
		};

		expect(formatImpactWarning(result, graph)).toHaveLength(0);
	});

	it("returns single warning for medium severity", () => {
		const result: ImpactAnalysisResult = {
			file: "/project/src/utils.ts",
			severity: "medium",
			moduleRole: "internal",
			dependentCount: 2,
			breakingFiles: ["/project/src/a.ts"],
			testFiles: ["src/utils.test.ts"],
			followUpFiles: ["/project/src/a.ts"],
			exportSurfaceChanged: true,
			summary: "MEDIUM: utils.ts export surface changed.",
		};

		const warnings = formatImpactWarning(result, graph);
		expect(warnings.length).toBeGreaterThanOrEqual(1);
		expect(warnings[0]).toContain("[interlinked:impact_analysis]");
		expect(warnings[0]).toContain("MEDIUM");
	});

	it("returns multi-line warnings for critical severity", () => {
		const result: ImpactAnalysisResult = {
			file: "/project/src/hub.ts",
			severity: "critical",
			moduleRole: "hub",
			dependentCount: 10,
			breakingFiles: ["/project/src/a.ts", "/project/src/b.ts"],
			testFiles: ["src/hub.test.ts"],
			followUpFiles: ["/project/src/a.ts", "/project/src/b.ts"],
			exportSurfaceChanged: true,
			summary: "CRITICAL: hub.ts is a hub module with 10 dependents.",
		};

		const warnings = formatImpactWarning(result, graph);
		expect(warnings.length).toBeGreaterThanOrEqual(3);
		expect(warnings.some((w) => w.includes("Breaking imports"))).toBe(true);
		expect(warnings.some((w) => w.includes("Test files"))).toBe(true);
	});
});
