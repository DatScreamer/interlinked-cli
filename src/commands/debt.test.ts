// ===========================================
// interlinked debt — CLI subcommand behavioral tests
// ===========================================
// Drives list / show / resolve against a REAL ledger in a tmp dir (the same
// obligation-ledger-io layer the harness gate uses — no mocks), asserting on
// console output captured via spies (audit.test.ts's style). `resolve` is the
// one writer: it must append ordinary local-source discharges and touch ONLY
// the named file's debts — the commit gate remains the ground-truth backstop.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendDebtTxn, readOpenDebts } from "../harness/obligation-ledger-io.js";
import { type ObligationKind, obligationId } from "../harness/obligations.js";
import { debtListCommand, debtResolveCommand, debtShowCommand } from "./debt.js";

let root: string;
let logged: string[];
let errored: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let previousExitCode: number | string | undefined;

const joinArgs = (args: unknown[]): string =>
	args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "debt-cli-"));
	logged = [];
	errored = [];
	logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logged.push(joinArgs(args));
	});
	errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errored.push(joinArgs(args));
	});
	previousExitCode = process.exitCode;
	process.exitCode = 0;
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	rmSync(root, { recursive: true, force: true });
	process.exitCode = previousExitCode;
});

const out = (): string => logged.join("\n");
const err = (): string => errored.join("\n");

function seedOpen(file: string, kind: ObligationKind = "coverage"): void {
	appendDebtTxn(root, {
		op: "open",
		kind,
		file,
		contentHash: "",
		sessionId: "sess-1234567890",
		atMs: 1_700_000_000_000,
	});
}

// ===========================================
// debt list
// ===========================================

describe("interlinked debt list", () => {
	it("prints an all-clear message and exits 0 when the ledger is empty", async () => {
		await debtListCommand({ cwd: root });
		expect(out()).toContain("no open debts");
		expect(err()).toBe("");
		expect(process.exitCode).toBe(0);
	});

	it("returns [] via --json when nothing is open", async () => {
		await debtListCommand({ cwd: root, json: true });
		expect(JSON.parse(out())).toEqual([]);
	});

	it("renders a table row per open debt (kind, file, opened-at, session)", async () => {
		seedOpen("src/foo.ts", "coverage");
		seedOpen("src/bar.ts", "red_suite");
		await debtListCommand({ cwd: root });
		expect(out()).toContain("KIND");
		expect(out()).toContain("FILE");
		expect(out()).toContain("OPENED");
		expect(out()).toContain("SESSION");
		expect(out()).toContain("coverage");
		expect(out()).toContain("red_suite");
		expect(out()).toContain("src/foo.ts");
		expect(out()).toContain("src/bar.ts");
		expect(out()).toContain("2023-11-14T22:13:20.000Z"); // iso of the seeded atMs
		expect(out()).toContain("sess-1234567"); // session column (truncated ok)
		expect(out()).toContain("(2 open debt(s)");
		expect(process.exitCode).toBe(0);
	});

	it("emits the open debts via --json (kind + file present)", async () => {
		seedOpen("src/foo.ts", "red_suite");
		await debtListCommand({ cwd: root, json: true });
		// SAFETY: shape pinned by the command's --json contract, asserted below.
		const rows = JSON.parse(out()) as Array<{ kind: string; file: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: "red_suite", file: "src/foo.ts" });
	});

	it("does not list a discharged debt", async () => {
		seedOpen("src/foo.ts");
		appendDebtTxn(root, {
			op: "discharge",
			id: obligationId("coverage", "src/foo.ts"),
			source: "local",
			atMs: 2,
		});
		await debtListCommand({ cwd: root });
		expect(out()).toContain("no open debts");
	});

	it("--short prints a one-line summary naming the files", async () => {
		seedOpen("src/foo.ts");
		await debtListCommand({ cwd: root, short: true });
		expect(out()).toBe("1 open debt(s): src/foo.ts");
	});

	it("--short reads 'no open debts' when clear", async () => {
		await debtListCommand({ cwd: root, short: true });
		expect(out()).toBe("no open debts");
	});
});

describe("interlinked debt — defaults cwd to process.cwd()", () => {
	let originalCwd = "";
	beforeEach(() => {
		originalCwd = process.cwd();
		process.chdir(root);
	});
	afterEach(() => {
		process.chdir(originalCwd);
	});

	it("debtListCommand resolves the ledger relative to process.cwd() when cwd is omitted", async () => {
		seedOpen("src/foo.ts");
		await debtListCommand({ json: true });
		// SAFETY: shape pinned by the command's --json contract, asserted below.
		const rows = JSON.parse(out()) as Array<{ file: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.file).toBe("src/foo.ts");
	});
});

// ===========================================
// debt show <file>
// ===========================================

describe("interlinked debt show", () => {
	it("rejects a missing / whitespace-only <file> with usage and exit 2", async () => {
		await debtShowCommand("   ", { cwd: root });
		expect(err()).toContain("<file> is required");
		expect(err()).toContain("Usage: interlinked debt show <file>");
		expect(process.exitCode).toBe(2);
	});

	it("reports no-history with a non-zero exit for an unknown file", async () => {
		await debtShowCommand("src/never-debted.ts", { cwd: root });
		expect(err()).toContain("Error:");
		expect(err()).toContain("src/never-debted.ts");
		expect(process.exitCode).toBe(1);
	});

	it("reports no-history as structured JSON on --json", async () => {
		await debtShowCommand("src/never-debted.ts", { cwd: root, json: true });
		// SAFETY: outputError's --json contract ({error, details}), asserted below.
		const parsed = JSON.parse(err()) as { error: string };
		expect(parsed.error).toContain("src/never-debted.ts");
		expect(process.exitCode).toBe(1);
	});

	it("prints the full transition history for one file (open, discharge, escalate)", async () => {
		seedOpen("src/foo.ts", "coverage");
		appendDebtTxn(root, {
			op: "discharge",
			id: obligationId("coverage", "src/foo.ts"),
			source: "observed",
			atMs: 1_700_000_100_000,
		});
		appendDebtTxn(root, {
			op: "open",
			kind: "mutation",
			file: "src/foo.ts",
			region: { start: 3, end: 9 },
			contentHash: "abc",
			sessionId: "sess-2",
			atMs: 1_700_000_200_000,
		});
		appendDebtTxn(root, {
			op: "escalate",
			id: obligationId("mutation", "src/foo.ts", { start: 3, end: 9 }),
			survivors: [{ line: 4, description: "swapped > for >=" }],
			atMs: 1_700_000_300_000,
		});
		seedOpen("src/other.ts"); // must NOT appear
		await debtShowCommand("src/foo.ts", { cwd: root });
		expect(out()).toContain("Ledger history for src/foo.ts");
		expect(out()).toContain("4 transition(s)");
		expect(out()).toContain("open");
		expect(out()).toContain("source=observed");
		expect(out()).toContain("[3-9]"); // region-scoped open
		expect(out()).toContain("survivors=1");
		expect(out()).toContain("session=sess-1234567890");
		expect(out()).not.toContain("src/other.ts");
		expect(process.exitCode).toBe(0);
	});

	it("counts the still-open debts in the header", async () => {
		seedOpen("src/foo.ts", "coverage");
		seedOpen("src/foo.ts", "red_suite");
		await debtShowCommand("src/foo.ts", { cwd: root });
		expect(out()).toContain("2 still open");
	});

	it("emits {file, open, txns} via --json", async () => {
		seedOpen("src/foo.ts", "red_suite");
		await debtShowCommand("src/foo.ts", { cwd: root, json: true });
		// SAFETY: shape pinned by the command's --json contract, asserted below.
		const parsed = JSON.parse(out()) as {
			file: string;
			open: Array<{ kind: string }>;
			txns: Array<{ op: string }>;
		};
		expect(parsed.file).toBe("src/foo.ts");
		expect(parsed.open).toHaveLength(1);
		expect(parsed.txns.map((t) => t.op)).toEqual(["open"]);
	});
});

// ===========================================
// debt resolve <file>
// ===========================================

describe("interlinked debt resolve", () => {
	it("rejects a missing <file> with usage and exit 2", async () => {
		await debtResolveCommand(undefined, { cwd: root });
		expect(err()).toContain("<file> is required");
		expect(err()).toContain("Usage: interlinked debt resolve <file>");
		expect(process.exitCode).toBe(2);
	});

	it("is an idempotent no-op (exit 0) when the file has no open debts", async () => {
		await debtResolveCommand("src/foo.ts", { cwd: root });
		expect(out()).toContain("no open debts on src/foo.ts");
		expect(process.exitCode).toBe(0);
	});

	it("discharges every open debt on the named file — and ONLY that file", async () => {
		seedOpen("src/foo.ts", "coverage");
		seedOpen("src/foo.ts", "red_suite");
		seedOpen("src/bar.ts", "coverage");
		await debtResolveCommand("src/foo.ts", { cwd: root });
		const stillOpen = readOpenDebts(root);
		expect(stillOpen).toHaveLength(1);
		expect(stillOpen[0]?.file).toBe("src/bar.ts");
		expect(out()).toContain("Resolved 2 open debt(s) on src/foo.ts");
		expect(out()).toContain("coverage");
		expect(out()).toContain("red_suite");
		// The help/output must keep the override honest: commit gate = ground truth.
		expect(out()).toContain("commit gate");
		expect(process.exitCode).toBe(0);
	});

	it("emits {file, resolved} via --json", async () => {
		seedOpen("src/foo.ts", "coverage");
		await debtResolveCommand("src/foo.ts", { cwd: root, json: true });
		// SAFETY: shape pinned by the command's --json contract, asserted below.
		const parsed = JSON.parse(out()) as {
			file: string;
			resolved: Array<{ id: string; kind: string }>;
		};
		expect(parsed.file).toBe("src/foo.ts");
		expect(parsed.resolved).toEqual([
			{ id: obligationId("coverage", "src/foo.ts"), kind: "coverage" },
		]);
		expect(readOpenDebts(root)).toHaveLength(0);
	});

	it("--short summarizes the count", async () => {
		seedOpen("src/foo.ts", "coverage");
		await debtResolveCommand("src/foo.ts", { cwd: root, short: true });
		expect(out()).toBe("resolved 1 debt(s) on src/foo.ts");
	});
});
