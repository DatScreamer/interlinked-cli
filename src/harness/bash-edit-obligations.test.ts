import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	evaluateBashEditObligationGate,
	openBashEditObligations,
	recordBashEditObligations,
	resetBashEditObligationsForTesting,
} from "./bash-edit-obligations.js";
import type { HarnessEvent } from "./types.js";

let cwd = "";

// A pre_block-class finding the registry always carries: eval() injection.
const BAD_LINE = `eval(userInput);\n`;
const CLEAN = `export const ok = 1;\n`;

function writeSrc(rel: string, content: string): string {
	const abs = join(cwd, rel);
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(abs, content);
	return abs;
}

function editEvent(toolName: string, filePath?: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		tool_name: toolName,
		tool_input: filePath ? { file_path: filePath } : {},
		timestamp: "2026-08-25T00:00:00.000Z",
		cwd,
	} as HarnessEvent;
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "bash-obligation-"));
	resetBashEditObligationsForTesting();
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("recordBashEditObligations — positive (must open)", () => {
	it("P1: a bash-edited file whose post-state carries a pre_block finding opens an obligation and returns a warning", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		const warning = recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		expect(warning).toContain("[interlinked:bash-edit-obligation]");
		expect(openBashEditObligations(cwd).length).toBe(1);
	});

	it("P2: the obligation survives an in-memory reset via the JSON store (daemon restart shape)", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		resetBashEditObligationsForTesting();
		expect(openBashEditObligations(cwd).length).toBe(1);
	});
});

describe("recordBashEditObligations — negative (must stay silent)", () => {
	it("N1: a clean bash-edited file opens nothing", () => {
		const abs = writeSrc("src/a.ts", CLEAN);
		expect(recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false })).toBeNull();
		expect(openBashEditObligations(cwd).length).toBe(0);
	});

	it("N2: dry_run records nothing", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: true });
		expect(openBashEditObligations(cwd).length).toBe(0);
	});
});

describe("evaluateBashEditObligationGate", () => {
	it("P1: blocks a Write to an UNRELATED file while an obligation is open", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		const decision = evaluateBashEditObligationGate(editEvent("Write", join(cwd, "src/other.ts")), "Write", []);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("src/a.ts");
	});

	it("N1: an edit targeting the OBLIGATED file is allowed (that is the fix path)", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		expect(evaluateBashEditObligationGate(editEvent("Edit", abs), "Edit", [])).toBeNull();
	});

	it("N2: read-class tools are always allowed", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		expect(evaluateBashEditObligationGate(editEvent("Read", abs), "Read", [])).toBeNull();
		expect(evaluateBashEditObligationGate(editEvent("Grep"), "Grep", [])).toBeNull();
	});

	it("N3: the gate self-discharges once the finding is fixed on disk", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		writeFileSync(abs, CLEAN);
		expect(evaluateBashEditObligationGate(editEvent("Write", join(cwd, "src/other.ts")), "Write", [])).toBeNull();
		expect(openBashEditObligations(cwd).length).toBe(0);
	});

	it("N4: no obligations → null fast path", () => {
		expect(evaluateBashEditObligationGate(editEvent("Write", join(cwd, "src/x.ts")), "Write", [])).toBeNull();
	});
});

describe("store hygiene", () => {
	it("the JSON store lives under .interlinked and is valid JSON", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		const raw = readFileSync(join(cwd, ".interlinked", "bash-edit-obligations.json"), "utf-8");
		expect(() => JSON.parse(raw)).not.toThrow();
	});
});
