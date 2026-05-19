import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncFindingQueue } from "../async-finding-queue.js";
import { DEFAULT_AUTO_COORDINATION_CONFIG } from "../auto-coordinate.js";
import { CohortManager } from "../cohort.js";
import { ErrorHistory } from "../error-history.js";
import { FileContentCache } from "../grep-accelerator.js";
import { createLearnedRulesStore } from "../learned-rules.js";
import { ProjectGraph } from "../project-graph.js";
import { ProjectWideSweepState } from "../quality-checks.js";
import { ReservationManager } from "../reservations.js";
import { RouteMap } from "../route-map.js";
import { loadRules } from "../rules-loader.js";
import { SessionTracker } from "../session-state.js";
import type { HarnessEvent } from "../types.js";
import { runPreToolPipeline } from "./pre-tool-pipeline.js";
import type { ServerRuntime } from "./runtime-context.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-pre-"));
	writeFileSync(join(tmp, "package.json"), "{}");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		...partial,
	};
}

/** Build a ServerRuntime backed by real managers over a tmp repo. */
function makeCtx(): ServerRuntime {
	const rules = loadRules(tmp);
	return {
		cwd: tmp,
		interlinkedDir: join(tmp, ".interlinked"),
		rules,
		cohort: new CohortManager(),
		sessions: new SessionTracker(),
		reservations: new ReservationManager(),
		errorHistory: new ErrorHistory(join(tmp, ".interlinked"), rules.error_memory),
		routeMap: new RouteMap(tmp),
		serverBridge: null,
		asyncFindings: new AsyncFindingQueue(),
		learnedRules: createLearnedRulesStore(join(tmp, ".interlinked")),
		asyncAnalysis: {
			consume: () => [],
			drain: async () => {},
		} as unknown as ServerRuntime["asyncAnalysis"],
		projectWideSweepState: new ProjectWideSweepState(),
		contentScanner: undefined,
		compiledAllowlist: [],
		classifierSessions: new Map(),
		autoCoordStates: new Map(),
		autoCoordConfig: { ...DEFAULT_AUTO_COORDINATION_CONFIG },
		indexWarningSent: new Set(),
		preEditBaselines: new Map(),
		trigramIndex: null,
		fileContentCache: new FileContentCache(),
		structureGraph: null,
		structureConfigCache: null,
		filePriorityMap: new Map(),
		graphCache: new Map(),
		log: () => {},
		logAlways: () => {},
		writeClassifierStatus: () => {},
		writeReviewPendingMarker: () => {},
	};
}

describe("runPreToolPipeline", () => {
	it("allows a benign Read tool call", async () => {
		const ctx = makeCtx();
		const session = ctx.sessions.recordEvent(
			ev({ tool_name: "Read", tool_input: { file_path: "src/x.ts" } }),
		);
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Read", tool_input: { file_path: "src/x.ts" } }),
			session,
		);
		expect(decision.decision).toBe("allow");
	});

	it("blocks a recursive-delete Bash command", async () => {
		const ctx = makeCtx();
		const session = ctx.sessions.recordEvent(
			ev({ tool_name: "Bash", tool_input: { command: "echo hi" } }),
		);
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
			session,
		);
		expect(decision.decision).toBe("block");
	});

	it("strips internal _escalation / _contentScan fields from the result", async () => {
		const ctx = makeCtx();
		const session = ctx.sessions.recordEvent(
			ev({ tool_name: "Read", tool_input: { file_path: "src/x.ts" } }),
		);
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Read", tool_input: { file_path: "src/x.ts" } }),
			session,
		);
		expect(decision._escalation).toBeUndefined();
		expect(decision._contentScan).toBeUndefined();
	});

	it("drains async-deferred findings into PreToolUse warnings", async () => {
		const ctx = makeCtx();
		// Fixed timestamp — the default staleness window is generous, so a
		// non-stale `computedAt` need not track the real clock here.
		ctx.asyncFindings.enqueue("s", {
			id: "demo_check:src/x.ts",
			check: "demo_check",
			message: "deferred finding text",
			computedAt: "2999-01-01T00:00:00.000Z",
		});
		const session = ctx.sessions.recordEvent(
			ev({ tool_name: "Read", tool_input: { file_path: "src/x.ts" } }),
		);
		const decision = await runPreToolPipeline(
			ctx,
			ev({ tool_name: "Read", tool_input: { file_path: "src/x.ts" } }),
			session,
		);
		expect(decision.warnings ?? []).toContain("deferred finding text");
	});
});
