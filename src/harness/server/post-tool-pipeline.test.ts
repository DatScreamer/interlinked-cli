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
import { ProjectWideSweepState } from "../quality-checks.js";
import { ReservationManager } from "../reservations.js";
import { RouteMap } from "../route-map.js";
import { loadRules } from "../rules-loader.js";
import { SessionTracker } from "../session-state.js";
import type { HarnessEvent } from "../types.js";
import { runPostToolPipeline } from "./post-tool-pipeline.js";
import type { ServerRuntime } from "./runtime-context.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-post-"));
	writeFileSync(join(tmp, "package.json"), "{}");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		...partial,
	};
}

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

describe("runPostToolPipeline", () => {
	it("short-circuits with an allow + summary for a skip_paths match", async () => {
		const ctx = makeCtx();
		// dist/** is a default skip path.
		const event = ev({
			tool_name: "Write",
			tool_input: { file_path: "dist/bundle.js" },
		});
		const session = ctx.sessions.recordEvent(event);
		const decision = await runPostToolPipeline(ctx, event, session);
		expect(decision.decision).toBe("allow");
		expect(decision.summary).toMatch(/skip_paths matched/);
	});

	it("allows a non-file-edit tool call with no checks", async () => {
		const ctx = makeCtx();
		const event = ev({ tool_name: "Read", tool_input: { file_path: "src/x.ts" } });
		const session = ctx.sessions.recordEvent(event);
		const decision = await runPostToolPipeline(ctx, event, session);
		expect(decision.decision).toBe("allow");
	});

	it("returns an allow for a benign edit to a clean source file", async () => {
		const ctx = makeCtx();
		writeFileSync(
			join(tmp, "clean.ts"),
			"export function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
		);
		const event = ev({
			tool_name: "Edit",
			tool_input: { file_path: join(tmp, "clean.ts") },
		});
		const session = ctx.sessions.recordEvent(event);
		const decision = await runPostToolPipeline(ctx, event, session);
		// A clean file produces no blocking finding.
		expect(decision.decision).toBe("allow");
	});
});
