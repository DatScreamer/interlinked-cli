// ===========================================
// multi-edit — unit + integration tests
// ===========================================
//
// Covers:
//   1. Unit — ambiguity rule: an edit whose `old_string` is unique in the
//      ORIGINAL but appears 2+ times after a prior edit fails with
//      AMBIGUOUS_OLD_STRING.
//   2. Unit — post-prior-edit resolution: an edit whose `old_string` is
//      ABSENT from the original but produced by a prior edit resolves
//      cleanly (this is what serial Edits cannot express).
//   3. Integration — Case A (Gemini in CLIENT_INSTALL_REGISTRY): import
//      plus registry entry land together; diff-overlay passes because the
//      gate only runs ONCE on the final content.
//   4. Integration — Case B (FROZEN_NOW + multiple Date.now() sites): one
//      const + four use-site replacements land atomically.
//   5. Integration — a manifest that deliberately introduces a type error
//      in the final content fails with GATE_REJECTED and leaves files
//      untouched.
//   6. Manifest parsing edge cases (shape guards, error codes, etc.).
//
// The integration tests exercise real biome + tsc diff-overlays via the
// existing fixtures pattern used in harness/__tests__/diff-overlay.test.ts
// — the fixtures are written inside cli/src/lib/ so biome/tsc config scope
// picks them up.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearTscOverlayCache } from "../../harness/check-engine/tool-runners/tsc-overlay.js";
import {
	applyEditsToBuffer,
	countOccurrences,
	type EditBatch,
	type EditPair,
	gateProposedContentInline,
	isTscFindingBlocking,
	MULTI_EDIT_ERROR_CODES,
	type MultiEditResult,
	type NormalizeResult,
	normalizeManifest,
	runMultiEdit,
} from "../multi-edit.js";

// ───────────────────────────────────────────────
// Test utilities — refine + return the narrowed result so tests remain
// assertion-only (no `if` branches inside it() blocks). Each helper still
// calls expect() internally for primary shape-level assertion; test bodies
// also perform at least one local expect() so that the `assertion_free_test`
// check can verify the body directly rather than chasing helpers.
// ───────────────────────────────────────────────

function applyAndExpectOk(original: string, edits: EditPair[]): string {
	const result = applyEditsToBuffer(original, edits);
	expect(result.ok).toBe(true);
	// Cast is safe because `expect(ok).toBe(true)` above throws on the
	// failure branch; vitest's matchers abort the test before we reach
	// this line if `result.ok` was false.
	return (result as { ok: true; content: string }).content;
}

function applyAndExpectFail(
	original: string,
	edits: EditPair[],
): { code: string; index: number; matches: number } {
	const result = applyEditsToBuffer(original, edits);
	expect(result.ok).toBe(false);
	const fail = result as { ok: false; code: string; index: number; matches: number };
	return { code: fail.code, index: fail.index, matches: fail.matches };
}

function normalizeAndExpectOk(raw: unknown, singleFilePath?: string): EditBatch[] {
	const result = normalizeManifest(raw, singleFilePath);
	expect(result.ok).toBe(true);
	return (result as { ok: true; batches: EditBatch[] }).batches;
}

function normalizeAndExpectFail(raw: unknown, singleFilePath?: string): string {
	const result: NormalizeResult = normalizeManifest(raw, singleFilePath);
	expect(result.ok).toBe(false);
	return (result as { ok: false; message: string }).message;
}

function runAndExpectOk(batches: EditBatch[]): MultiEditResult {
	const result = runMultiEdit(batches);
	expect(result.ok).toBe(true);
	expect(result.error_code).toBeUndefined();
	return result;
}

function runAndExpectFail(batches: EditBatch[], code: string): MultiEditResult {
	const result = runMultiEdit(batches);
	expect(result.ok).toBe(false);
	expect(result.error_code).toBe(code);
	return result;
}

// ───────────────────────────────────────────────
// Unit — countOccurrences
// ───────────────────────────────────────────────

describe("countOccurrences", () => {
	it("returns 0 for empty needle", () => {
		expect(countOccurrences("abcdef", "")).toBe(0);
	});
	it("returns 0 when needle is absent", () => {
		expect(countOccurrences("abcdef", "xyz")).toBe(0);
	});
	it("returns 1 for a unique match", () => {
		expect(countOccurrences("abcdef", "cd")).toBe(1);
	});
	it("counts overlapping matches using non-overlapping semantics", () => {
		// indexOf(..., start + needle.length) advances past the match — the
		// multi-edit ambiguity rule cares about distinct, non-overlapping
		// occurrences. "aaaa" with "aa" → 2 non-overlapping matches.
		expect(countOccurrences("aaaa", "aa")).toBe(2);
	});
	it("counts multiple matches spread through the string", () => {
		expect(countOccurrences("foo bar foo baz foo", "foo")).toBe(3);
	});
});

// ───────────────────────────────────────────────
// Unit — applyEditsToBuffer (the core ambiguity rules)
// ───────────────────────────────────────────────

describe("applyEditsToBuffer", () => {
	it("applies a single edit to a unique match", () => {
		const content = applyAndExpectOk("const x = 1;\nconst y = 2;\n", [
			{ old_string: "const x = 1;", new_string: "const x = 42;" },
		]);
		expect(content).toBe("const x = 42;\nconst y = 2;\n");
	});

	it("applies edits in order", () => {
		const content = applyAndExpectOk("a\nb\nc\n", [
			{ old_string: "a", new_string: "A" },
			{ old_string: "b", new_string: "B" },
			{ old_string: "c", new_string: "C" },
		]);
		expect(content).toBe("A\nB\nC\n");
	});

	it("fails with OLD_STRING_NOT_FOUND when a needle is absent", () => {
		const fail = applyAndExpectFail("hello", [{ old_string: "world", new_string: "earth" }]);
		expect(fail.code).toBe(MULTI_EDIT_ERROR_CODES.OLD_STRING_NOT_FOUND);
		expect(fail.index).toBe(0);
		expect(fail.matches).toBe(0);
	});

	it("fails with AMBIGUOUS_OLD_STRING when a needle appears 2+ times in the original", () => {
		const fail = applyAndExpectFail("foo foo foo", [{ old_string: "foo", new_string: "bar" }]);
		expect(fail.code).toBe(MULTI_EDIT_ERROR_CODES.AMBIGUOUS_OLD_STRING);
		expect(fail.matches).toBe(3);
	});

	// ───────── The core ambiguity rule ─────────

	it(
		"AMBIGUITY RULE: a second edit whose old_string was unique in the ORIGINAL " +
			"but appears TWICE after the first edit fails with AMBIGUOUS_OLD_STRING",
		() => {
			// Original has "foo" exactly once. First edit duplicates it by
			// replacing "bar" with "foo". Second edit's old_string is "foo"
			// — unique in the pristine original, but now ambiguous in the
			// post-first-edit buffer. Per the design doc, ambiguity is
			// evaluated AFTER prior edits in the manifest.
			const fail = applyAndExpectFail("foo\nbar\n", [
				{ old_string: "bar", new_string: "foo" }, // now two "foo"s
				{ old_string: "foo", new_string: "baz" }, // AMBIGUOUS against current buffer
			]);
			expect(fail.code).toBe(MULTI_EDIT_ERROR_CODES.AMBIGUOUS_OLD_STRING);
			expect(fail.index).toBe(1);
			expect(fail.matches).toBe(2);
		},
	);

	it(
		"POST-PRIOR-EDIT RESOLUTION: a second edit whose old_string was ABSENT " +
			"from the original but PRODUCED by a prior edit resolves correctly",
		() => {
			// "FROZEN_NOW" doesn't exist in the original. The first edit
			// introduces the declaration; the second edit targets the
			// FROZEN_NOW identifier which now exists exactly once. Serial
			// single-Edit calls cannot express this because Edit's
			// ambiguity check runs on the pre-edit file — for edit 2,
			// FROZEN_NOW would not exist at all. MultiEdit lets edit 2
			// target text produced by edit 1.
			const original = 'import { describe } from "vitest";\n\nDate.now();\n';
			const content = applyAndExpectOk(original, [
				{
					old_string: 'import { describe } from "vitest";',
					new_string:
						'import { describe } from "vitest";\n\nconst FROZEN_NOW = 1767225600000;',
				},
				{
					// Was not in the pristine file — introduced by edit 0.
					old_string: "Date.now();",
					new_string: "FROZEN_NOW;",
				},
			]);
			expect(content).toContain("const FROZEN_NOW = 1767225600000;");
			expect(content).toContain("FROZEN_NOW;");
			expect(content).not.toContain("Date.now();");
		},
	);
});

// ───────────────────────────────────────────────
// Unit — normalizeManifest
// ───────────────────────────────────────────────

describe("normalizeManifest", () => {
	it("accepts a single-file manifest with a positional path", () => {
		const batches = normalizeAndExpectOk(
			{ version: 1, edits: [{ old_string: "a", new_string: "b" }] },
			"/tmp/foo.ts",
		);
		expect(batches).toHaveLength(1);
		expect(batches[0].path).toBe("/tmp/foo.ts");
	});

	it("rejects single-file manifest without a path argument", () => {
		const msg = normalizeAndExpectFail({
			version: 1,
			edits: [{ old_string: "a", new_string: "b" }],
		});
		expect(msg).toMatch(/requires a path argument/);
	});

	it("accepts a multi-file manifest with batches", () => {
		const batches = normalizeAndExpectOk({
			version: 1,
			batches: [
				{ path: "a.ts", edits: [{ old_string: "x", new_string: "y" }] },
				{ path: "b.ts", edits: [{ old_string: "p", new_string: "q" }] },
			],
		});
		expect(batches).toHaveLength(2);
		expect(batches[1].path).toBe("b.ts");
	});

	it("rejects multi-file manifest combined with a positional path", () => {
		const msg = normalizeAndExpectFail(
			{
				version: 1,
				batches: [{ path: "a.ts", edits: [{ old_string: "x", new_string: "y" }] }],
			},
			"/tmp/foo.ts",
		);
		expect(msg).toMatch(/Cannot pass a positional path/);
	});

	it("rejects manifests with version != 1", () => {
		const msg = normalizeAndExpectFail({ version: 2, edits: [] }, "/tmp/x.ts");
		expect(msg).toMatch(/version/);
	});

	it("rejects null root", () => {
		const msg = normalizeAndExpectFail(null);
		expect(msg).toMatch(/JSON object/);
	});
	it("rejects string root", () => {
		const msg = normalizeAndExpectFail("not an object");
		expect(msg).toMatch(/JSON object/);
	});
	it("rejects number root", () => {
		const msg = normalizeAndExpectFail(42);
		expect(msg).toMatch(/JSON object/);
	});

	it("rejects manifests with neither `edits` nor `batches`", () => {
		const msg = normalizeAndExpectFail({ version: 1 });
		expect(msg).toMatch(/edits.*batches|batches.*edits/);
	});

	it("rejects edits with empty old_string", () => {
		const msg = normalizeAndExpectFail(
			{ version: 1, edits: [{ old_string: "", new_string: "x" }] },
			"/tmp/foo.ts",
		);
		expect(msg).toMatch(/old_string must not be empty/);
	});

	it("rejects no-op edits (old_string === new_string)", () => {
		const msg = normalizeAndExpectFail(
			{ version: 1, edits: [{ old_string: "a", new_string: "a" }] },
			"/tmp/foo.ts",
		);
		expect(msg).toMatch(/identical/);
	});

	it("rejects batches with non-string path", () => {
		const msg = normalizeAndExpectFail({
			version: 1,
			batches: [{ path: 42, edits: [{ old_string: "a", new_string: "b" }] }],
		});
		expect(msg).toMatch(/Batch 0 must have/);
	});

	it("rejects empty edits arrays", () => {
		const msg = normalizeAndExpectFail({ version: 1, edits: [] }, "/tmp/foo.ts");
		expect(msg).toMatch(/at least one edit/i);
	});
});

// ───────────────────────────────────────────────
// Unit — gate reuse (isTscFindingBlocking)
// ───────────────────────────────────────────────

describe("isTscFindingBlocking (re-exported)", () => {
	it("classifies TS2322 as blocking", () => {
		expect(
			isTscFindingBlocking({
				tool: "tsc",
				severity: "error",
				file: "x.ts",
				line: 1,
				message: "Type error.",
				ruleId: "TS2322",
			}),
		).toBe(true);
	});
	it("classifies TS6133 (unused) as warn-only", () => {
		expect(
			isTscFindingBlocking({
				tool: "tsc",
				severity: "error",
				file: "x.ts",
				line: 1,
				message: "unused",
				ruleId: "TS6133",
			}),
		).toBe(false);
	});
});

// ───────────────────────────────────────────────
// Integration fixtures
// ───────────────────────────────────────────────
// Write fixtures inside cli/src/lib/ so biome + tsc config scope picks them
// up, matching the existing diff-overlay test pattern.
//
// Cleanup story (belt-and-suspenders so the working tree never leaks a
// fixture into git status / the harness fixture-leak detector):
//   1. Per-describe `afterAll(rmFixture)` — the happy path.
//   2. Module-level `afterAll` — runs at file-scope, after all describes.
//      Catches the case where a per-describe afterAll threw mid-cleanup.
//   3. `process.on('exit')` handler — runs even when vitest's worker is
//      hard-killed (SIGTERM under CI worker-cap pressure, tsc cold-start
//      timeout, uncaught throw in a sibling test). Synchronous-only.
//   4. Module-level `beforeAll` sweep — wipes stale fixtures from a
//      prior crashed run before the current run starts writing.

const CLI_ROOT = resolve(import.meta.dirname, "../..", "..");
const FIXTURE_DIR = resolve(CLI_ROOT, "src", "lib");

// Filenames the suite is allowed to sweep at startup. Anchored as a Set so
// the stale-fixture sweep can't accidentally wipe a hand-written `_*.ts`
// module that happens to live in src/lib/. Add to this when a new fixture
// is introduced.
const KNOWN_FIXTURE_BASENAMES: ReadonlySet<string> = new Set([
	"_multi_edit_case_a.ts",
	"_multi_edit_case_b.ts",
	"_multi_edit_gate_fail.ts",
	"_gate_inline_fixture.ts",
	"_multi_edit_plumbing_a.ts",
	"_multi_edit_plumbing_b.ts",
]);

// Module-level registry. `writeFixture` adds, `rmFixture` removes on
// successful (or ENOENT) cleanup. The process-exit handler iterates
// whatever is still pending.
const registeredFixtures = new Set<string>();

function fixturePath(name: string): string {
	return resolve(FIXTURE_DIR, name);
}

function writeFixture(name: string, content: string): string {
	mkdirSync(FIXTURE_DIR, { recursive: true });
	const p = fixturePath(name);
	writeFileSync(p, content, "utf-8");
	registeredFixtures.add(p);
	return p;
}

function rmFixture(p: string): void {
	try {
		rmSync(p);
		registeredFixtures.delete(p);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("ENOENT")) {
			// Already gone — drop from registry so we don't retry.
			registeredFixtures.delete(p);
			return;
		}
		// Surface a genuine I/O failure (permission denied etc.) but leave
		// the entry in the registry so the process-exit handler retries.
		console.error(`[multi-edit.test] cleanup warning for ${p}: ${msg}`);
	}
}

// Synchronous backstop — fires even if the vitest worker is hard-killed
// or a sibling describe's afterAll throws. Uses `force: true` so a missing
// file doesn't propagate as an exit-handler error.
process.on("exit", () => {
	for (const p of registeredFixtures) {
		try {
			rmSync(p, { force: true });
		} catch {
			// intentional: process is exiting; nothing useful to do.
		}
	}
});

// Pre-suite sweep: any stale fixture left by a prior crashed run gets
// removed before the current suite writes its own copy. Constrained to
// KNOWN_FIXTURE_BASENAMES so a legitimate `_*.ts` module never gets
// touched.
beforeAll(() => {
	for (const name of KNOWN_FIXTURE_BASENAMES) {
		const stale = resolve(FIXTURE_DIR, name);
		try {
			rmSync(stale, { force: true });
		} catch {
			// intentional: best-effort sweep.
		}
	}
});

// Post-suite belt: per-describe afterAll covers the happy path; this
// catches anything that slipped (a thrown rmFixture, a path mismatch
// between the describe's `let fixturePathAbs` and what writeFixture
// actually returned, etc.).
afterAll(() => {
	for (const p of [...registeredFixtures]) {
		try {
			rmSync(p, { force: true });
			registeredFixtures.delete(p);
		} catch (err) {
			console.error(
				`[multi-edit.test] post-suite cleanup failed for ${p}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
});

// ───────────────────────────────────────────────
// Integration — Case A: Gemini in CLIENT_INSTALL_REGISTRY
// ───────────────────────────────────────────────
// An import + a use-site in a typed Record. Serial Edits trip biome
// (noUnusedImports after the import alone) AND tsc (TS2304 when the
// registry entry references identifiers not yet imported). MultiEdit lands
// both atomically.

describe("Integration — Case A: Gemini in CLIENT_INSTALL_REGISTRY", () => {
	const FIXTURE = "_multi_edit_case_a.ts";
	let fixturePathAbs = "";

	const INITIAL_CONTENT = [
		"// Case A fixture — CLIENT_INSTALL_REGISTRY",
		'type ClientName = "claude" | "copilot";',
		"interface ClientInstallEntry {",
		"\tevents: readonly string[];",
		"\tinstall: (root: string) => void;",
		"\tuninstall: (root: string) => void;",
		"}",
		"",
		'import { buildHookScript } from "./hooks-template.js";',
		"",
		"export const CLIENT_INSTALL_REGISTRY: Record<ClientName, ClientInstallEntry> = {",
		"\tclaude: {",
		'\t\tevents: ["PreToolUse", "PostToolUse"],',
		"\t\tinstall: () => {},",
		"\t\tuninstall: () => {},",
		"\t},",
		"\tcopilot: {",
		'\t\tevents: ["PreToolUse"],',
		"\t\tinstall: () => {},",
		"\t\tuninstall: () => {},",
		"\t},",
		"\t// Future clients:",
		"};",
		"",
		"export { buildHookScript };",
		"",
	].join("\n");

	beforeAll(() => {
		// buildHookScript exists in cli/src/lib/hooks-template.ts so the
		// initial fixture type-checks cleanly under the CLI's tsconfig.
		fixturePathAbs = writeFixture(FIXTURE, INITIAL_CONTENT);
		clearTscOverlayCache(CLI_ROOT);
	});

	afterAll(() => {
		rmFixture(fixturePathAbs);
		clearTscOverlayCache(CLI_ROOT);
	});

	it("round-trip: adding gemini import + registry entry lands together via multi-edit", () => {
		// Simulate the design-doc's Case A edit: edit 0 injects three
		// const helpers (stand-ins for imports from the design-doc's
		// ./hook-installers.js — we inline so the fixture doesn't
		// require an external module). Edit 1 widens ClientName. Edit 2
		// adds the gemini entry using identifiers declared by edit 0.
		// Each edit in isolation is a net-new tsc or biome error; the
		// gate only sees the final composed content.
		const edits: EditPair[] = [
			{
				old_string: 'import { buildHookScript } from "./hooks-template.js";',
				new_string: [
					'const GEMINI_HOOK_EVENTS = ["PreToolUse"] as const;',
					"const installGeminiHooks = (_: string) => {};",
					"const uninstallGeminiHooks = (_: string) => {};",
					'import { buildHookScript } from "./hooks-template.js";',
				].join("\n"),
			},
			{
				old_string: 'type ClientName = "claude" | "copilot";',
				new_string: 'type ClientName = "claude" | "copilot" | "gemini";',
			},
			{
				old_string: "\t// Future clients:",
				new_string: [
					"\tgemini: {",
					"\t\tevents: GEMINI_HOOK_EVENTS,",
					"\t\tinstall: installGeminiHooks,",
					"\t\tuninstall: uninstallGeminiHooks,",
					"\t},",
					"\t// Future clients:",
				].join("\n"),
			},
		];

		const batches: EditBatch[] = [{ path: fixturePathAbs, edits }];
		const result = runAndExpectOk(batches);
		expect(result.file_changes_applied).toEqual([fixturePathAbs]);

		const after = readFileSync(fixturePathAbs, "utf-8");
		expect(after).toContain('"claude" | "copilot" | "gemini"');
		expect(after).toContain("GEMINI_HOOK_EVENTS");
		expect(after).toContain("installGeminiHooks");
	}, 20_000);
});

// ───────────────────────────────────────────────
// Integration — Case B: FROZEN_NOW + multiple Date.now() sites
// ───────────────────────────────────────────────
// One const declaration + multiple use-site replacements. Each Date.now()
// replacement on its own trips tsc (TS2304) until the const is declared.
// MultiEdit lets the const land first in the buffer, then all use sites.

describe("Integration — Case B: FROZEN_NOW constant + Date.now() replacements", () => {
	const FIXTURE = "_multi_edit_case_b.ts";
	let fixturePathAbs = "";

	const INITIAL_CONTENT = [
		"// Case B fixture — before FROZEN_NOW",
		"export function ageThreshold(): number {",
		"\treturn Date.now() - 30 * 24 * 60 * 60 * 1000;",
		"}",
		"",
		"export function oneMinuteAgo(): number {",
		"\treturn Date.now() - 60 * 1000;",
		"}",
		"",
		"export function oneHourAgo(): number {",
		"\treturn Date.now() - 60 * 60 * 1000;",
		"}",
		"",
		"export function oneDayAgo(): number {",
		"\treturn Date.now() - 25 * 60 * 60 * 1000;",
		"}",
		"",
	].join("\n");

	beforeAll(() => {
		fixturePathAbs = writeFixture(FIXTURE, INITIAL_CONTENT);
		clearTscOverlayCache(CLI_ROOT);
	});

	afterAll(() => {
		rmFixture(fixturePathAbs);
		clearTscOverlayCache(CLI_ROOT);
	});

	it("round-trip: FROZEN_NOW declaration + 4 replacements land together via multi-edit", () => {
		const edits: EditPair[] = [
			{
				// Inject the FROZEN_NOW const declaration at the top.
				// Without this, every Date.now() replacement below
				// would be TS2304.
				old_string: "// Case B fixture — before FROZEN_NOW",
				new_string: [
					"// Case B fixture — with FROZEN_NOW",
					"const FROZEN_NOW = 1767225600000;",
				].join("\n"),
			},
			{
				old_string: "Date.now() - 30 * 24 * 60 * 60 * 1000",
				new_string: "FROZEN_NOW - 30 * 24 * 60 * 60 * 1000",
			},
			{
				old_string: "Date.now() - 60 * 1000",
				new_string: "FROZEN_NOW - 60 * 1000",
			},
			{
				old_string: "Date.now() - 60 * 60 * 1000",
				new_string: "FROZEN_NOW - 60 * 60 * 1000",
			},
			{
				old_string: "Date.now() - 25 * 60 * 60 * 1000",
				new_string: "FROZEN_NOW - 25 * 60 * 60 * 1000",
			},
		];

		const batches: EditBatch[] = [{ path: fixturePathAbs, edits }];
		const result = runAndExpectOk(batches);
		expect(result.file_changes_applied).toEqual([fixturePathAbs]);

		const after = readFileSync(fixturePathAbs, "utf-8");
		expect(after).toContain("const FROZEN_NOW = 1767225600000;");
		expect(after).not.toContain("Date.now()");
		// Four replacements — exactly four FROZEN_NOW use sites.
		expect(countOccurrences(after, "FROZEN_NOW -")).toBe(4);
	}, 20_000);
});

// ───────────────────────────────────────────────
// Integration — GATE_REJECTED leaves files untouched
// ───────────────────────────────────────────────

describe("Integration — GATE_REJECTED: final content fails tsc, files untouched", () => {
	const FIXTURE = "_multi_edit_gate_fail.ts";
	let fixturePathAbs = "";

	const INITIAL_CONTENT = [
		"// Gate-fail fixture",
		"export function identity<T>(x: T): T {",
		"\treturn x;",
		"}",
		"",
	].join("\n");

	beforeAll(() => {
		fixturePathAbs = writeFixture(FIXTURE, INITIAL_CONTENT);
		clearTscOverlayCache(CLI_ROOT);
	});

	afterAll(() => {
		rmFixture(fixturePathAbs);
		clearTscOverlayCache(CLI_ROOT);
	});

	it("rejects a manifest whose final content introduces a new TS error; file is unchanged", () => {
		const priorOnDisk = readFileSync(fixturePathAbs, "utf-8");
		const edits: EditPair[] = [
			{
				// Introduce a brand-new type error (TS2322) in the final
				// content. Even though the edit composes correctly as
				// text, the content gate blocks it because tsc sees a
				// number/string mismatch that didn't exist before.
				old_string: "return x;",
				new_string: "const _bad: number = 'not a number';\n\treturn x;",
			},
		];

		const batches: EditBatch[] = [{ path: fixturePathAbs, edits }];
		const result = runAndExpectFail(batches, MULTI_EDIT_ERROR_CODES.GATE_REJECTED);
		expect(result.file_changes_applied).toEqual([]);
		expect(result.gate_failures).toBeDefined();
		expect(result.gate_failures?.length).toBeGreaterThan(0);

		// Confirm the failure mentions tsc TS2322.
		const ts2322 = result.gate_failures?.find((f) => f.code === "TS2322");
		expect(ts2322).toBeDefined();

		// File content on disk must match what we had before.
		const afterOnDisk = readFileSync(fixturePathAbs, "utf-8");
		expect(afterOnDisk).toBe(priorOnDisk);
	}, 20_000);
});

// ───────────────────────────────────────────────
// Integration — gateProposedContentInline smoke test
// ───────────────────────────────────────────────
// Ensures the gate helper actually calls into diff-overlay and returns
// failures in the design-doc shape, independently of runMultiEdit.

describe("gateProposedContentInline", () => {
	const FIXTURE = "_gate_inline_fixture.ts";
	let fixturePathAbs = "";

	beforeAll(() => {
		fixturePathAbs = writeFixture(
			FIXTURE,
			"export function identity<T>(x: T): T {\n\treturn x;\n}\n",
		);
		clearTscOverlayCache(CLI_ROOT);
	});
	afterAll(() => {
		rmFixture(fixturePathAbs);
		clearTscOverlayCache(CLI_ROOT);
	});

	it("returns empty when proposed content is identical to disk", () => {
		const onDisk = readFileSync(fixturePathAbs, "utf-8");
		const failures = gateProposedContentInline([{ path: fixturePathAbs, content: onDisk }]);
		expect(failures).toEqual([]);
	});

	it("returns failures when proposed content introduces a new type error", () => {
		const onDisk = readFileSync(fixturePathAbs, "utf-8");
		const proposed = `${onDisk}\nconst _bad: number = "x";\n`;
		const failures = gateProposedContentInline([{ path: fixturePathAbs, content: proposed }]);
		expect(failures.length).toBeGreaterThan(0);
		const ts2322 = failures.find((f) => f.code === "TS2322");
		expect(ts2322).toBeDefined();
		expect(ts2322?.path).toBe(fixturePathAbs);
		expect(ts2322?.tool).toBe("tsc");
	});
});

// ───────────────────────────────────────────────
// Unit — runMultiEdit plumbing (read errors, composed-noop, multi-file)
// ───────────────────────────────────────────────

describe("runMultiEdit plumbing", () => {
	const FIXTURE_A = "_multi_edit_plumbing_a.ts";
	const FIXTURE_B = "_multi_edit_plumbing_b.ts";
	const A_INITIAL = 'export const A_VALUE = "alpha";\nexport const A_COPY = A_VALUE;\n';
	const B_INITIAL = 'export const B_VALUE = "beta";\nexport const B_COPY = B_VALUE;\n';
	let pathA = "";
	let pathB = "";

	beforeAll(() => {
		pathA = writeFixture(FIXTURE_A, A_INITIAL);
		pathB = writeFixture(FIXTURE_B, B_INITIAL);
		clearTscOverlayCache(CLI_ROOT);
	});
	afterAll(() => {
		rmFixture(pathA);
		rmFixture(pathB);
		clearTscOverlayCache(CLI_ROOT);
	});

	afterEach(() => {
		// Restore initial content between cases so tests are independent.
		writeFileSync(pathA, A_INITIAL, "utf-8");
		writeFileSync(pathB, B_INITIAL, "utf-8");
	});

	it("returns READ_FAILED for a nonexistent path", () => {
		const result = runAndExpectFail(
			[
				{
					path: "/tmp/this-does-not-exist-multiedit-fixture.ts",
					edits: [{ old_string: "a", new_string: "b" }],
				},
			],
			MULTI_EDIT_ERROR_CODES.READ_FAILED,
		);
		expect(result.error_detail?.path).toMatch(/this-does-not-exist-multiedit-fixture/);
	});

	it("returns OLD_STRING_NOT_FOUND when a needle is absent", () => {
		const result = runAndExpectFail(
			[{ path: pathA, edits: [{ old_string: "NOT_HERE", new_string: "x" }] }],
			MULTI_EDIT_ERROR_CODES.OLD_STRING_NOT_FOUND,
		);
		expect(result.error_detail?.edit_index).toBe(0);
	});

	it("returns AMBIGUOUS_OLD_STRING when a needle appears twice", () => {
		// "A_VALUE" appears in both the declaration and the use site.
		const result = runAndExpectFail(
			[
				{
					path: pathA,
					edits: [{ old_string: "A_VALUE", new_string: "A_RENAMED" }],
				},
			],
			MULTI_EDIT_ERROR_CODES.AMBIGUOUS_OLD_STRING,
		);
		expect(result.error_detail?.match_count).toBe(2);
	});

	it("multi-file: edits to two files land atomically when both pass the gate", () => {
		const result = runAndExpectOk([
			{
				path: pathA,
				edits: [
					{
						old_string: 'export const A_VALUE = "alpha";',
						new_string: 'export const A_VALUE = "alpha-2";',
					},
				],
			},
			{
				path: pathB,
				edits: [
					{
						old_string: 'export const B_VALUE = "beta";',
						new_string: 'export const B_VALUE = "beta-2";',
					},
				],
			},
		]);
		expect(result.file_changes_applied).toEqual([pathA, pathB]);
		expect(readFileSync(pathA, "utf-8")).toContain('"alpha-2"');
		expect(readFileSync(pathB, "utf-8")).toContain('"beta-2"');
	}, 20_000);

	it("no-op composition leaves files untouched and reports success with empty applied list", () => {
		const priorA = readFileSync(pathA, "utf-8");
		const result = runAndExpectOk([
			{
				path: pathA,
				edits: [
					// alpha → gamma → alpha: the composition is a no-op, so
					// nothing should be written and the command reports
					// success with zero file_changes_applied.
					{ old_string: '"alpha"', new_string: '"gamma"' },
					{ old_string: '"gamma"', new_string: '"alpha"' },
				],
			},
		]);
		expect(result.file_changes_applied).toEqual([]);
		expect(readFileSync(pathA, "utf-8")).toBe(priorA);
	});
});
