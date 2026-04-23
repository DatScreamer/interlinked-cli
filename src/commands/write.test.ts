// Tests for `interlinked write` — both unit (shape) and integration
// (round-trip) coverage.
//
// Integration cases here are the "known-coordinated edit" from the design
// doc (adding an import AND using it, which would otherwise trip the
// diff-overlay if staged as two separate Edits) and the mirror case
// (deliberately broken batch fails cleanly, files untouched).
//
// We invoke the compiled CLI via `tsx` so commander parsing, stdin
// piping, and exit codes are all exercised end-to-end. Each test gets
// its own fixture subdirectory so parallel describes never race.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { writeCommand } from "./write.js";

// Module-level export shape check. Fast — catches syntax / import errors
// without spawning a subprocess.
describe("write command module", () => {
	it("exports writeCommand as a function", () => {
		expect(typeof writeCommand).toBe("function");
	});
});

const CLI_ROOT = resolve(import.meta.dirname, "../..");
const CLI_ENTRY = resolve(CLI_ROOT, "src/index.ts");
// Each test gets its own subdir under this root so parallel describes
// don't race on shared paths. Teardown happens once at the end.
const FIXTURE_ROOT = resolve(CLI_ROOT, "src/lib/_write_integration");

let fixtureCounter = 0;
function nextFixtureDir(): string {
	fixtureCounter += 1;
	const dir = resolve(FIXTURE_ROOT, `case-${fixtureCounter}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

afterAll(() => {
	try {
		rmSync(FIXTURE_ROOT, { recursive: true, force: true });
	} catch {
		/* best-effort cleanup */
	}
});

// Running `tsx` in-process is fast enough for a couple of integration cases.
// Slow cases (biome warmup, tsc warmup) will land in the 5-15s range per
// call — acceptable for 2-3 tests.
function runCli(
	args: string[],
	opts: { stdin?: string; cwd?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("npx", ["tsx", CLI_ENTRY, ...args], {
		cwd: opts.cwd ?? CLI_ROOT,
		input: opts.stdin,
		encoding: "utf-8",
		env: { ...process.env, NO_COLOR: "1" },
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

describe("interlinked write — single-file mode", () => {
	let fixtureDir: string;
	beforeEach(() => {
		fixtureDir = nextFixtureDir();
	});

	it("writes content from stdin when the gate passes (new file)", () => {
		const target = resolve(fixtureDir, "new_ok.ts");
		const content = "export const x: number = 1;\n";
		const res = runCli(["write", target, "--stdin"], { stdin: content });
		expect(res.status).toBe(0);
		expect(existsSync(target)).toBe(true);
		expect(readFileSync(target, "utf-8")).toBe(content);
	});

	it("leaves file untouched when gate blocks", { retry: 2 }, () => {
		// Existing file with clean content. Propose an update that introduces
		// a biome noDoubleEquals violation — gate should reject.
		const target = resolve(fixtureDir, "blocks.ts");
		const before = "export function two(): number {\n\treturn 2;\n}\n";
		writeFileSync(target, before);
		const bad = `${before}\nexport function probe(): boolean {\n\treturn 1 == 1;\n}\n`;
		const res = runCli(["write", target, "--stdin"], { stdin: bad });
		expect(res.status).not.toBe(0);
		// File is unchanged.
		expect(readFileSync(target, "utf-8")).toBe(before);
	});
});

describe("interlinked write — batch mode", () => {
	let fixtureDir: string;
	beforeEach(() => {
		fixtureDir = nextFixtureDir();
	});

	it("round-trip coordinated edit: add import + use in same file lands cleanly", () => {
		// The exact shape from the design doc's Gemini-registry scenario:
		// adding an import AND using it in the same file. Two Edit calls —
		// "add the import" then "add the use" — would trip the diff-overlay
		// on the FIRST edit with biome noUnusedImports (because the import
		// is unused in the intermediate state). The `interlinked write`
		// command atomically lands the full post-state in one gate pass, so
		// the transient error is never seen.
		const targetPath = resolve(fixtureDir, "registry.ts");

		// Seed: a registry that doesn't yet use `randomUUID`.
		const seed = "export function register(name: string): string {\n\treturn name;\n}\n";
		writeFileSync(targetPath, seed);

		// Proposed end state: add the import AND the usage together.
		const proposed =
			'import { randomUUID } from "node:crypto";\n' +
			"export function register(name: string): string {\n" +
			'\treturn name + ":" + randomUUID();\n' +
			"}\n";

		const manifest = resolve(fixtureDir, "roundtrip-manifest.json");
		writeFileSync(
			manifest,
			JSON.stringify(
				{ version: 1, writes: [{ path: targetPath, content: proposed }] },
				null,
				2,
			),
		);

		const res = runCli(["write", "--batch", manifest]);
		expect(
			res.status,
			`interlinked write exit=${res.status}\nSTDOUT: ${res.stdout}\nSTDERR: ${res.stderr}`,
		).toBe(0);
		expect(readFileSync(targetPath, "utf-8")).toBe(proposed);
	}, 60_000);

	it("deliberately broken batch fails cleanly and leaves files untouched", { retry: 2, timeout: 60_000 }, () => {
		// One file OK, the other introduces biome violations. The whole batch
		// must fail, and BOTH files must remain on-disk exactly as they were.
		const okPath = resolve(fixtureDir, "batch_ok.ts");
		const badPath = resolve(fixtureDir, "batch_bad.ts");

		const okBefore = "export const a: number = 1;\n";
		const badBefore = "export const b: number = 2;\n";
		writeFileSync(okPath, okBefore);
		writeFileSync(badPath, badBefore);

		// badProposed introduces `1 == 1` — biome flags noDoubleEquals.
		const okProposed = "export const a: number = 11;\n";
		const badProposed = `${badBefore}export const probe: boolean = (1 == 1);\n`;

		const manifest = resolve(fixtureDir, "broken-manifest.json");
		writeFileSync(
			manifest,
			JSON.stringify(
				{
					version: 1,
					writes: [
						{ path: okPath, content: okProposed },
						{ path: badPath, content: badProposed },
					],
				},
				null,
				2,
			),
		);

		const res = runCli(["write", "--batch", manifest]);
		expect(res.status).not.toBe(0);
		// BOTH files unchanged — transactional.
		expect(readFileSync(okPath, "utf-8")).toBe(okBefore);
		expect(readFileSync(badPath, "utf-8")).toBe(badBefore);
	});

	it("rejects a malformed batch manifest before touching any files", () => {
		const manifest = resolve(fixtureDir, "malformed.json");
		writeFileSync(manifest, "{ not-json");
		const res = runCli(["write", "--batch", manifest]);
		expect(res.status).not.toBe(0);
		expect(res.stderr).toMatch(/not valid JSON|interlinked write/);
	});

	it("emits JSON output when --json is set", () => {
		const target = resolve(fixtureDir, "json_mode.ts");
		const content = "export const y: number = 2;\n";
		const res = runCli(["write", target, "--stdin", "--json"], { stdin: content });
		expect(res.status).toBe(0);
		const parsed = JSON.parse(res.stdout);
		expect(parsed.ok).toBe(true);
		expect(parsed.wrote).toContain(target);
	});
});

// ───────────────────────────────────────────────────────────────
// Regression: the Bash pre_block rule ALLOWS `interlinked write`
// and still blocks naive `node -e 'fs.writeFileSync(...)'`.
// ───────────────────────────────────────────────────────────────
describe("detectBashCodeFileWrite allowlist for interlinked write", async () => {
	const { detectBashCodeFileWrite } = await import("../harness/pre-checks.js");

	it("allows `interlinked write` through unconditionally", () => {
		expect(
			detectBashCodeFileWrite("interlinked write src/foo.ts --from-file /tmp/newcontent.ts"),
		).toBeNull();
		expect(
			detectBashCodeFileWrite("cat newcontent.ts | interlinked write src/foo.ts --stdin"),
		).toBeNull();
		expect(detectBashCodeFileWrite("interlinked write --batch /tmp/manifest.json")).toBeNull();
	});

	it("still blocks naive `node -e fs.writeFileSync(...)` to code paths", () => {
		const hit = detectBashCodeFileWrite(
			`node -e "require('fs').writeFileSync('src/app.ts', 'const x = 1;')"`,
		);
		expect(hit).not.toBeNull();
		expect(hit?.target).toBe("src/app.ts");
	});

	it("still blocks `cat > file.ts` heredocs", () => {
		const hit = detectBashCodeFileWrite("cat > src/foo.ts << 'EOF'\nconst x = 1;\nEOF");
		expect(hit).not.toBeNull();
		expect(hit?.target).toBe("src/foo.ts");
	});
});

// Sanity — confirm the CLI entry compiles (caught at runtime only). We do
// this once per suite via a lightweight `--help` call.
describe("interlinked write — command wiring", () => {
	it("appears in the CLI help output", () => {
		const output = execSync(`npx tsx ${CLI_ENTRY} --help`, {
			cwd: CLI_ROOT,
			encoding: "utf-8",
		});
		expect(output).toContain("write");
	}, 60_000);
});
