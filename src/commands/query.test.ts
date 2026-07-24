import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type QueryParams, queryCommand, runQuery } from "./query.js";

let dir: string;
let logs: string[];
let errors: string[];

function baseParams(overrides: Partial<QueryParams> = {}): QueryParams {
	return {
		clauses: [],
		budget: { maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 },
		limit: 20,
		...overrides,
	};
}

function writeFixtures(root: string): string {
	const dataDir = join(root, ".interlinked");
	mkdirSync(dataDir, { recursive: true });
	const activity = [
		{ ts: "2026-07-24T10:00:00Z", type: "tool_use", tool: "Bash", summary: "ls" },
		{
			ts: "2026-07-24T10:01:00Z",
			type: "guard_block",
			tool: "Bash",
			guard_rule_id: "builtin-rm-rf",
			summary: "rm -rf blocked",
		},
		{
			ts: "2026-07-24T10:02:00Z",
			type: "guard_warn",
			tool: "Write",
			guard_rule_id: "w1",
			summary: "warned",
		},
		{
			ts: "2026-07-24T10:03:00Z",
			type: "guard_block",
			tool: "Write",
			guard_rule_id: "builtin-protected",
			summary: "protected file",
		},
	];
	writeFileSync(
		join(dataDir, "activity.jsonl"),
		`${activity.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	const checks = [
		{ ts: "2026-07-24T09:00:00Z", checks: [{ id: "a" }, { id: "b" }] },
		{ ts: "2026-07-24T09:01:00Z", checks: [{ id: "a" }] },
	];
	writeFileSync(
		join(dataDir, "check-results.jsonl"),
		`${checks.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	const costs = [
		{ ts: "2026-07-24T08:00:00Z", session_id: "s1", output_tokens: 100 },
		{ ts: "2026-07-24T08:01:00Z", session_id: "s2", output_tokens: 900 },
		{ ts: "2026-07-24T08:02:00Z", session_id: "s1", output_tokens: 50 },
	];
	writeFileSync(
		join(dataDir, "costs.jsonl"),
		`${costs.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	return dataDir;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "il-query-cmd-"));
	writeFixtures(dir);
	logs = [];
	errors = [];
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
	process.exitCode = 0;
});

describe("runQuery", () => {
	it("filters rows and returns them in chronological order", () => {
		const result = runQuery(join(dir, ".interlinked", "activity.jsonl"), {
			...baseParams(),
			clauses: [{ path: "type", op: "=", value: "guard_block" }],
		});
		expect(result.rows.map((r) => r.guard_rule_id)).toEqual([
			"builtin-rm-rf",
			"builtin-protected",
		]);
		expect(result.stats.truncated).toBe(false);
	});

	it("aggregates with --by across array fan-out", () => {
		const result = runQuery(join(dir, ".interlinked", "check-results.jsonl"), {
			...baseParams({ by: "checks.id" }),
		});
		expect(result.aggregate).toEqual([
			{ key: "a", count: 2 },
			{ key: "b", count: 1 },
		]);
	});

	it("sums with --by --sum", () => {
		const result = runQuery(join(dir, ".interlinked", "costs.jsonl"), {
			...baseParams({ by: "session_id", sum: "output_tokens" }),
		});
		expect(result.aggregate).toEqual([
			{ key: "s2", count: 1, sum: 900 },
			{ key: "s1", count: 2, sum: 150 },
		]);
	});

	it("stops scanning at the --since bound", () => {
		const result = runQuery(join(dir, ".interlinked", "activity.jsonl"), {
			...baseParams({ sinceMs: Date.parse("2026-07-24T10:02:00Z") }),
		});
		expect(result.rows.map((r) => r.ts)).toEqual([
			"2026-07-24T10:02:00Z",
			"2026-07-24T10:03:00Z",
		]);
		expect(result.sinceStopped).toBe(true);
	});

	it("stops early once --limit rows match", () => {
		const result = runQuery(join(dir, ".interlinked", "activity.jsonl"), {
			...baseParams({ limit: 1 }),
			clauses: [{ path: "type", op: "=", value: "guard_block" }],
		});
		expect(result.rows.map((r) => r.guard_rule_id)).toEqual(["builtin-protected"]);
		expect(result.limitStopped).toBe(true);
	});
});

describe("queryCommand", () => {
	it("prints the source catalog when no target is given", async () => {
		await queryCommand(undefined, { cwd: dir });
		const joined = logs.join("\n");
		expect(joined).toContain("blocks");
		expect(joined).toContain("Examples");
	});

	it("errors with the known-source list on an unknown source", async () => {
		await queryCommand("nonsense", { cwd: dir });
		expect(errors.join("\n")).toContain('Unknown source "nonsense"');
		expect(process.exitCode).toBe(1);
	});

	it("errors helpfully when the source log does not exist", async () => {
		await queryCommand("recurrences", { cwd: dir });
		expect(errors.join("\n")).toContain("No recurrences log");
		expect(process.exitCode).toBe(1);
	});

	it("rejects --sum without --by", async () => {
		await queryCommand("costs", { cwd: dir, sum: "output_tokens" });
		expect(errors.join("\n")).toContain("--sum requires --by");
		expect(process.exitCode).toBe(1);
	});

	it("emits a JSON envelope with rows and scan stats", async () => {
		await queryCommand("blocks", { cwd: dir, json: true });
		const payload = JSON.parse(logs.join("\n")) as {
			source: string;
			rows: Array<{ guard_rule_id: string }>;
			stats: { recordsParsed: number };
		};
		expect(payload.source).toBe("blocks");
		expect(payload.rows).toHaveLength(2);
		expect(payload.stats.recordsParsed).toBe(4);
	});

	it("emits an aggregate envelope under --by", async () => {
		await queryCommand("costs", { cwd: dir, json: true, by: "session_id", sum: "output_tokens" });
		const payload = JSON.parse(logs.join("\n")) as {
			by: string;
			aggregate: Array<{ key: string; sum: number }>;
		};
		expect(payload.by).toBe("session_id");
		expect(payload.aggregate[0]).toEqual({ key: "s2", count: 1, sum: 900 });
	});

	it("renders rows plus an honest scan footer in normal mode", async () => {
		await queryCommand("blocks", { cwd: dir });
		const joined = logs.join("\n");
		expect(joined).toContain("builtin-rm-rf");
		expect(joined).toContain("scanned all");
	});

	it("applies user --where on top of the source identity filter", async () => {
		await queryCommand("blocks", { cwd: dir, json: true, where: ["tool=Write"] });
		const payload = JSON.parse(logs.join("\n")) as { rows: Array<{ guard_rule_id: string }> };
		expect(payload.rows.map((r) => r.guard_rule_id)).toEqual(["builtin-protected"]);
	});

	it("queries an explicit .jsonl path with inferred fields", async () => {
		await queryCommand(join(dir, ".interlinked", "costs.jsonl"), { cwd: dir, json: true });
		const payload = JSON.parse(logs.join("\n")) as { rows: unknown[] };
		expect(payload.rows).toHaveLength(3);
	});

	it("rejects an invalid --limit", async () => {
		await queryCommand("blocks", { cwd: dir, limit: "zero" });
		expect(errors.join("\n")).toContain("Invalid --limit");
		expect(process.exitCode).toBe(1);
	});
});
