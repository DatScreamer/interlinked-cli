import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { type PerFileCheckCtx, runPerFileChecks } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-pfc-"));
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

function makeAcc(): PerFileCheckCtx {
	return {
		// Fixed far-future start so `Date.now() - postStartMs` stays inside
		// the structure-check time budget without reading the real clock.
		postStartMs: 9_999_999_999_999,
		allCheckResults: [],
		checksRan: [],
		postToolMetrics: [],
		markPhase: () => {},
		projectWideSweepFired: false,
		recurrenceCursor: 0,
	};
}

// runPerFileChecks on a .ts fixture spawns the real tsc (the `typescript`
// quality check); under the CI=1 vitest worker cap a cold start can blow past
// the 10s default test timeout. Match write.test.ts's tsc-spawning-test
// pattern: an explicit generous timeout + retry.
describe("runPerFileChecks", () => {
	it("leaves a clean source file as allow with no findings", { timeout: 60_000, retry: 2 }, async () => {
		const ctx = makeCtx();
		writeFileSync(
			join(tmp, "clean.ts"),
			"export function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
		);
		const event = ev({ tool_name: "Edit", tool_input: { file_path: join(tmp, "clean.ts") } });
		const session = ctx.sessions.recordEvent(event);
		const decision: HarnessDecision = { decision: "allow" };
		const acc = makeAcc();
		await runPerFileChecks(ctx, event, session, join(tmp, "clean.ts"), decision, acc);
		expect(decision.decision).toBe("allow");
	});

	it("records the quality check families in checksRan for a .ts edit", { timeout: 60_000, retry: 2 }, async () => {
		const ctx = makeCtx();
		writeFileSync(join(tmp, "mod.ts"), "export const x = 1;\n");
		const event = ev({ tool_name: "Edit", tool_input: { file_path: join(tmp, "mod.ts") } });
		const session = ctx.sessions.recordEvent(event);
		const decision: HarnessDecision = { decision: "allow" };
		const acc = makeAcc();
		await runPerFileChecks(ctx, event, session, join(tmp, "mod.ts"), decision, acc);
		// The default rule set enables the typescript quality check for .ts.
		expect(acc.checksRan).toContain("typescript");
	});

	it("advances recurrenceCursor to the result count after processing", { timeout: 60_000, retry: 2 }, async () => {
		const ctx = makeCtx();
		writeFileSync(join(tmp, "ok.ts"), "export const y = 2;\n");
		const event = ev({ tool_name: "Edit", tool_input: { file_path: join(tmp, "ok.ts") } });
		const session = ctx.sessions.recordEvent(event);
		const decision: HarnessDecision = { decision: "allow" };
		const acc = makeAcc();
		await runPerFileChecks(ctx, event, session, join(tmp, "ok.ts"), decision, acc);
		expect(acc.recurrenceCursor).toBe(acc.allCheckResults.length);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// PostToolUse → recurrence consolidation source-level pins.
//
// Bug history: the recurrence write was once nested inside the structural-
// results loop AND the `error_memory.enabled` gate, so quality / structure /
// suggestion / behavioral failures were silently dropped, and installs with
// error_memory off recorded nothing. The fix walks `allCheckResults` once via
// a cursor and fires `recordHarnessCaught` for every error/warning regardless
// of source kind or error_memory setting.
//
// This consolidation loop moved here with the per-file check body during the
// server.ts decomposition. The behavioral round-trip lives in
// __tests__/recurrence-consolidation.test.ts.
const FILE_CHECKS_TS = resolve(
	fileURLToPath(new URL(".", import.meta.url)),
	"post-tool-file-checks.ts",
);

describe("recurrence consolidation — source-level pins", () => {
	const src = readFileSync(FILE_CHECKS_TS, "utf-8");

	it("imports recordHarnessCaught from recurrence.js", () => {
		expect(src).toMatch(
			/import\s*\{\s*recordHarnessCaught\s*\}\s*from\s*["']\.\.\/recurrence\.js["']/,
		);
	});

	it("walks allCheckResults via a cursor and fires recordHarnessCaught for every error/warning", () => {
		// The consolidation loop must slice from the accumulator cursor to
		// avoid replaying prior fan-out iterations' findings, filter on
		// severity, and call recordHarnessCaught with the standard fields.
		const consolidationBlock = src.match(
			/for\s*\(\s*let\s+i\s*=\s*acc\.recurrenceCursor[\s\S]*?recordHarnessCaught\(\{[\s\S]*?\}\);[\s\S]*?\}\s*acc\.recurrenceCursor\s*=\s*allCheckResults\.length/,
		);
		expect(consolidationBlock, "cursor-driven consolidation pass missing").toBeTruthy();
		const block = consolidationBlock?.[0] ?? "";
		expect(block).toContain('r.severity !== "error"');
		expect(block).toContain('r.severity !== "warning"');
		expect(block).toContain("check_id: r.name");
		expect(block).toContain("agent_source: event.agent_source");
		expect(block).toContain("session_id: event.session_id");
	});

	it("does NOT nest the recurrence write inside error_memory.enabled", () => {
		// The recurrence consolidation loop must not be syntactically inside
		// the `if (rules.error_memory?.enabled)` block. Extract the block by
		// brace-balancing and assert recordHarnessCaught isn't called in it.
		const idx = src.indexOf("if (rules.error_memory?.enabled)");
		expect(idx, "error_memory block missing").toBeGreaterThan(-1);
		let depth = 0;
		let started = false;
		let end = idx;
		for (let i = idx; i < src.length; i++) {
			const c = src[i];
			if (c === "{") {
				depth++;
				started = true;
			} else if (c === "}") {
				depth--;
				if (started && depth === 0) {
					end = i + 1;
					break;
				}
			}
		}
		expect(src.slice(idx, end)).not.toContain("recordHarnessCaught(");
	});

	it("does NOT scope the recurrence write to a single source kind", () => {
		// Pre-fix code only fired inside `for (const result of structuralResults)`.
		// Pin that the consolidation loop iterates allCheckResults instead, so
		// quality / suggestion / behavioral findings record too.
		const block =
			src.match(
				/Mirror EVERY actionable check failure[\s\S]*?allCheckResults\.length\s*>\s*acc\.recurrenceCursor/,
			) ?? [];
		expect(block.length).toBeGreaterThan(0);
	});
});
