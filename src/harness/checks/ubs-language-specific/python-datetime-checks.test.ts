import { describe, expect, it } from "vitest";
import { checkNaiveDatetime } from "./python-datetime-checks.js";

const PY = "svc/clock.py";

describe("checkNaiveDatetime — positive cases", () => {
	it("flags datetime.utcnow() (naive + deprecated)", () => {
		const m = checkNaiveDatetime("ts = datetime.utcnow()\n", PY);
		expect(m).toHaveLength(1);
		expect(m[0]?.line).toBe(1);
	});

	it("flags datetime.utcfromtimestamp(...)", () => {
		const m = checkNaiveDatetime("d = datetime.utcfromtimestamp(epoch)\n", PY);
		expect(m).toHaveLength(1);
	});

	it("flags datetime.now() with empty parens (naive local)", () => {
		const m = checkNaiveDatetime("now = datetime.now()\n", PY);
		expect(m).toHaveLength(1);
	});

	it("flags the datetime.datetime.utcnow() fully-qualified form", () => {
		const m = checkNaiveDatetime("x = datetime.datetime.utcnow()\n", PY);
		expect(m).toHaveLength(1);
	});
});

describe("checkNaiveDatetime — negative cases (must NOT fire)", () => {
	it("does not flag datetime.now(timezone.utc) (tz-aware)", () => {
		expect(checkNaiveDatetime("now = datetime.now(timezone.utc)\n", PY)).toHaveLength(0);
	});

	it("does not flag datetime.now(tz) (tz-aware)", () => {
		expect(checkNaiveDatetime("now = datetime.now(tz)\n", PY)).toHaveLength(0);
	});

	it("does not flag on a non-Python file", () => {
		expect(checkNaiveDatetime("const t = datetime.utcnow();\n", "src/a.ts")).toHaveLength(0);
	});

	it("does not flag in a test file (fixed naive datetimes are idiomatic)", () => {
		expect(checkNaiveDatetime("frozen = datetime.utcnow()\n", "tests/test_clock.py")).toHaveLength(0);
	});

	it("respects a # noqa suppression on the call line", () => {
		expect(checkNaiveDatetime("ts = datetime.utcnow()  # noqa\n", PY)).toHaveLength(0);
	});

	it("does not flag a datetime.utcnow reference inside a comment", () => {
		expect(checkNaiveDatetime("# avoid datetime.utcnow() here\nx = 1\n", PY)).toHaveLength(0);
	});
});
