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
			expect.objectContaining({ skipPreWarn: true }),
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
});
