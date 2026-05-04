import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CohortManager } from "../../cohort.js";
import { ReservationManager } from "../../reservations.js";
import { getDefaultConfig } from "../../rules-loader.js";
import type { HarnessEvent } from "../../types.js";
import { evaluatePostToolUse } from "../post-tool.js";

const FIXED_TIMESTAMP = "2026-04-01T00:00:00.000Z";

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "t",
		agent_source: "claude",
		agent_name: "test-agent",
		tool_name: "Bash",
		tool_input: { command: "ls -la" },
		timestamp: FIXED_TIMESTAMP,
		...overrides,
	};
}

function makeWriteEvent(filePath: string): HarnessEvent {
	return makeEvent({
		tool_name: "Write",
		tool_input: { file_path: filePath, content: "<unused>" },
	});
}

function runPostTool(event: HarnessEvent) {
	return evaluatePostToolUse(
		event,
		getDefaultConfig(),
		undefined,
		new ReservationManager(),
		new CohortManager(),
	);
}

describe("evaluatePostToolUse smoke", () => {
	it("always returns allow", () => {
		const result = evaluatePostToolUse(
			makeEvent(),
			getDefaultConfig(),
			undefined,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
	});

	it("emits a tool-miss warning for rg-not-installed output", () => {
		const result = evaluatePostToolUse(
			makeEvent({
				tool_input: { command: "rg foo" },
				tool_response: "bash: command not found: rg",
			}),
			getDefaultConfig(),
			undefined,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
		expect(result.warnings?.some((w) => w.includes("[interlinked:tool-miss]"))).toBe(true);
	});
});

describe("suppression-justification check", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-suppr-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function fixture(content: string): string {
		const p = join(dir, "fixture.ts");
		writeFileSync(p, content);
		return p;
	}

	it("emits the loud unjustified warning when bare @ts-ignore is present", () => {
		const p = fixture(["// @ts-ignore", "const x: number = 'oops';", ""].join("\n"));
		const result = runPostTool(makeWriteEvent(p));
		const ws = result.warnings ?? [];
		expect(ws.some((w) => w.includes("[interlinked:suppressions-unjustified]"))).toBe(true);
		expect(ws.some((w) => w.includes("[interlinked:suppressions]"))).toBe(false);
	});

	it("recognizes a justified @ts-ignore (text after directive)", () => {
		const p = fixture(["// @ts-ignore upstream types are wrong, see issue 42", "const x = 1;"].join("\n"));
		const result = runPostTool(makeWriteEvent(p));
		const ws = result.warnings ?? [];
		expect(ws.some((w) => w.includes("[interlinked:suppressions-unjustified]"))).toBe(false);
		expect(ws.some((w) => w.includes("[interlinked:suppressions]"))).toBe(true);
	});

	it("requires the `--` separator for eslint-disable justification (ESLint 7+ convention)", () => {
		const p = fixture(
			[
				"// eslint-disable-next-line no-console",
				"console.log('unjustified — has rule but no -- separator');",
				"// eslint-disable-next-line no-console -- intentional debug log",
				"console.log('justified');",
			].join("\n"),
		);
		const result = runPostTool(makeWriteEvent(p));
		const loud = (result.warnings ?? []).find((w) => w.includes("[interlinked:suppressions-unjustified]"));
		expect(loud).toBeDefined();
		expect(loud).toContain("eslint-disable");
		expect(loud).toMatch(/lines:\s*1/);
	});

	it("requires `:` after the rule for biome-ignore justification", () => {
		const p = fixture(
			[
				"// biome-ignore lint/suspicious/noExplicitAny",
				"const x: any = 1;",
				"// biome-ignore lint/suspicious/noExplicitAny: needed for legacy adapter",
				"const y: any = 2;",
			].join("\n"),
		);
		const result = runPostTool(makeWriteEvent(p));
		const loud = (result.warnings ?? []).find((w) => w.includes("[interlinked:suppressions-unjustified]"));
		expect(loud).toBeDefined();
		expect(loud).toContain("biome-ignore");
	});

	it("@ts-nocheck is exempt (file-level, no per-line justification convention)", () => {
		const p = fixture(["// @ts-nocheck", "const x = 1;"].join("\n"));
		const result = runPostTool(makeWriteEvent(p));
		const ws = result.warnings ?? [];
		expect(ws.some((w) => w.includes("[interlinked:suppressions-unjustified]"))).toBe(false);
	});

	it("emits no suppression warning when the file is clean", () => {
		const p = fixture(["export const x = 1;", ""].join("\n"));
		const result = runPostTool(makeWriteEvent(p));
		const ws = result.warnings ?? [];
		expect(ws.some((w) => w.includes("suppressions"))).toBe(false);
	});

	it("loud warning lists line numbers and offers the three justification syntaxes", () => {
		const p = fixture(
			[
				"// @ts-ignore",
				"const a = 1;",
				"// @ts-ignore",
				"const b = 2;",
				"const c = 3;",
				"// @ts-ignore",
				"const d = 4;",
			].join("\n"),
		);
		const result = runPostTool(makeWriteEvent(p));
		const loud = (result.warnings ?? []).find((w) => w.includes("[interlinked:suppressions-unjustified]"));
		expect(loud).toBeDefined();
		expect(loud).toContain("3x @ts-ignore");
		expect(loud).toMatch(/lines:\s*1,\s*3,\s*6/);
		expect(loud).toContain("// @ts-ignore: <reason>");
		expect(loud).toContain("// eslint-disable-next-line <rule> -- <reason>");
		expect(loud).toContain("// biome-ignore lint/<rule>: <reason>");
	});
});
