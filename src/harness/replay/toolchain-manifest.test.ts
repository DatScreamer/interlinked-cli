// T2 toolchain manifest — records the tool versions + lockfile identity a
// sandbox must pin to reproduce tool behavior
// (docs/design/reproducibility/tier2-onpolicy-env.md). Version lookups are
// injectable so tests never spawn.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureToolchainManifest, TOOLCHAIN_TOOLS } from "./toolchain-manifest.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-toolchain-"));
	cleanups.push(dir);
	return dir;
}

describe("captureToolchainManifest", () => {
	it("records node, per-tool versions, and the lockfile sha", () => {
		const cwd = tempCwd();
		writeFileSync(join(cwd, "package-lock.json"), '{"lockfileVersion": 3}');
		const manifest = captureToolchainManifest(cwd, {
			versionOf: (tool) => (tool === "git" ? "git version 2.44.0" : null),
			now: () => "2026-07-24T16:00:00.000Z",
		});
		expect(manifest.schema).toBe("toolchain-manifest.v1");
		expect(manifest.node).toBe(process.version);
		expect(manifest.tools.git).toBe("git version 2.44.0");
		expect(manifest.tools.biome).toBeNull();
		expect(manifest.lockfile_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(manifest.captured_at).toBe("2026-07-24T16:00:00.000Z");
	});

	it("records a null lockfile sha when no lockfile exists", () => {
		const manifest = captureToolchainManifest(tempCwd(), {
			versionOf: () => null,
			now: () => "t",
		});
		expect(manifest.lockfile_sha256).toBeNull();
		for (const tool of TOOLCHAIN_TOOLS.filter((t) => t !== "node")) {
			expect(manifest.tools[tool]).toBeNull();
		}
		// node is always self-reported by the capturing process, never spawned.
		expect(manifest.tools.node).toBe(process.version);
	});
});
