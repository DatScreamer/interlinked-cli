import { describe, expect, it } from "vitest";
import { seedFileBaseline } from "./adopt.js";
import { acceptedSurvivors, emptyManifest } from "./manifest.js";
import type { MutationManifest } from "./types.js";

const FILE = "src/a.ts";
const CONTENT = "export function f(x: number): boolean {\n\treturn x > 0;\n}\n";
const META = {
	engine: "stryker",
	engineVersion: "1",
	dependencyGraphVersion: "g",
	environmentHash: "e",
	authoritativeAt: "t0",
};

/** Assert a baseline was produced. Fails the test with a readable message rather
 *  than casting a possible null into the type system and crashing downstream. */
function must(m: MutationManifest | null): MutationManifest {
	if (m === null) throw new Error("expected a seeded manifest, got null");
	return m;
}

/** A Stryker report for CONTENT with one survivor at the `>`. */
function report(status: string) {
	// Column is LINE-relative and 1-based. Deriving it from the line (rather than
	// a global string offset, which is what I got wrong first) keeps the fixture
	// pointing at the `>` even if the source above it changes.
	const line2 = CONTENT.split("\n")[1] ?? "";
	const col = line2.indexOf(">") + 1;
	return {
		files: {
			[FILE]: {
				source: CONTENT,
				mutants: [
					{
						mutatorName: "EqualityOperator",
						replacement: ">=",
						status,
						location: { start: { line: 2, column: col }, end: { line: 2, column: col + 1 } },
					},
				],
			},
		},
	};
}

describe("seedFileBaseline — brownfield adoption", () => {
	it("records a pre-existing survivor as an ACCEPTED baseline", () => {
		// The whole point: on legacy code most files are dirty. The per-edit gate
		// refuses to persist a dirty run (correctly — that would let an agent
		// launder a survivor it just introduced into the accepted floor). Adoption
		// is the explicit, human-invoked path that establishes the floor ONCE, so
		// the ratchet has something to ratchet against.
		const seeded = seedFileBaseline({
			base: emptyManifest(META),
			file: FILE,
			content: CONTENT,
			report: report("Survived"),
			at: "2026-07-28T00:00:00Z",
		});
		expect(seeded).not.toBeNull();
		expect(acceptedSurvivors(must(seeded), FILE).size).toBe(1);
	});

	it("makes that survivor stop counting as new", () => {
		// The behavioural consequence — this is what lets enforcement be turned on
		// for a brownfield repo without blocking every edit on day one.
		const seeded = seedFileBaseline({
			base: emptyManifest(META),
			file: FILE,
			content: CONTENT,
			report: report("Survived"),
			at: "2026-07-28T00:00:00Z",
		});
		const accepted = acceptedSurvivors(must(seeded), FILE);
		expect([...accepted]).toHaveLength(1);
	});

	it("records a killed mutant without marking it accepted", () => {
		const seeded = seedFileBaseline({
			base: emptyManifest(META),
			file: FILE,
			content: CONTENT,
			report: report("Killed"),
			at: "2026-07-28T00:00:00Z",
		});
		expect(acceptedSurvivors(must(seeded), FILE).size).toBe(0);
	});

	it("returns null for an unrecognisable report rather than an empty baseline", () => {
		// An empty baseline is WORSE than none: it would claim the file is measured
		// and clean, so a real survivor introduced later would read as accepted.
		expect(
			seedFileBaseline({
				base: emptyManifest(META),
				file: FILE,
				content: CONTENT,
				report: { nonsense: true },
				at: "t",
			}),
		).toBeNull();
	});

	it("returns null when the report names no mutants for this file", () => {
		expect(
			seedFileBaseline({
				base: emptyManifest(META),
				file: FILE,
				content: CONTENT,
				report: { files: {} },
				at: "t",
			}),
		).toBeNull();
	});

	it("preserves baselines for other files already in the manifest", () => {
		const first = seedFileBaseline({
			base: emptyManifest(META),
			file: FILE,
			content: CONTENT,
			report: report("Survived"),
			at: "t",
		});
		const second = seedFileBaseline({
			base: must(first),
			file: "src/b.ts",
			content: CONTENT,
			report: {
				files: { "src/b.ts": { source: CONTENT, mutants: report("Survived").files[FILE]?.mutants } },
			},
			at: "t",
		});
		expect(Object.keys(must(second).files)).toContain(FILE);
		expect(Object.keys(must(second).files)).toContain("src/b.ts");
	});

	// -------------------------------------------------------------------------
	// Key normalization + test-file rejection at the OTHER live write path
	// (spec of the 2026-07-31 fix): unlike the per-edit gate, this entry point
	// has NO test-file filter of its own — it is driven by an operator-supplied
	// file list, not a changeset `isMutationTarget` already screened.
	// -------------------------------------------------------------------------

	it("N: rejects a test-file target upfront — never trusts the report enough to write", () => {
		expect(
			seedFileBaseline({
				base: emptyManifest(META),
				file: "src/a.test.ts",
				content: CONTENT,
				report: report("Survived"),
				at: "t",
			}),
		).toBeNull();
	});

	it("N: rejects a test-file target reached through an absolute path", () => {
		expect(
			seedFileBaseline({
				base: emptyManifest(META),
				file: "/repo/root/src/a.test.ts",
				content: CONTENT,
				report: report("Survived"),
				at: "t",
				cwd: "/repo/root",
			}),
		).toBeNull();
	});

	it("keys an absolute-path adoption under the SAME repo-relative key a relative one would use", () => {
		const seeded = seedFileBaseline({
			base: emptyManifest(META),
			file: "/repo/root/src/a.ts",
			content: CONTENT,
			report: report("Survived"),
			at: "t",
			cwd: "/repo/root",
		});
		expect(Object.keys(must(seeded).files)).toEqual([FILE]);
	});
});
