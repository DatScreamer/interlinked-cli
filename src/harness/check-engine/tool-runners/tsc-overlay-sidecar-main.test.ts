// Real-process round trip: spawns the sidecar entry via tsx (dev mode, no
// build step required — CLAUDE.md forbids running `npm run build` from an
// agent session) against a tiny fixture tsconfig project, feeds it one JSON
// request line on stdin, and asserts the JSON response line on stdout.
// Bounded well under the 60s per-file budget (feedback_ci_macos_slow_test_timeout).

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSidecarErrorResponse } from "./tsc-overlay-protocol.js";
import type { SidecarOverlayRequest, SidecarOverlayResponse } from "./tsc-overlay-protocol.js";

const nodeRequire = createRequire(import.meta.url);
const SIDECAR_MAIN_TS = join(__dirname, "tsc-overlay-sidecar-main.ts");
// "tsx/dist/cli.mjs" isn't in tsx's package.json `exports` map, so resolve
// via the one subpath that IS exported ("./package.json") and join from there.
const TSX_CLI = join(dirname(nodeRequire.resolve("tsx/package.json")), "dist/cli.mjs");

const created: string[] = [];

function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-sidecar-main-"));
	created.push(dir);
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				module: "nodenext",
				moduleResolution: "nodenext",
				strict: true,
				noEmit: true,
				skipLibCheck: true,
			},
			include: ["*.ts"],
		}),
	);
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

afterEach(() => {
	for (const dir of created.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function runSidecarOnce(request: SidecarOverlayRequest): SidecarOverlayResponse {
	const result = spawnSync(process.execPath, [TSX_CLI, SIDECAR_MAIN_TS], {
		input: `${JSON.stringify(request)}\n`,
		encoding: "utf-8",
		timeout: 30_000,
	});
	expect(result.error).toBeUndefined();
	const line = result.stdout.trim().split("\n").at(-1) ?? "";
	// SAFETY: the sidecar main entry under test always emits exactly one JSON
	// line matching SidecarOverlayResponse — that contract is what this file
	// verifies, so the parse result is trusted here, not upstream of a test.
	return JSON.parse(line) as SidecarOverlayResponse;
}

describe("tsc-overlay-sidecar-main — real process round trip", () => {
	// kind: public-api — positive (must fire)
	it(
		"P1: answers an overlayCheck request with a real type-error finding",
		() => {
			const dir = project({ "a.ts": "export const x: number = 1;\n" });
			const res = runSidecarOnce({
				id: 1,
				method: "overlayCheck",
				protocolVersion: 1,
				params: {
					projectRoot: dir,
					filePath: join(dir, "a.ts"),
					content: 'export const x: number = "nope";\n',
				},
			});
			expect(isSidecarErrorResponse(res)).toBe(false);
			const result = isSidecarErrorResponse(res) ? [] : res.result;
			expect(result.some((r) => r.ruleId === "TS2322")).toBe(true);
			expect(res.id).toBe(1);
		},
		30_000,
	);

	// kind: public-api — negative (must not fire)
	it(
		"N1: clean overlay content yields an empty result, not an error",
		() => {
			const dir = project({ "a.ts": "export const x: number = 1;\n" });
			const res = runSidecarOnce({
				id: 2,
				method: "overlayCheck",
				protocolVersion: 1,
				params: {
					projectRoot: dir,
					filePath: join(dir, "a.ts"),
					content: "export const x: number = 1;\n",
				},
			});
			expect(isSidecarErrorResponse(res)).toBe(false);
			const result = isSidecarErrorResponse(res) ? [] : res.result;
			expect(result).toEqual([]);
		},
		30_000,
	);
});
