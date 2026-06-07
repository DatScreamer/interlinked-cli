import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `confirm()` in mode.ts reads a yes/no answer via fs.readSync(0, ...). The rest
// of this suite exercises real on-disk config files in a mkdtemp dir, so we mock
// node:fs as a *passthrough* (every real fn intact) and override only readSync
// with a per-test-controllable stub. The holder is hoisted so vi.mock — which is
// itself hoisted above the imports — can close over it.
const fsStub = vi.hoisted(() => ({
	// Returns 0 bytes by default (== EOF / empty answer == "no").
	readSyncImpl: (..._args: unknown[]): number => 0,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readSync: (...args: unknown[]) => fsStub.readSyncImpl(...args),
	};
});

const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import(
	"node:fs"
);
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { modeCommand, writeMode } = await import("./mode.js");

/** Sentinel: make the next readSync throw (exercises readLineSync's catch). */
const THROW = Symbol("readSync-throws");
/** Make confirm() answer with `answer` bytes (or throw on read). */
function primeConfirm(answer: string | typeof THROW): void {
	if (answer === THROW) {
		fsStub.readSyncImpl = () => {
			throw new Error("simulated read failure");
		};
		return;
	}
	fsStub.readSyncImpl = (_fd: unknown, buf: unknown) => {
		const b = buf as Buffer;
		return b.write(answer, 0, "utf-8");
	};
}

let tmp = "";
let originalCwd = "";
let originalIsTTY: boolean | undefined;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-mode-"));
	originalCwd = process.cwd();
	process.chdir(tmp);
	mkdirSync(join(tmp, ".interlinked"));
	process.exitCode = 0;
	originalIsTTY = process.stdin.isTTY;
	// readSync stub resets to EOF/"no" before each test; opt-in per test.
	fsStub.readSyncImpl = () => 0;
});
afterEach(() => {
	process.chdir(originalCwd);
	process.exitCode = 0;
	rmSync(tmp, { recursive: true, force: true });
	(process.stdin as { isTTY: boolean | undefined }).isTTY = originalIsTTY;
});

function captureStdout(): { text: () => string; restore: () => void } {
	let captured = "";
	const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
		buf: string | Uint8Array,
	) => {
		captured += typeof buf === "string" ? buf : Buffer.from(buf).toString("utf-8");
		return true;
	}) as unknown as typeof process.stdout.write);
	return { text: () => captured, restore: () => spy.mockRestore() };
}

describe("writeMode", () => {
	it("creates the shared config when absent", () => {
		writeMode(tmp, "strict", false);
		const path = join(tmp, ".interlinked", "check-policy.json");
		expect(existsSync(path)).toBe(true);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.mode).toBe("strict");
		expect(parsed.version).toBe(1);
	});

	it("preserves existing fields when updating mode", () => {
		const path = join(tmp, ".interlinked", "check-policy.json");
		writeFileSync(
			path,
			JSON.stringify({ version: 1, checks: { focused_tests: { action: "block_preview" } } }),
		);
		writeMode(tmp, "strict", false);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.mode).toBe("strict");
		expect(parsed.checks.focused_tests.action).toBe("block_preview");
	});

	it("writes to the local file when local=true", () => {
		writeMode(tmp, "lenient", true);
		expect(existsSync(join(tmp, ".interlinked", "check-policy.local.json"))).toBe(true);
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});
});

describe("modeCommand — show current", () => {
	it("reports built-in default when no config exists", async () => {
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		expect(cap.text()).toContain("Current: balanced");
		expect(cap.text()).toContain("built-in default");
	});

	it("reports mode from a written shared config", async () => {
		writeMode(tmp, "strict", false);
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		expect(cap.text()).toContain("Current: strict");
	});

	it("JSON output enumerates available modes", async () => {
		const cap = captureStdout();
		await modeCommand(undefined, { json: true });
		cap.restore();
		const payload = JSON.parse(cap.text()) as {
			mode: string;
			available_modes: Array<{ name: string }>;
		};
		expect(payload.mode).toBe("balanced");
		expect(payload.available_modes.length).toBe(3);
	});
});

describe("modeCommand — diff preview", () => {
	it("prints changes that strict would introduce", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { diff: true });
		cap.restore();
		expect(cap.text()).toContain("Switching to strict would change");
		expect(cap.text()).toContain("focused_tests");
	});

	it("reports no changes when switching balanced → balanced", async () => {
		const cap = captureStdout();
		await modeCommand("balanced", { diff: true });
		cap.restore();
		expect(cap.text()).toContain("would not change");
	});

	it("JSON diff output is a structured list", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { diff: true, json: true });
		cap.restore();
		const payload = JSON.parse(cap.text()) as { mode: string; changes: unknown[] };
		expect(payload.mode).toBe("strict");
		expect(payload.changes.length).toBeGreaterThan(0);
	});
});

describe("modeCommand — apply with --force", () => {
	it("writes the shared file and reports success", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { force: true });
		cap.restore();
		expect(cap.text()).toContain("Mode set to strict");
		const parsed = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "check-policy.json"), "utf-8"),
		);
		expect(parsed.mode).toBe("strict");
	});

	it("writes the local override with --local", async () => {
		const cap = captureStdout();
		await modeCommand("lenient", { force: true, local: true });
		cap.restore();
		expect(existsSync(join(tmp, ".interlinked", "check-policy.local.json"))).toBe(true);
	});

	it("JSON output reports the written path", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { force: true, json: true });
		cap.restore();
		const payload = JSON.parse(cap.text()) as { ok: boolean; path: string; scope: string };
		expect(payload.ok).toBe(true);
		expect(payload.path.endsWith("check-policy.json")).toBe(true);
		expect(payload.scope).toBe("shared");
	});

	it("JSON output reports the local scope and path with --local", async () => {
		const cap = captureStdout();
		await modeCommand("lenient", { force: true, json: true, local: true });
		cap.restore();
		const payload = JSON.parse(cap.text()) as {
			ok: boolean;
			mode: string;
			scope: string;
			path: string;
		};
		expect(payload.ok).toBe(true);
		expect(payload.mode).toBe("lenient");
		expect(payload.scope).toBe("local");
		expect(payload.path.endsWith("check-policy.local.json")).toBe(true);
		expect(existsSync(join(tmp, ".interlinked", "check-policy.local.json"))).toBe(true);
	});

	it("non-JSON --local apply reports the personal-override scope", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { force: true, local: true });
		cap.restore();
		expect(cap.text()).toContain("Mode set to strict (personal override)");
	});
});

describe("modeCommand — error paths", () => {
	it("rejects unknown mode names", async () => {
		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await modeCommand("super-strict", { force: true });
		expect(process.exitCode).toBe(1);
		spy.mockRestore();
	});

	it("unknown mode in JSON mode emits a structured failure to stdout", async () => {
		const cap = captureStdout();
		await modeCommand("super-strict", { json: true });
		cap.restore();
		const payload = JSON.parse(cap.text()) as { ok: boolean; reason: string };
		expect(payload.ok).toBe(false);
		expect(payload.reason).toContain("unknown mode: super-strict");
		// Known modes are listed so the caller can recover.
		expect(payload.reason).toContain("balanced");
		expect(process.exitCode).toBe(1);
	});
});

describe("modeCommand — interactive confirmation (no --force, no --json)", () => {
	it("applies the mode when the user answers yes", async () => {
		(process.stdin as { isTTY: boolean | undefined }).isTTY = true;
		primeConfirm("y\n");
		const cap = captureStdout();
		await modeCommand("strict", {});
		cap.restore();
		// Diff preview rendered first, then the confirm prompt, then success.
		expect(cap.text()).toContain("Switching to strict would change");
		expect(cap.text()).toContain("Apply strict mode?");
		expect(cap.text()).toContain("Mode set to strict");
		const parsed = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "check-policy.json"), "utf-8"),
		) as { mode: string };
		expect(parsed.mode).toBe("strict");
	});

	it("accepts a full 'yes' (case-insensitive) as confirmation", async () => {
		(process.stdin as { isTTY: boolean | undefined }).isTTY = true;
		primeConfirm("YES\n");
		const cap = captureStdout();
		await modeCommand("lenient", {});
		cap.restore();
		expect(cap.text()).toContain("Mode set to lenient");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(true);
	});

	it("aborts (no write) when the user answers no", async () => {
		(process.stdin as { isTTY: boolean | undefined }).isTTY = true;
		primeConfirm("n\n");
		const cap = captureStdout();
		await modeCommand("strict", {});
		cap.restore();
		expect(cap.text()).toContain("Aborted.");
		expect(cap.text()).not.toContain("Mode set to");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});

	it("aborts when stdin is not a TTY (non-interactive shells never confirm)", async () => {
		(process.stdin as { isTTY: boolean | undefined }).isTTY = false;
		// readSync must NOT be consulted in this path; make it explode if it is.
		primeConfirm(THROW);
		const cap = captureStdout();
		await modeCommand("strict", {});
		cap.restore();
		expect(cap.text()).toContain("Aborted.");
		// The prompt is never written when there's no TTY.
		expect(cap.text()).not.toContain("Apply strict mode?");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});

	it("treats a readSync failure as a declined prompt (catch → empty answer)", async () => {
		(process.stdin as { isTTY: boolean | undefined }).isTTY = true;
		primeConfirm(THROW);
		const cap = captureStdout();
		await modeCommand("strict", {});
		cap.restore();
		// Prompt is shown (TTY), read throws → "" → not a yes → abort.
		expect(cap.text()).toContain("Apply strict mode?");
		expect(cap.text()).toContain("Aborted.");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});

	it("treats whitespace-only / empty input as a declined prompt", async () => {
		(process.stdin as { isTTY: boolean | undefined }).isTTY = true;
		primeConfirm("   \n");
		const cap = captureStdout();
		await modeCommand("lenient", {});
		cap.restore();
		expect(cap.text()).toContain("Aborted.");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});
});

describe("modeCommand — custom mode (no preset)", () => {
	it("diff against custom uses the current default action (null preset)", async () => {
		// custom has no preset; computeDiff falls back to the current default
		// action for every check, so a diff from the built-in balanced policy
		// (also warn_after default) yields no action changes.
		const cap = captureStdout();
		await modeCommand("custom", { diff: true });
		cap.restore();
		expect(cap.text()).toContain("Switching to custom would not change");
	});

	it("custom diff reflects changes when the current policy default differs", async () => {
		// Put the repo into lenient (default_action: info) so switching to custom
		// (which reverts to the current default — still 'info' here, since the
		// loaded policy already applied lenient) shows no spurious churn, while a
		// per-check override that differs from the default DOES surface.
		writeFileSync(
			join(tmp, ".interlinked", "check-policy.json"),
			JSON.stringify({
				version: 1,
				mode: "custom",
				defaults: { action: "warn_after" },
				checks: { focused_tests: { action: "block_preview" } },
			}),
		);
		const cap = captureStdout();
		await modeCommand("custom", { diff: true });
		cap.restore();
		// focused_tests is pinned to block_preview but custom reverts it to the
		// default warn_after → one change row.
		expect(cap.text()).toContain("Switching to custom would change");
		expect(cap.text()).toContain("focused_tests");
		expect(cap.text()).toContain("block_preview");
		expect(cap.text()).toContain("warn_after");
	});

	it("applies custom via --force without requiring a preset", async () => {
		const cap = captureStdout();
		await modeCommand("custom", { force: true });
		cap.restore();
		expect(cap.text()).toContain("Mode set to custom");
		const parsed = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "check-policy.json"), "utf-8"),
		) as { mode: string };
		expect(parsed.mode).toBe("custom");
	});
});

describe("modeCommand — show current with a local override present", () => {
	it("text output reports the personal-override source", async () => {
		writeMode(tmp, "lenient", true); // .local.json
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		expect(cap.text()).toContain("Current: lenient");
		expect(cap.text()).toContain("personal override");
		expect(cap.text()).toContain("check-policy.local.json");
		// Effective per-check action counts are rendered (lenient => info default).
		expect(cap.text()).toContain("Effective per-check action counts:");
		expect(cap.text()).toMatch(/info\s+\d+/);
	});

	it("text output falls back to the shared-config source when only it exists", async () => {
		writeMode(tmp, "strict", false); // .json only
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		expect(cap.text()).toContain("shared config");
		expect(cap.text()).toContain("check-policy.json");
		expect(cap.text()).not.toContain("personal override");
	});

	it("JSON output reports both shared and local paths when both exist", async () => {
		writeMode(tmp, "strict", false); // shared
		writeMode(tmp, "lenient", true); // local override wins
		const cap = captureStdout();
		await modeCommand(undefined, { json: true });
		cap.restore();
		const payload = JSON.parse(cap.text()) as {
			mode: string;
			shared_path: string | null;
			local_path: string | null;
		};
		// Local override wins for the effective mode.
		expect(payload.mode).toBe("lenient");
		expect(payload.shared_path).not.toBeNull();
		expect(payload.local_path).not.toBeNull();
		expect((payload.shared_path ?? "").endsWith("check-policy.json")).toBe(true);
		expect((payload.local_path ?? "").endsWith("check-policy.local.json")).toBe(true);
	});

	it("JSON output reports null paths when no config files exist", async () => {
		const cap = captureStdout();
		await modeCommand(undefined, { json: true });
		cap.restore();
		const payload = JSON.parse(cap.text()) as {
			shared_path: string | null;
			local_path: string | null;
		};
		expect(payload.shared_path).toBeNull();
		expect(payload.local_path).toBeNull();
	});
});

describe("writeMode — edge cases", () => {
	it("creates the .interlinked directory when it is absent", () => {
		// Fresh sub-dir with NO .interlinked yet — exercises the mkdirSync branch.
		const fresh = mkdtempSync(join(tmpdir(), "interlinked-mode-fresh-"));
		try {
			expect(existsSync(join(fresh, ".interlinked"))).toBe(false);
			writeMode(fresh, "strict", false);
			expect(existsSync(join(fresh, ".interlinked"))).toBe(true);
			const parsed = JSON.parse(
				readFileSync(join(fresh, ".interlinked", "check-policy.json"), "utf-8"),
			) as { mode: string };
			expect(parsed.mode).toBe("strict");
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});

	it("recovers from a malformed existing policy file (resets to version 1)", () => {
		const path = join(tmp, ".interlinked", "check-policy.json");
		writeFileSync(path, "{ this is not valid json ");
		writeMode(tmp, "lenient", false);
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			version: number;
			mode: string;
		};
		expect(parsed.mode).toBe("lenient");
		expect(parsed.version).toBe(1);
	});

	it("defaults version to 1 when the existing file omits it", () => {
		const path = join(tmp, ".interlinked", "check-policy.json");
		// Valid JSON but no `version` key — exercises the `?? 1` fallback.
		writeFileSync(path, JSON.stringify({ mode: "balanced", checks: {} }));
		writeMode(tmp, "strict", false);
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			version: number;
			mode: string;
			checks: Record<string, unknown>;
		};
		expect(parsed.version).toBe(1);
		expect(parsed.mode).toBe("strict");
		// Pre-existing (non-version) fields are preserved.
		expect(parsed.checks).toEqual({});
	});

	it("preserves a non-default version number already on disk", () => {
		const path = join(tmp, ".interlinked", "check-policy.json");
		writeFileSync(path, JSON.stringify({ version: 1, mode: "balanced" }));
		writeMode(tmp, "lenient", false);
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version: number };
		expect(parsed.version).toBe(1);
	});
});
