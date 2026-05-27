// ===========================================
// interlinked plan — CLI subcommand regression suite
// ===========================================
//
// Pins the read commands:
//   - `interlinked plan list` with no captured plans → empty-list message,
//     exit 0
//   - `interlinked plan show <missing>` → clean "not found" message, exit 1
//   - `interlinked plan show <found>` returns the most-recent line
//   - `interlinked plan list` sorts by created_at_iso descending
//
// Tests point --cwd at a tmp dir and seed the JSONL fixture directly so we
// exercise the read path without spinning up the harness daemon.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planListCommand, planShowCommand } from "../plan.js";
import type { CapturedPlan } from "../../harness/types/plan.js";

let tmp = "";
let previousExitCode: number | string | undefined;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-plan-cli-"));
	previousExitCode = process.exitCode;
	process.exitCode = 0;
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	process.exitCode = previousExitCode;
});

interface CapturedStdio {
	stdout: string;
	stderr: string;
}

async function captureStdio(fn: () => Promise<void>): Promise<CapturedStdio> {
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	const realStdoutWrite = process.stdout.write.bind(process.stdout);
	const realStderrWrite = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdoutChunks.push(
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
		);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderrChunks.push(
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
		);
		return true;
	}) as typeof process.stderr.write;
	try {
		await fn();
	} finally {
		process.stdout.write = realStdoutWrite;
		process.stderr.write = realStderrWrite;
	}
	return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

function plansDir(): string {
	return join(tmp, ".interlinked", "plans");
}

function seedPlanFile(sessionId: string, plans: CapturedPlan[]): void {
	mkdirSync(plansDir(), { recursive: true });
	const path = join(plansDir(), `${sessionId}.jsonl`);
	const lines = plans.map((p) => JSON.stringify(p)).join("\n");
	writeFileSync(path, `${lines}\n`, "utf-8");
}

function plan(overrides: Partial<CapturedPlan>): CapturedPlan {
	return {
		session_id: overrides.session_id ?? "sess-1",
		agent_name: overrides.agent_name ?? "agent-a",
		created_at_iso: overrides.created_at_iso ?? "2026-04-23T00:00:00.000Z",
		created_at_step: overrides.created_at_step ?? 0,
		source: overrides.source ?? "TaskCreate",
		steps:
			overrides.steps ??
			[
				{ intent: "step one", status: "pending" },
				{ intent: "step two", status: "pending" },
			],
	};
}

describe("interlinked plan list", () => {
	it("prints an empty-list message and exits 0 when no plans captured", async () => {
		const captured = await captureStdio(() => planListCommand({ cwd: tmp }));
		expect(captured.stdout).toContain("no captured plans");
		expect(captured.stderr).toBe("");
		expect(process.exitCode).toBe(0);
	});

	it("returns empty array via --json when no plans captured", async () => {
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		expect(captured.stdout.trim()).toBe("[]");
		expect(process.exitCode).toBe(0);
	});

	it("returns the newest plans first (sorted by created_at_iso desc)", async () => {
		seedPlanFile("sess-a", [
			plan({
				session_id: "sess-a",
				created_at_iso: "2026-04-20T00:00:00.000Z",
			}),
		]);
		seedPlanFile("sess-b", [
			plan({
				session_id: "sess-b",
				created_at_iso: "2026-04-22T00:00:00.000Z",
			}),
		]);
		seedPlanFile("sess-c", [
			plan({
				session_id: "sess-c",
				created_at_iso: "2026-04-21T00:00:00.000Z",
			}),
		]);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = JSON.parse(captured.stdout) as CapturedPlan[];
		expect(rows.map((r) => r.session_id)).toEqual(["sess-b", "sess-c", "sess-a"]);
	});

	it("returns the LAST line in a file when multiple plans (replanning)", async () => {
		seedPlanFile("sess-r", [
			plan({ session_id: "sess-r", created_at_iso: "2026-04-20T00:00:00.000Z" }),
			plan({
				session_id: "sess-r",
				created_at_iso: "2026-04-21T00:00:00.000Z",
				steps: [
					{ intent: "newer step a", status: "pending" },
					{ intent: "newer step b", status: "pending" },
					{ intent: "newer step c", status: "pending" },
				],
			}),
		]);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = JSON.parse(captured.stdout) as CapturedPlan[];
		expect(rows).toHaveLength(1);
		expect(rows[0].created_at_iso).toBe("2026-04-21T00:00:00.000Z");
		expect(rows[0].steps).toHaveLength(3);
	});

	it("skips torn / malformed JSONL lines without crashing", async () => {
		const path = join(plansDir(), "sess-broken.jsonl");
		mkdirSync(plansDir(), { recursive: true });
		writeFileSync(
			path,
			`${JSON.stringify(plan({ session_id: "sess-broken" }))}\nnot-json-at-all\n`,
			"utf-8",
		);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = JSON.parse(captured.stdout) as CapturedPlan[];
		expect(rows).toHaveLength(1);
		expect(rows[0].session_id).toBe("sess-broken");
	});
});

describe("interlinked plan show", () => {
	it("emits a clean not-found message and non-zero exit when session is missing", async () => {
		const captured = await captureStdio(() => planShowCommand("missing-sess", { cwd: tmp }));
		expect(captured.stderr).toContain("No plan captured");
		expect(captured.stderr).toContain("missing-sess");
		expect(process.exitCode).toBe(1);
	});

	it("emits machine-readable not-found via --json", async () => {
		const captured = await captureStdio(() =>
			planShowCommand("missing-sess", { cwd: tmp, json: true }),
		);
		const parsed = JSON.parse(captured.stdout) as { ok: boolean; session_id: string };
		expect(parsed.ok).toBe(false);
		expect(parsed.session_id).toBe("missing-sess");
		expect(process.exitCode).toBe(1);
	});

	it("prints the most-recent captured plan for a known session", async () => {
		seedPlanFile("sess-x", [
			plan({
				session_id: "sess-x",
				agent_name: "agent-claude",
				created_at_iso: "2026-04-22T00:00:00.000Z",
				steps: [
					{ intent: "first step", status: "pending" },
					{ intent: "second step", tool_hint: "Edit", target_hint: "src/foo.ts", status: "pending" },
				],
			}),
		]);
		const captured = await captureStdio(() => planShowCommand("sess-x", { cwd: tmp }));
		expect(captured.stdout).toContain("sess-x");
		expect(captured.stdout).toContain("agent-claude");
		expect(captured.stdout).toContain("first step");
		expect(captured.stdout).toContain("second step");
		expect(captured.stdout).toContain("tool=Edit");
		expect(captured.stdout).toContain("target=src/foo.ts");
		expect(process.exitCode).toBe(0);
	});

	it("rejects a missing session_id argument with usage", async () => {
		const captured = await captureStdio(() => planShowCommand(undefined, { cwd: tmp }));
		expect(captured.stderr).toContain("session_id");
		expect(captured.stderr).toContain("Usage:");
		expect(process.exitCode).toBe(2);
	});
});
