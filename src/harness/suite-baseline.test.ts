import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newFailures, readSuiteBaseline, type SuiteBaseline, writeSuiteBaseline } from "./suite-baseline.js";

function makeBaseline(overrides: Partial<SuiteBaseline> = {}): SuiteBaseline {
	return {
		recorded_at: "2026-07-06T00:00:00.000Z",
		language: "typescript",
		green: false,
		failing_tests: ["a.test.ts > suite > case one", "b.test.ts > other > case two"],
		...overrides,
	};
}

describe("suite-baseline IO", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "suite-baseline-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("round-trips a red baseline through write + read", () => {
		const b = makeBaseline();
		writeSuiteBaseline(root, b);
		expect(readSuiteBaseline(root)).toEqual(b);
	});

	it("round-trips a green baseline with an empty failing set", () => {
		const b = makeBaseline({ green: true, failing_tests: [], language: "python" });
		writeSuiteBaseline(root, b);
		expect(readSuiteBaseline(root)).toEqual(b);
	});

	it("writeSuiteBaseline creates .interlinked/ when missing (mkdir-safe)", () => {
		// root has no .interlinked dir yet — write must not throw.
		writeSuiteBaseline(root, makeBaseline({ green: true, failing_tests: [] }));
		expect(readSuiteBaseline(root)).not.toBeNull();
	});

	it("returns null when the file is missing (fail-open)", () => {
		expect(readSuiteBaseline(root)).toBeNull();
	});

	it("returns null on torn/malformed JSON (fail-open)", () => {
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(join(root, ".interlinked", "suite-baseline.json"), '{"recorded_at": "2026', "utf-8");
		expect(readSuiteBaseline(root)).toBeNull();
	});

	it("returns null when a required field is missing or mistyped", () => {
		const path = join(root, ".interlinked", "suite-baseline.json");
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		// green mistyped as string
		writeFileSync(
			path,
			JSON.stringify({ recorded_at: "x", language: "ts", green: "yes", failing_tests: [] }),
			"utf-8",
		);
		expect(readSuiteBaseline(root)).toBeNull();
		// failing_tests contains a non-string entry
		writeFileSync(
			path,
			JSON.stringify({ recorded_at: "x", language: "ts", green: false, failing_tests: ["ok", 7] }),
			"utf-8",
		);
		expect(readSuiteBaseline(root)).toBeNull();
		// not an object at all
		writeFileSync(path, JSON.stringify(["not", "an", "object"]), "utf-8");
		expect(readSuiteBaseline(root)).toBeNull();
	});
});

describe("newFailures", () => {
	const current = ["a.test.ts > suite > case one", "c.test.ts > fresh > case three"];

	it("returns currentFailing unchanged when baseline is null", () => {
		expect(newFailures(current, null)).toEqual(current);
	});

	it("returns currentFailing unchanged when baseline is green", () => {
		const b = makeBaseline({ green: true, failing_tests: [] });
		expect(newFailures(current, b)).toEqual(current);
	});

	it("subtracts overlapping baselined failures from a red baseline", () => {
		const b = makeBaseline(); // baselines "case one" and "case two"
		expect(newFailures(current, b)).toEqual(["c.test.ts > fresh > case three"]);
	});

	it("returns all failures when a red baseline's failing set is disjoint", () => {
		const b = makeBaseline({ failing_tests: ["z.test.ts > unrelated > case"] });
		expect(newFailures(current, b)).toEqual(current);
	});

	it("returns empty when every current failure is baselined", () => {
		const b = makeBaseline({ failing_tests: current });
		expect(newFailures(current, b)).toEqual([]);
	});

	it("matches by exact string only — no fuzzy or normalized matching", () => {
		// Trailing whitespace / case / format differences all count as NEW.
		const b = makeBaseline({ failing_tests: ["a.test.ts > suite > case one "] });
		expect(newFailures(["a.test.ts > suite > case one"], b)).toEqual([
			"a.test.ts > suite > case one",
		]);
		const caseDiff = makeBaseline({ failing_tests: ["A.test.ts > Suite > Case One"] });
		expect(newFailures(["a.test.ts > suite > case one"], caseDiff)).toEqual([
			"a.test.ts > suite > case one",
		]);
	});

	it("preserves duplicates and order in currentFailing (no dedup)", () => {
		const dup = ["x > one", "x > one", "y > two"];
		const b = makeBaseline({ failing_tests: ["y > two"] });
		expect(newFailures(dup, b)).toEqual(["x > one", "x > one"]);
		expect(newFailures(dup, null)).toEqual(dup);
	});

	it("empty currentFailing yields empty regardless of baseline shape", () => {
		expect(newFailures([], null)).toEqual([]);
		expect(newFailures([], makeBaseline())).toEqual([]);
		expect(newFailures([], makeBaseline({ green: true, failing_tests: [] }))).toEqual([]);
	});
});
