// Regression test for runTscOverlay's sibling-overlay support: a transactional
// multi-file edit must resolve cross-file references against the proposed
// COMBINED state, not stale disk. This pins the fix that lets `interlinked
// multi-edit` land coordinated refactors (new exports / shared types) in one
// atomic batch instead of rejecting every transiently-broken single file.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearTscOverlayCache, runTscOverlay } from "./tsc-overlay.js";

const created: string[] = [];

function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-sib-"));
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
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

afterEach(() => {
	for (const dir of created.splice(0)) {
		clearTscOverlayCache(dir);
		rmSync(dir, { recursive: true, force: true });
	}
});

// `a.ts` imports `foo` from `./b.js`; on disk `b.ts` does NOT export `foo`, so
// the import is broken against disk — the exact shape of a coordinated refactor
// where the symbol's definition lives in a sibling batch member.
const A = "import { foo } from './b.js';\nexport const bar: number = foo;\n";
const B_ON_DISK = "export const baz = 1;\n";
const B_WITH_FOO = "export const foo = 1;\nexport const baz = 1;\n";

describe("runTscOverlay — sibling overlays (proposed combined state)", () => {
	it(
		"resolves a cross-file symbol provided by a sibling's PROPOSED content",
		() => {
			const dir = project({ "a.ts": A, "b.ts": B_ON_DISK });
			const out = runTscOverlay({
				projectRoot: dir,
				filePath: join(dir, "a.ts"),
				content: A,
				siblings: [{ filePath: join(dir, "b.ts"), content: B_WITH_FOO }],
			});
			// The sibling supplies `foo`, so the import resolves — no missing-member error.
			expect(out.some((r) => r.ruleId === "TS2305")).toBe(false);
		},
		60_000,
	);

	it(
		"WITHOUT the sibling overlay, the same edit fails to resolve (the bug A fixes)",
		() => {
			const dir = project({ "a.ts": A, "b.ts": B_ON_DISK });
			const out = runTscOverlay({
				projectRoot: dir,
				filePath: join(dir, "a.ts"),
				content: A,
			});
			// Disk `b.ts` has no `foo` → per-file-against-disk surfaces TS2305.
			expect(out.some((r) => r.ruleId === "TS2305")).toBe(true);
		},
		60_000,
	);

	it(
		"a sibling whose path equals the target is ignored (target overlay wins)",
		() => {
			const dir = project({ "a.ts": A, "b.ts": B_WITH_FOO });
			const out = runTscOverlay({
				projectRoot: dir,
				filePath: join(dir, "a.ts"),
				content: A,
				// A self-referential sibling must not clobber the target's own overlay.
				siblings: [{ filePath: join(dir, "a.ts"), content: "export const wrong = 1;\n" }],
			});
			expect(out.some((r) => r.ruleId === "TS2305")).toBe(false);
		},
		60_000,
	);
});
