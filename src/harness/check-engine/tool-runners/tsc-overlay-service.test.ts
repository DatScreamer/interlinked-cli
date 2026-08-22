// Smoke coverage for the extracted LS-construction module. Full behavioral
// coverage (sibling overlays, cross-file resolution, missing-typescript
// degrade) lives in tsc-overlay.test.ts / tsc-overlay.no-typescript.test.ts,
// which exercise the same code through the dispatcher in "in-process" mode.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearOverlayServiceCache,
	OVERLAY_EXT,
	runOverlayCheckInProcess,
} from "./tsc-overlay-service.js";

const created: string[] = [];

function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-service-"));
	created.push(dir);
	mkdirSync(dir, { recursive: true });
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
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

afterEach(() => {
	for (const dir of created.splice(0)) {
		clearOverlayServiceCache(dir);
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("tsc-overlay-service", () => {
	// kind: public-api — positive (must fire)
	it("P1: OVERLAY_EXT matches .ts/.tsx/.mts/.cts", () => {
		expect(OVERLAY_EXT.test("a.ts")).toBe(true);
		expect(OVERLAY_EXT.test("a.tsx")).toBe(true);
		expect(OVERLAY_EXT.test("a.mts")).toBe(true);
		expect(OVERLAY_EXT.test("a.cts")).toBe(true);
	});

	// kind: public-api — negative (must not fire)
	it("N1: OVERLAY_EXT rejects non-TS extensions", () => {
		expect(OVERLAY_EXT.test("a.js")).toBe(false);
		expect(OVERLAY_EXT.test("a.md")).toBe(false);
	});

	// kind: public-api — positive (must fire)
	it("P2: runOverlayCheckInProcess finds a real type error in overlaid content", () => {
		const dir = project({ "a.ts": "export const x: number = 1;\n" });
		const out = runOverlayCheckInProcess({
			projectRoot: dir,
			filePath: join(dir, "a.ts"),
			content: 'export const x: number = "not a number";\n',
		});
		expect(out.some((r) => r.ruleId === "TS2322")).toBe(true);
	});

	// kind: public-api — negative (must not fire)
	it("N2: runOverlayCheckInProcess returns [] for non-TS-overlayable files", () => {
		const dir = project({ "a.ts": "export const x = 1;\n" });
		const out = runOverlayCheckInProcess({
			projectRoot: dir,
			filePath: join(dir, "a.md"),
			content: "# hi\n",
		});
		expect(out).toEqual([]);
	});

	it("clearOverlayServiceCache(projectRoot) and clearOverlayServiceCache() both run without throwing", () => {
		const dir = project({ "a.ts": "export const x = 1;\n" });
		runOverlayCheckInProcess({ projectRoot: dir, filePath: join(dir, "a.ts"), content: "export const x = 1;\n" });
		expect(() => clearOverlayServiceCache(dir)).not.toThrow();
		expect(() => clearOverlayServiceCache()).not.toThrow();
	});
});
