// End-to-end tests for `interlinked scanner {on,off,toggle,status}` — exercise
// the real filesystem side effects (config write + audit append) by pointing
// INTERLINKED_HOME at a fresh tmp dir per test. The command module reads/writes
// config through `getConfigDir()`, which honors that env var.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	scannerOffCommand,
	scannerOnCommand,
	scannerStatusCommand,
	scannerToggleCommand,
} from "../scanner.js";

let workDir: string;
let previousInterlinkedHome: string | undefined;

beforeEach(() => {
	workDir = join(
		tmpdir(),
		`scanner-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(workDir, { recursive: true });
	previousInterlinkedHome = process.env.INTERLINKED_HOME;
	process.env.INTERLINKED_HOME = workDir;
});

afterEach(() => {
	if (previousInterlinkedHome === undefined) {
		delete process.env.INTERLINKED_HOME;
	} else {
		process.env.INTERLINKED_HOME = previousInterlinkedHome;
	}
	rmSync(workDir, { recursive: true, force: true });
});

function readLocalRules(): Record<string, unknown> {
	const path = join(workDir, "guard-rules.local.json");
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function readAuditLines(): Array<Record<string, unknown>> {
	const path = join(workDir, "content-scanner.audit.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("interlinked scanner — enable/disable flow", () => {
	it("scanner off writes enabled:false and appends a 'disable' audit entry", async () => {
		// Starting state: rules file missing — behaves as enabled:false already.
		await scannerOffCommand({ reason: "testing", json: true });

		const rules = readLocalRules();
		expect(rules).toHaveProperty("content_scanner");
		expect((rules.content_scanner as Record<string, unknown>).enabled).toBe(false);

		const audit = readAuditLines();
		expect(audit).toHaveLength(1);
		// Going from (missing → false) is a no_change in terms of enablement.
		expect(audit[0].action).toBe("no_change");
		expect(audit[0].from).toBe(false);
		expect(audit[0].to).toBe(false);
		expect(audit[0].reason).toBe("testing");
	});

	it("scanner on after off records a state transition with reason", async () => {
		await scannerOffCommand({ json: true });
		await scannerOnCommand({ reason: "re-enable for sensitive session", json: true });

		const rules = readLocalRules();
		expect((rules.content_scanner as Record<string, unknown>).enabled).toBe(true);

		const audit = readAuditLines();
		expect(audit).toHaveLength(2);
		expect(audit[1].action).toBe("enable");
		expect(audit[1].from).toBe(false);
		expect(audit[1].to).toBe(true);
		expect(audit[1].reason).toBe("re-enable for sensitive session");
		expect((audit[1].actor as Record<string, unknown>).via).toBe("cli");
		expect(typeof (audit[1].actor as Record<string, unknown>).user).toBe("string");
		// ISO timestamp sanity — Zulu time with millisecond precision.
		expect(audit[1].ts).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
	});

	it("toggle flips repeatedly and records each transition", async () => {
		// Seed to a known on state.
		await scannerOnCommand({ json: true });
		// Flip off, on, off with reasons.
		await scannerToggleCommand({ reason: "briefly off for debugging", json: true });
		await scannerToggleCommand({ json: true });
		await scannerToggleCommand({ reason: "ending session — disable", json: true });

		const rules = readLocalRules();
		expect((rules.content_scanner as Record<string, unknown>).enabled).toBe(false);

		const audit = readAuditLines();
		expect(audit.map((e) => e.action)).toEqual(["enable", "disable", "enable", "disable"]);
		expect(audit[1].reason).toBe("briefly off for debugging");
		expect(audit[3].reason).toBe("ending session — disable");
	});

	it("preserves unrelated keys in guard-rules.local.json", async () => {
		// Simulate a user who has already set other overrides.
		const path = join(workDir, "guard-rules.local.json");
		writeFileSync(
			path,
			JSON.stringify(
				{
					disabled_rules: ["some-rule"],
					output_scanning: { max_scan_bytes: 50000 },
				},
				null,
				2,
			),
		);

		await scannerOnCommand({ json: true });

		const rules = readLocalRules();
		expect(rules.disabled_rules).toEqual(["some-rule"]);
		expect(rules.output_scanning).toEqual({ max_scan_bytes: 50000 });
		expect((rules.content_scanner as Record<string, unknown>).enabled).toBe(true);
	});

	it("status prints the current enabled flag and last audit entries", async () => {
		await scannerOffCommand({ reason: "demo-1", json: true });
		await scannerOnCommand({ reason: "demo-2", json: true });

		const logs: unknown[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.join(" "));
		};
		try {
			await scannerStatusCommand({ json: true });
		} finally {
			console.log = origLog;
		}

		// json mode output goes through output() which console.logs a JSON string.
		const jsonPayload = logs.find((l): l is string => typeof l === "string" && l.includes("enabled"));
		expect(jsonPayload).toBeDefined();
		const parsed = JSON.parse(jsonPayload as string) as Record<string, unknown>;
		expect(parsed.enabled).toBe(true);
		expect(Array.isArray(parsed.last_audit)).toBe(true);
		expect((parsed.last_audit as unknown[]).length).toBeGreaterThanOrEqual(2);
	});
});
