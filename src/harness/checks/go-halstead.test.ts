import { describe, expect, it } from "vitest";
import {
	computeGoHalstead,
	computeGoHalsteadFile,
	goHalsteadCheck,
	goHalsteadFileOperands,
	goHalsteadFileOperators,
} from "./go-halstead.js";
import { maintainabilityCheck } from "./maintainability.js";

const BASIC = `package main

import "fmt"

func main() {
	x := 1 + 2
	fmt.Println(x)
}
`;

const KEYWORDS = `package main

import "fmt"

const answer = 42

type message string

var greeting message = "hello"

func main() {
	fmt.Println(greeting, answer)
}
`;

const TWO_FUNCS = `package main

import "fmt"

func helper(v int) int {
	return v + 1
}

func main() {
	fmt.Println(helper(2))
}
`;

describe("Go Halstead — positive (must match luisantonioig/halstead-metrics)", () => {
	it("P1: counts func, :=, +, call; skips import", () => {
		const ops = goHalsteadFileOperators(BASIC);
		expect(ops?.get("func")).toBe(1);
		expect(ops?.get(":=")).toBe(1);
		expect(ops?.get("+")).toBe(1);
		expect(ops?.get("call")).toBe(1);
		expect(ops?.get("import") ?? 0).toBe(0);
	});

	it("P2: operands include var:x, literals, pkg:fmt, func:Println", () => {
		const ops = goHalsteadFileOperands(BASIC);
		expect(ops?.get("var:x")).toBeGreaterThan(0);
		expect(ops?.get("1")).toBe(1);
		expect(ops?.get("2")).toBe(1);
		expect(ops?.get("pkg:fmt")).toBeGreaterThan(0);
		expect(ops?.get("func:Println")).toBeGreaterThan(0);
	});

	it("P3: const/type/var are operators; package/import are not", () => {
		const ops = goHalsteadFileOperators(KEYWORDS);
		expect(ops?.get("const")).toBe(1);
		expect(ops?.get("type")).toBe(1);
		expect(ops?.get("var")).toBe(1);
		expect(ops?.get("package") ?? 0).toBe(0);
		expect(ops?.get("import") ?? 0).toBe(0);
	});

	it("P4: per-function reports name helper then main", () => {
		const fns = computeGoHalstead(TWO_FUNCS);
		expect(fns.map((f) => f.name)).toEqual(["helper", "main"]);
		expect(fns[0]?.halstead.total_operators).toBeGreaterThan(0);
		expect(fns[1]?.halstead.total_operands).toBeGreaterThan(0);
	});

	it("P5: methods use Receiver.Name", () => {
		const src = `package p
type T struct{}
func (t *T) Serve() { t.x = 1 }
`;
		expect(computeGoHalstead(src).map((f) => f.name)).toContain("*T.Serve");
	});
});

function denseGoFn(): string {
	const ops = ["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>"];
	const body = Array.from({ length: 40 }, (_, i) => {
		const op = ops[i % ops.length];
		return `a = a ${op} b`;
	}).join("\n\t");
	return `package p
func dense(a, b int) int {
	${body}
	if a < b && a > 0 || a != b {
		return a
	}
	return b
}
`;
}

describe("goHalsteadCheck — positive (must fire)", () => {
	it("P1: dense reused-operand function exceeds the difficulty ceiling", () => {
		const src = denseGoFn();
		const hits = goHalsteadCheck(src, "dense.go");
		expect(hits.length).toBeGreaterThanOrEqual(1);
		expect(hits[0]?.text).toContain("dense");
		expect(hits[0]?.text).toContain("Halstead difficulty");
	});
});

describe("Go Halstead — negative (must not fire / must not crash)", () => {
	it("N1: tiny main stays under the volume floor", () => {
		expect(goHalsteadCheck(BASIC, "main.go")).toEqual([]);
	});

	it("N2: non-Go source returns no file metrics", () => {
		expect(computeGoHalsteadFile("not go")).toBeNull();
		expect(goHalsteadCheck("not go", "x.go")).toEqual([]);
	});

	it("N3: empty file does not throw", () => {
		expect(goHalsteadCheck("", "x.go")).toEqual([]);
	});
});

describe("maintainabilityCheck dispatches .go", () => {
	it("P1: uses the Go checker for .go paths", () => {
		expect(maintainabilityCheck(BASIC, "pkg/main.go")).toEqual([]);
	});
});
