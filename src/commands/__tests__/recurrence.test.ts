// Tests for the `interlinked recurrence` CLI subcommands.
//
// Each command is exported as a plain async function that accepts an
// options object — same convention as activity / checkpoint / etc.
// Output is captured by spying on console.log; the assertions check the
// shape of what the user (or an agent) sees.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	recordHarnessCaught,
	recordRecurrenceEvent,
	loadRecurrenceEvents,
} from "../../harness/recurrence.js";
import {
	recurrenceDetailCommand,
	recurrenceFlagCommand,
	recurrenceListCommand,
	recurrenceProposeCommand,
	recurrenceScanCommand,
} from "../recurrence.js";

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "interlinked-rec-cli-"));
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	logSpy.mockRestore();
	errSpy.mockRestore();
});

function captured(): string {
	return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

function seedThreeCaughtEvents(): void {
	for (let i = 0; i < 3; i++) {
		recordHarnessCaught({
			check_id: "misused_promises",
			agent_source: "claude",
			session_id: `s${i}`,
			file: `src/foo${i}.ts`,
			cwd: dir,
		});
	}
}

describe("recurrence list", () => {
	it("prints '(no recurrences yet)' when the log is empty", async () => {
		await recurrenceListCommand({ cwd: dir });
		expect(captured()).toMatch(/no recurrences/i);
	});

	it("prints a table row including count, kind, and check_id when events exist", async () => {
		seedThreeCaughtEvents();
		await recurrenceListCommand({ cwd: dir });
		const out = captured();
		expect(out).toContain("misused_promises");
		expect(out).toContain("harness_caught");
		expect(out).toContain("3");
	});

	it("emits structured JSON when --json is set", async () => {
		seedThreeCaughtEvents();
		await recurrenceListCommand({ cwd: dir, json: true });
		const out = captured();
		const parsed = JSON.parse(out) as Array<{ count: number; kind: string }>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0].count).toBe(3);
		expect(parsed[0].kind).toBe("harness_caught");
	});

	it("filters by --kind", async () => {
		seedThreeCaughtEvents();
		recordRecurrenceEvent(
			{ ts: "2026-05-04T00:00:00.000Z", kind: "codebase_existing", check_id: "no_test_file", file: "src/x.ts" },
			dir,
		);
		await recurrenceListCommand({ cwd: dir, kind: "codebase_existing", json: true });
		const parsed = JSON.parse(captured()) as Array<{ kind: string }>;
		expect(parsed.every((r: { kind: string }) => r.kind === "codebase_existing")).toBe(true);
	});

	it("respects --top to cap the number of rows", async () => {
		// Seed multiple distinct signatures.
		for (const id of ["a", "b", "c"]) {
			recordHarnessCaught({
				check_id: id,
				agent_source: "claude",
				session_id: "s",
				file: "f.ts",
				cwd: dir,
			});
		}
		await recurrenceListCommand({ cwd: dir, top: "2", json: true });
		const parsed = JSON.parse(captured()) as unknown[];
		expect(parsed).toHaveLength(2);
	});
});

describe("recurrence detail", () => {
	it("lists each event for the named signature", async () => {
		seedThreeCaughtEvents();
		await recurrenceDetailCommand("harness_caught:misused_promises:claude", { cwd: dir });
		const out = captured();
		expect(out).toContain("src/foo0.ts");
		expect(out).toContain("src/foo1.ts");
		expect(out).toContain("src/foo2.ts");
	});

	it("warns and exits cleanly when the signature is unknown", async () => {
		seedThreeCaughtEvents();
		await recurrenceDetailCommand("not_a_real_signature", { cwd: dir });
		const allOutput = captured() + errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(allOutput).toMatch(/no events|unknown/i);
	});
});

describe("recurrence flag", () => {
	it("appends a harness_missed event with the supplied signature", async () => {
		await recurrenceFlagCommand("raw-sql-concat", { cwd: dir, message: "spotted in db.ts" });
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("harness_missed");
		expect(events[0].signature).toBe("raw-sql-concat");
		expect(events[0].message).toBe("spotted in db.ts");
	});
});

describe("recurrence propose", () => {
	it("prints a ratchet headline for harness_caught rows", async () => {
		seedThreeCaughtEvents();
		await recurrenceProposeCommand("harness_caught:misused_promises:claude", { cwd: dir });
		const out = captured();
		expect(out.toLowerCase()).toContain("ratchet");
		expect(out).toContain("misused_promises");
	});

	it("returns gracefully when the signature is unknown", async () => {
		await recurrenceProposeCommand("nothing", { cwd: dir });
		const out = captured() + errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(out.length).toBeGreaterThan(0);
	});
});

describe("recurrence scan", () => {
	it("dry-run by default does not write to recurrences.jsonl", async () => {
		await recurrenceScanCommand({ cwd: dir });
		expect(loadRecurrenceEvents(dir)).toEqual([]);
	});
});
