import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The proven content-gate pipeline is tested in content-gate.test.ts. Here we
// unit-test the COMMAND wiring: parse changeset -> resolve proposed content
// (REAL overlay-content) -> gate (mocked) -> report + exit code. It must NEVER
// write, and it must call the SAME gate the enforced Write/Edit path calls.
const gateProposedContent = vi.fn();
vi.mock("../harness/content-gate.js", () => ({
	GATE_SEVERITY_ERROR: "error",
	gateProposedContent: (...a: unknown[]) => gateProposedContent(...a),
	formatGateResult: (r: { ok: boolean; failures: unknown[] }) =>
		r.ok ? "interlinked gate: clean" : `interlinked gate: ${r.failures.length} failure(s)`,
}));

import { verifyChangesetCommand } from "./verify-changeset.js";

const CLEAN = { ok: true, failures: [], elapsedMs: 3 };
function blockingResult() {
	return {
		ok: false,
		failures: [
			{ path: "x.ts", tool: "pre_block", code: "secret", line: 1, message: "boom", severity: "error" },
		],
		elapsedMs: 4,
	};
}

let logs: string[];
let errs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let tmp: string;

beforeEach(() => {
	gateProposedContent.mockReset().mockReturnValue(CLEAN);
	logs = [];
	errs = [];
	logSpy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
		logs.push(String(m));
	});
	errSpy = vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
		errs.push(String(m));
	});
	process.exitCode = 0;
	tmp = mkdtempSync(join(tmpdir(), "vcs-"));
});
afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = 0;
	rmSync(tmp, { recursive: true, force: true });
});

function manifest(changes: unknown[]): string {
	const p = join(tmp, "changeset.json");
	writeFileSync(p, JSON.stringify({ version: 1, changes }));
	return p;
}

describe("verify-changeset — preview-not-bypass self-gate", () => {
	it("clean write-form changeset -> ok, exit 0, gates the full content", async () => {
		const target = join(tmp, "x.ts");
		await verifyChangesetCommand({ file: manifest([{ path: target, content: "export const x = 1;\n" }]), json: true });
		expect(process.exitCode).toBe(0);
		expect(gateProposedContent).toHaveBeenCalledWith(
			[{ path: target, content: "export const x = 1;\n" }],
			// tscUnavailableSeverity "error": an unavailable type checker must
			// fail the preview, never read as clean (see verify-changeset.ts).
			expect.objectContaining({ skipPreWarn: true, tscUnavailableSeverity: "error" }),
		);
		const out = JSON.parse(logs.join("\n"));
		expect(out.ok).toBe(true);
		expect(out.preview).toBe(true);
	});

	it("blocking failure -> exit 1, reports it, writes NOTHING", async () => {
		gateProposedContent.mockReturnValue(blockingResult());
		const target = join(tmp, "new.ts");
		await verifyChangesetCommand({ file: manifest([{ path: target, content: "x" }]), json: true });
		expect(process.exitCode).toBe(1);
		const out = JSON.parse(logs.join("\n"));
		expect(out.ok).toBe(false);
		expect(out.failures).toHaveLength(1);
		expect(existsSync(target)).toBe(false); // preview NEVER writes
	});

	it("edit-form entry resolves against on-disk content before gating (read-only)", async () => {
		const foo = join(tmp, "foo.ts");
		writeFileSync(foo, "const a = 1;\nconst b = 2;\n");
		await verifyChangesetCommand({
			file: manifest([{ path: foo, old_string: "const a = 1;", new_string: "const a = 99;" }]),
			json: true,
		});
		expect(gateProposedContent).toHaveBeenCalledWith(
			[{ path: foo, content: "const a = 99;\nconst b = 2;\n" }],
			expect.anything(),
		);
		expect(readFileSync(foo, "utf-8")).toBe("const a = 1;\nconst b = 2;\n"); // unchanged on disk
	});

	it("--warnings surfaces pre_warn advisories (skipPreWarn false)", async () => {
		await verifyChangesetCommand({
			file: manifest([{ path: join(tmp, "x.ts"), content: "export const x = 1;\n" }]),
			warnings: true,
			json: true,
		});
		expect(gateProposedContent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ skipPreWarn: false }),
		);
		// Not mock-only: the command still produced a clean preview + exit 0.
		expect(JSON.parse(logs.join("\n")).ok).toBe(true);
		expect(process.exitCode).toBe(0);
	});

	it("human output identifies it as a preview", async () => {
		await verifyChangesetCommand({ file: manifest([{ path: join(tmp, "x.ts"), content: "export const x = 1;\n" }]) });
		expect([...logs, ...errs].join("\n").toLowerCase()).toContain("preview");
	});

	it("empty/invalid changeset -> usage error, exit 2, gate never called", async () => {
		const p = join(tmp, "bad.json");
		writeFileSync(p, JSON.stringify({ version: 1, changes: [] }));
		await verifyChangesetCommand({ file: p, json: true });
		expect(process.exitCode).toBe(2);
		expect(gateProposedContent).not.toHaveBeenCalled();
	});

	it("--file pointing at a nonexistent path -> usage error naming the file", async () => {
		const missing = join(tmp, "does-not-exist.json");
		await verifyChangesetCommand({ file: missing, json: true });
		expect(process.exitCode).toBe(2);
		const out = JSON.parse(logs.join("\n"));
		expect(out.error).toContain(`Could not read changeset file ${missing}`);
		expect(gateProposedContent).not.toHaveBeenCalled();
	});

	it("neither --file nor --stdin -> usage error", async () => {
		await verifyChangesetCommand({ json: true });
		expect(process.exitCode).toBe(2);
		expect(JSON.parse(logs.join("\n")).error).toBe("Provide --file <changeset.json> or --stdin.");
		expect(gateProposedContent).not.toHaveBeenCalled();
	});

	it("--stdin reads process.stdin to EOF and gates the parsed changeset", async () => {
		const target = join(tmp, "stdin-target.ts");
		const payload = JSON.stringify({
			version: 1,
			changes: [{ path: target, content: "export const z = 1;\n" }],
		});
		const promise = verifyChangesetCommand({ stdin: true, json: true });
		process.stdin.emit("data", Buffer.from(payload));
		process.stdin.emit("end");
		await promise;
		expect(process.exitCode).toBe(0);
		expect(gateProposedContent).toHaveBeenCalledWith(
			[{ path: target, content: "export const z = 1;\n" }],
			expect.objectContaining({ skipPreWarn: true }),
		);
	});

	it("invalid JSON changeset -> usage error naming the parse failure", async () => {
		const p = join(tmp, "invalid.json");
		writeFileSync(p, "{ this is not json");
		await verifyChangesetCommand({ file: p, json: true });
		expect(process.exitCode).toBe(2);
		expect(JSON.parse(logs.join("\n")).error).toContain("Changeset is not valid JSON");
		expect(gateProposedContent).not.toHaveBeenCalled();
	});

	it("changeset that parses to a non-object (e.g. a JSON string) -> usage error", async () => {
		const p = join(tmp, "primitive.json");
		writeFileSync(p, JSON.stringify("just a string"));
		await verifyChangesetCommand({ file: p, json: true });
		expect(process.exitCode).toBe(2);
		expect(JSON.parse(logs.join("\n")).error).toBe(
			"Changeset must be a JSON object { version: 1, changes: [...] }.",
		);
	});

	it("wrong changeset version -> usage error naming the offending version", async () => {
		const p = join(tmp, "v2.json");
		writeFileSync(p, JSON.stringify({ version: 2, changes: [{ path: "x.ts", content: "y" }] }));
		await verifyChangesetCommand({ file: p, json: true });
		expect(process.exitCode).toBe(2);
		expect(JSON.parse(logs.join("\n")).error).toBe("Changeset version must be 1 (got 2).");
	});

	it("changes[i] that isn't an object -> usage error naming the index", async () => {
		const p = join(tmp, "notobj.json");
		writeFileSync(p, JSON.stringify({ version: 1, changes: ["nope"] }));
		await verifyChangesetCommand({ file: p, json: true });
		expect(process.exitCode).toBe(2);
		expect(JSON.parse(logs.join("\n")).error).toBe(
			"changes[0] must be an object { path, content | old_string+new_string | edits }.",
		);
	});

	it("changes[i] missing a non-empty path -> usage error naming the index", async () => {
		const p = join(tmp, "nopath.json");
		writeFileSync(p, JSON.stringify({ version: 1, changes: [{ content: "x" }] }));
		await verifyChangesetCommand({ file: p, json: true });
		expect(process.exitCode).toBe(2);
		expect(JSON.parse(logs.join("\n")).error).toBe("changes[0].path must be a non-empty string.");
	});

	it("json failure output includes column and hint when the gate provides them", async () => {
		gateProposedContent.mockReturnValue({
			ok: false,
			failures: [
				{
					path: "x.ts",
					tool: "pre_block",
					code: "secret",
					line: 1,
					column: 5,
					message: "boom",
					severity: "error",
					hint: "fix it",
				},
			],
			elapsedMs: 4,
		});
		await verifyChangesetCommand({
			file: manifest([{ path: join(tmp, "x.ts"), content: "x" }]),
			json: true,
		});
		const out = JSON.parse(logs.join("\n"));
		expect(out.failures).toEqual([
			{
				path: "x.ts",
				tool: "pre_block",
				code: "secret",
				line: 1,
				message: "boom",
				severity: "error",
				column: 5,
				hint: "fix it",
			},
		]);
	});

	it("usage error in human mode goes to console.error, not console.log", async () => {
		await verifyChangesetCommand({});
		expect(process.exitCode).toBe(2);
		expect(logs).toHaveLength(0);
		expect(errs.join("\n")).toContain("Provide --file <changeset.json> or --stdin.");
	});

	it("blocking failure in human mode names the real gate blocking it on submit", async () => {
		gateProposedContent.mockReturnValue(blockingResult());
		await verifyChangesetCommand({ file: manifest([{ path: join(tmp, "new2.ts"), content: "x" }]) });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toContain("The real gate blocks this on submit until fixed.");
	});
});
