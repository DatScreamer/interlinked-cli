// Unit tests for assert-side-effects.ts — side effects inside assertion
// arguments that the shipping build erases (C NDEBUG, python -O, JVM no -ea).
//
// Covers, per detector: >=4 positive cases (line numbers asserted where
// sensible) and >=6 negative cases including comments-only occurrence,
// string-literal occurrence, wrong extension, and test-file path — plus the
// shared core's whole-name verb discipline (starts_with / settings / taken /
// writer / opened / created_at / popped must never prefix-match).

import { describe, expect, it } from "vitest";
import {
	checkCAssertSideEffects,
	checkJavaAssertSideEffects,
	checkPythonAssertSideEffects,
	detectAssertSideEffect,
} from "./assert-side-effects.js";

const C_PATH = "src/core/hmr.c";
const PY_PATH = "src/cache/store.py";
const JAVA_PATH = "src/main/java/com/acme/Registry.java";

// ─── Shared core ──────────────────────────────────────────────────────────────

describe("detectAssertSideEffect — shared core", () => {
	it("fires on assignment and compound assignment (but not comparisons)", () => {
		expect(detectAssertSideEffect("x = compute()", "snake")).toBe(true);
		expect(detectAssertSideEffect("total += n", "snake")).toBe(true);
		expect(detectAssertSideEffect("(flags |= MASK) != 0", "camel")).toBe(true);
		expect(detectAssertSideEffect("x >>= 2", "snake")).toBe(true);
	});

	it("fires on ++ / -- and the Python walrus", () => {
		expect(detectAssertSideEffect("count++ < max", "camel")).toBe(true);
		expect(detectAssertSideEffect("n-- > 0", "snake")).toBe(true);
		expect(detectAssertSideEffect("(n := compute()) > 0", "snake")).toBe(true);
	});

	it("fires on whole-name mutating calls in both naming modes", () => {
		expect(detectAssertSideEffect("map.insert_stale(key)", "snake")).toBe(true);
		expect(detectAssertSideEffect("q.pop()", "snake")).toBe(true);
		expect(detectAssertSideEffect("list.add(x)", "camel")).toBe(true);
		expect(detectAssertSideEffect("iterator.remove()", "camel")).toBe(true);
		expect(detectAssertSideEffect("config.setValue(v)", "camel")).toBe(true);
	});

	it("does not fire on pure comparison operators", () => {
		expect(detectAssertSideEffect("a == b", "snake")).toBe(false);
		expect(detectAssertSideEffect("a != b", "camel")).toBe(false);
		expect(detectAssertSideEffect("a >= 0 && b <= 10", "snake")).toBe(false);
		expect(detectAssertSideEffect("f(x) => y", "camel")).toBe(false);
	});

	it("does not prefix-match verb-lookalike names (snake mode)", () => {
		expect(detectAssertSideEffect('name.starts_with("a")', "snake")).toBe(false);
		expect(detectAssertSideEffect("q.taken()", "snake")).toBe(false);
		expect(detectAssertSideEffect("writer() != 0", "snake")).toBe(false);
		expect(detectAssertSideEffect("opened(f)", "snake")).toBe(false);
		expect(detectAssertSideEffect("created_at(row) > 0", "snake")).toBe(false);
		expect(detectAssertSideEffect("popped(q)", "snake")).toBe(false);
		expect(detectAssertSideEffect("settings(cfg)", "snake")).toBe(false);
	});

	it("does not prefix-match verb-lookalike names (camel mode)", () => {
		expect(detectAssertSideEffect("settings() != null", "camel")).toBe(false);
		expect(detectAssertSideEffect("address() != null", "camel")).toBe(false);
		expect(detectAssertSideEffect("additional(x) > 0", "camel")).toBe(false);
		expect(detectAssertSideEffect('name.startsWith("a")', "camel")).toBe(false);
	});

	it("python mode: kwarg `=` is not an assignment; walrus and mutating calls still fire", () => {
		expect(detectAssertSideEffect("math.isclose(a, b, rel_tol=1e-9)", "python")).toBe(false);
		expect(detectAssertSideEffect("sorted(xs, key=len) == xs", "python")).toBe(false);
		expect(detectAssertSideEffect("parse(payload, strict=True)", "python")).toBe(false);
		expect(detectAssertSideEffect("(n := compute()) > 0", "python")).toBe(true);
		expect(detectAssertSideEffect("q.pop() is not None", "python")).toBe(true);
	});

	it("python mode: bare set( is the pure builtin; .set( / set_flag( keep firing", () => {
		expect(detectAssertSideEffect("set(actual) == set(expected)", "python")).toBe(false);
		expect(detectAssertSideEffect("len(set(names)) == len(names)", "python")).toBe(false);
		expect(detectAssertSideEffect("cache.set(k, v)", "python")).toBe(true);
		expect(detectAssertSideEffect("set_flag(job)", "python")).toBe(true);
	});

	it("snake mode: noun_verb final-segment mutators fire; homograph finals do not", () => {
		expect(detectAssertSideEffect("queue_push(q, x) == 0", "snake")).toBe(true);
		expect(detectAssertSideEffect("q_pop(q)", "snake")).toBe(true);
		expect(detectAssertSideEffect("to_set(xs)", "snake")).toBe(false);
		expect(detectAssertSideEffect("is_open(f)", "snake")).toBe(false);
		expect(detectAssertSideEffect("lock_free(q)", "snake")).toBe(false);
		expect(detectAssertSideEffect("should_close(conn)", "snake")).toBe(false);
	});

	it("snake mode: verb-first names with a query continuation are accessors", () => {
		expect(detectAssertSideEffect("set_size(seen) > 0", "snake")).toBe(false);
		expect(detectAssertSideEffect("free_space(ring) > 0", "snake")).toBe(false);
		expect(detectAssertSideEffect("set_value(k, v)", "snake")).toBe(true);
	});
});

// ─── C — ubs_c_assert_side_effect ─────────────────────────────────────────────

describe("checkCAssertSideEffects — positive (must fire)", () => {
	it("P1: mutating write() call inside assert()", () => {
		const src = [
			"#include <assert.h>",
			"void flush_buf(int fd, const char *buf, int n) {",
			"  assert(write(fd, buf, n) == n);",
			"}",
		].join("\n");
		const found = checkCAssertSideEffects(src, C_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
		expect(found[0]?.text).toContain("ubs_c_assert_side_effect");
		expect(found[0]?.text).toContain("NDEBUG");
	});

	it("P2: snake-continuation verb (the Bun insert_stale shape)", () => {
		const src = [
			"static void refresh(map_t *m, key_t k) {",
			"  assert(insert_stale(m, k));",
			"}",
		].join("\n");
		const found = checkCAssertSideEffects(src, C_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("P3: assignment inside assert()", () => {
		const src = ["int main(void) {", "  int x = 0;", "  assert(x = 5);", "  return x;", "}"].join(
			"\n",
		);
		const found = checkCAssertSideEffects(src, C_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
	});

	it("P4: decrement inside assert()", () => {
		const src = ["void drain(int n) {", "  assert(n-- > 0);", "}"].join("\n");
		const found = checkCAssertSideEffects(src, C_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("P5: multi-line argument in a .cpp file (paren balancing)", () => {
		const src = [
			"bool refresh(Cache &c) {",
			"  assert(c.set_value(",
			'      "k", 42));',
			"  return true;",
			"}",
		].join("\n");
		const found = checkCAssertSideEffects(src, "src/cache/refresh.cpp");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("P6: noun_verb method-style mutators — the dominant C convention (queue_push / list_append / hashmap_insert)", () => {
		const src =
			"int f(queue_t *q, int x) { assert(queue_push(q, x) == 0); assert(list_append(l, x)); assert(hashmap_insert(m2, k, v)); }";
		expect(checkCAssertSideEffects(src, "src/core/queue.c")).toHaveLength(3);
	});

	it("P7: a comment merely MENTIONING #define assert does not suppress the file", () => {
		const src = [
			"/* Never #define assert yourself; use the standard macro. */",
			"#include <assert.h>",
			"void flush_buf(int fd, const char *buf, int n) {",
			"  assert(write(fd, buf, n) == n);",
			"}",
		].join("\n");
		const found = checkCAssertSideEffects(src, "src/core/io.c");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(4);
	});
});

describe("checkCAssertSideEffects — negative (must NOT fire)", () => {
	it("N1: pure conditions, including verb-lookalike calls", () => {
		const src = [
			"void ok(const q_t *q, const char *s, int count) {",
			"  assert(count >= 0);",
			"  assert(q != NULL && count <= 100);",
			'  assert(strcmp(s, "x") == 0);',
			"  assert(taken(q));",
			"  assert(starts_with(s, prefix));",
			"}",
		].join("\n");
		expect(checkCAssertSideEffects(src, C_PATH)).toHaveLength(0);
	});

	it("N2: comments-only occurrence", () => {
		const src = [
			"int main(void) {",
			"  // assert(write(fd, buf, n) == n);",
			"  /* assert(x = 5); */",
			"  return 0;",
			"}",
		].join("\n");
		expect(checkCAssertSideEffects(src, C_PATH)).toHaveLength(0);
	});

	it("N3: string-literal occurrence", () => {
		const src = 'const char *doc = "assert(write(fd, buf, n))";';
		expect(checkCAssertSideEffects(src, C_PATH)).toHaveLength(0);
	});

	it("N4: wrong extension", () => {
		const src = "fn f() { assert(write(fd, buf, n) == n); }";
		expect(checkCAssertSideEffects(src, "src/core/hmr.rs")).toHaveLength(0);
	});

	it("N5: test-file and vendored paths", () => {
		const src = "void t(void) { assert(write(fd, buf, n) == n); }";
		expect(checkCAssertSideEffects(src, "project/tests/hmr.c")).toHaveLength(0);
		expect(checkCAssertSideEffects(src, "node_modules/pkg/hmr.c")).toHaveLength(0);
	});

	it("N6: file-level bail when the project redefines assert", () => {
		const src = [
			"#define assert(x) my_always_on_check(x)",
			"void f(void) {",
			"  assert(write(fd, buf, n) == n);",
			"}",
		].join("\n");
		expect(checkCAssertSideEffects(src, C_PATH)).toHaveLength(0);
	});

	it("N7: static_assert is compile-time, never flagged", () => {
		const src = 'static_assert(sizeof(long) == 8, "64-bit only");';
		expect(checkCAssertSideEffects(src, "src/abi.hpp")).toHaveLength(0);
	});

	it("N8: unbalanced paren at EOF does not crash or fire", () => {
		const src = "void f(void) { assert(write(fd, buf";
		expect(checkCAssertSideEffects(src, C_PATH)).toHaveLength(0);
	});

	it("N9: noun-prefixed accessors on verb homographs (set_contains / set_size / free_space)", () => {
		const src =
			"void f(set_t *seen, int id) { assert(set_contains(seen, id)); assert(set_size(seen) > 0); assert(free_space(ring) > 0); }";
		expect(checkCAssertSideEffects(src, "src/graph/visit.c")).toHaveLength(0);
	});

	it("N10: C++ lambda default capture [=] is not an assignment", () => {
		const src = [
			"void f(const std::vector<int>& v, int lo) {",
			"  assert(std::all_of(v.begin(), v.end(), [=](int x) { return x >= lo; }));",
			"}",
		].join("\n");
		expect(checkCAssertSideEffects(src, "src/core/check.cpp")).toHaveLength(0);
	});

	it("N11: assert(-dense pathological content stays linear (no per-match scan to EOF)", () => {
		const t0 = performance.now();
		// ~98KB of unbalanced `assert(` — was ~1.4s quadratic, must be ~ms now.
		expect(checkCAssertSideEffects("assert(".repeat(14000), C_PATH)).toHaveLength(0);
		// ~24KB of deeply NESTED balanced asserts — inner bodies are substrings
		// of the already-scanned parent body and must not be rescanned.
		const nested = `void f(void) { ${"assert(".repeat(3000)}1${")".repeat(3000)}; }`;
		expect(checkCAssertSideEffects(nested, C_PATH)).toHaveLength(0);
		expect(performance.now() - t0).toBeLessThan(1000);
	}, 10_000);
});

// ─── Python — ubs_python_assert_side_effect ───────────────────────────────────

describe("checkPythonAssertSideEffects — positive (must fire)", () => {
	it("P1: snake-continuation mutating call", () => {
		const src = ["def refresh(cache, key):", "    assert cache.insert_stale(key)"].join("\n");
		const found = checkPythonAssertSideEffects(src, PY_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("ubs_python_assert_side_effect");
	});

	it("P2: walrus binding inside assert", () => {
		const src = ["def check(xs):", "    assert (n := compute(xs)) > 0", "    return n"].join(
			"\n",
		);
		const found = checkPythonAssertSideEffects(src, PY_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("P3: bare mutating verbs (pop / close / push)", () => {
		const src = [
			"assert q.pop(0) is not None",
			"assert conn.close() is None",
			"assert stack.push(item)",
		].join("\n");
		const found = checkPythonAssertSideEffects(src, PY_PATH);
		expect(found.map((m) => m.line)).toEqual([1, 2, 3]);
	});

	it("P4: side-effecting condition still fires when a message operand is present", () => {
		const src = 'assert registry.register(name), "registration failed"';
		const found = checkPythonAssertSideEffects(src, PY_PATH);
		expect(found).toHaveLength(1);
	});

	it("P5: caps at 10 matches per file", () => {
		const src = Array.from({ length: 12 }, () => "assert q.pop() is not None").join("\n");
		expect(checkPythonAssertSideEffects(src, PY_PATH)).toHaveLength(10);
	});
});

describe("checkPythonAssertSideEffects — negative (must NOT fire)", () => {
	it("N1: the spec'd pure asserts", () => {
		const src = [
			"def ok(x, xs, q):",
			"    assert isinstance(x, Foo)",
			"    assert len(xs) == 3",
			"    assert x.is_valid()",
			"    assert q.taken()",
		].join("\n");
		expect(checkPythonAssertSideEffects(src, PY_PATH)).toHaveLength(0);
	});

	it("N2: comments-only occurrence", () => {
		const src = ["def f():", "    # assert q.pop() is not None", "    return 1"].join("\n");
		expect(checkPythonAssertSideEffects(src, PY_PATH)).toHaveLength(0);
	});

	it("N3: string-literal occurrence", () => {
		const src = ['msg = "assert q.pop(0)"', "print(msg)"].join("\n");
		expect(checkPythonAssertSideEffects(src, PY_PATH)).toHaveLength(0);
	});

	it("N4: wrong extension", () => {
		const src = "assert q.pop(0) is not None";
		expect(checkPythonAssertSideEffects(src, "src/q.js")).toHaveLength(0);
	});

	it("N5: test-file path", () => {
		const src = "assert cache.insert_stale(key)";
		expect(checkPythonAssertSideEffects(src, "test_cache.py")).toHaveLength(0);
		expect(checkPythonAssertSideEffects(src, "pkg/tests/cache.py")).toHaveLength(0);
	});

	it("N6: mutating call only in the stripped `, message` operand", () => {
		const src = "assert ok, pop_hint()";
		expect(checkPythonAssertSideEffects(src, PY_PATH)).toHaveLength(0);
	});

	it("N7: verb-lookalike names never prefix-match", () => {
		const src = [
			"assert q.settings() == {}",
			"assert row.created_at() > 0",
			"assert doc.popped() is False",
			"assert s.startswith('a')",
		].join("\n");
		expect(checkPythonAssertSideEffects(src, PY_PATH)).toHaveLength(0);
	});

	it("N8: keyword-argument `=` in an assert expression is never an assignment", () => {
		const src = ["def check(a, b):", "    assert math.isclose(a, b, rel_tol=1e-9)"].join("\n");
		expect(checkPythonAssertSideEffects(src, "src/num/util.py")).toHaveLength(0);
		const more = [
			"import math",
			"def close(a, b):",
			"    assert math.isclose(a, b, rel_tol=1e-9)",
			"assert sorted(xs, key=len) == xs",
			"assert parse(payload, strict=True)",
			"assert json.dumps(d, sort_keys=True)",
			"assert f(x, timeout=5)",
		].join("\n");
		expect(checkPythonAssertSideEffects(more, "src/num/compare.py")).toHaveLength(0);
	});

	it("N9: bare set( is the pure builtin constructor (order-insensitive / uniqueness idioms)", () => {
		const src = [
			"assert set(actual) == set(expected)",
			'assert set(kwargs) <= {"debug", "verbose"}',
			"def uniq(names):",
			"    assert len(set(names)) == len(names)",
		].join("\n");
		expect(checkPythonAssertSideEffects(src, "src/util/uniq.py")).toHaveLength(0);
	});

	it("exemption is bounded: dotted .set( and verb-object set_flag( still fire", () => {
		const src = ["assert cache.set(k, v)", "assert set_flag(job)"].join("\n");
		expect(checkPythonAssertSideEffects(src, PY_PATH).map((m) => m.line)).toEqual([1, 2]);
	});

	it("N10: assert examples inside a MULTI-LINE docstring are string content", () => {
		const q3 = '"""';
		const src = [
			"def drain(q):",
			`    ${q3}Drain the queue.`,
			"",
			"    Example usage in callers:",
			"        assert q.pop() is not None",
			`    ${q3}`,
			"    return list(q)",
		].join("\n");
		expect(checkPythonAssertSideEffects(src, "src/queue/drain.py")).toHaveLength(0);
		// Control: a live assert AFTER the docstring closes still fires.
		const live = [
			"def drain(q):",
			`    ${q3}`,
			"    Example:",
			"        assert q.pop() is not None",
			`    ${q3}`,
			"    assert q.pop() is not None",
		].join("\n");
		expect(checkPythonAssertSideEffects(live, "src/queue/drain.py").map((m) => m.line)).toEqual([
			6,
		]);
	});
});

// ─── Java — ubs_java_assert_side_effect ───────────────────────────────────────

describe("checkJavaAssertSideEffects — positive (must fire)", () => {
	it("P1: list.add(x) inside assert", () => {
		const src = [
			"class Registry {",
			"  void track(List<String> list, String x) {",
			"    assert list.add(x);",
			"  }",
			"}",
		].join("\n");
		const found = checkJavaAssertSideEffects(src, JAVA_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
		expect(found[0]?.text).toContain("ubs_java_assert_side_effect");
		expect(found[0]?.text).toContain("-ea");
	});

	it("P2: map.put(k, v) inside assert", () => {
		const src = "class C { void f(Map<K, V> map) { assert map.put(k, v) == null; } }";
		expect(checkJavaAssertSideEffects(src, JAVA_PATH)).toHaveLength(1);
	});

	it("P3: sb.append(x) inside assert", () => {
		const src = "class C { void f(StringBuilder sb) { assert sb.append(x) != null; } }";
		expect(checkJavaAssertSideEffects(src, JAVA_PATH)).toHaveLength(1);
	});

	it("P4: UpperCamel continuation — setValue(", () => {
		const src = "class C { void f(Config config) { assert config.setValue(v); } }";
		expect(checkJavaAssertSideEffects(src, JAVA_PATH)).toHaveLength(1);
	});

	it("P5: increment inside assert", () => {
		const src = ["class C {", "  void f() {", "    assert count++ < max;", "  }", "}"].join("\n");
		const found = checkJavaAssertSideEffects(src, JAVA_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
	});

	it("P6: long (484-char) conditions are scanned — the statement window is unbounded per spec", () => {
		const long = `flag${" && flag".repeat(60)}`;
		const short = `flag${" && flag".repeat(20)}`;
		const mk = (c: string) => `class C { void f() { assert ${c} && list.add(x); } }`;
		expect(long.length).toBeGreaterThan(400);
		expect(checkJavaAssertSideEffects(mk(long), JAVA_PATH)).toHaveLength(1);
		expect(checkJavaAssertSideEffects(mk(short), JAVA_PATH)).toHaveLength(1);
	});
});

describe("checkJavaAssertSideEffects — negative (must NOT fire)", () => {
	it("N1: settings() is pure — no bare-suffix prefix-match", () => {
		const src = "class C { void f() { assert settings() != null; } }";
		expect(checkJavaAssertSideEffects(src, JAVA_PATH)).toHaveLength(0);
	});

	it("N2: address() / additional() are pure", () => {
		const src = [
			"class C {",
			"  void f() {",
			"    assert address() != null;",
			"    assert additional(x) > 0;",
			"  }",
			"}",
		].join("\n");
		expect(checkJavaAssertSideEffects(src, JAVA_PATH)).toHaveLength(0);
	});

	it("N3: comments-only occurrence", () => {
		const src = [
			"class C {",
			"  // assert list.add(x);",
			"  /* assert map.put(k, v); */",
			"}",
		].join("\n");
		expect(checkJavaAssertSideEffects(src, JAVA_PATH)).toHaveLength(0);
	});

	it("N4: string-literal occurrence", () => {
		const src = 'class C { String s = "assert list.add(x);"; }';
		expect(checkJavaAssertSideEffects(src, JAVA_PATH)).toHaveLength(0);
	});

	it("N5: wrong extension", () => {
		const src = "class C { void f() { assert list.add(x); } }";
		expect(checkJavaAssertSideEffects(src, "src/Registry.kt")).toHaveLength(0);
	});

	it("N6: test-file path", () => {
		const src = "class RegistryTest { void f() { assert list.add(x); } }";
		expect(checkJavaAssertSideEffects(src, "src/RegistryTest.java")).toHaveLength(0);
	});

	it("N7: startsWith() is pure — lowercase continuation never matches", () => {
		const src = 'class C { void f() { assert name.startsWith("prefix"); } }';
		expect(checkJavaAssertSideEffects(src, JAVA_PATH)).toHaveLength(0);
	});

	it("N8: pure condition with a pure : message operand", () => {
		const src = 'class C { void f() { assert x > 0 : "must be positive"; } }';
		expect(checkJavaAssertSideEffects(src, JAVA_PATH)).toHaveLength(0);
	});

	it("N9: text-block (Java 15+) string content is not scanned", () => {
		const q3 = '"""';
		const src = [
			"class Doc {",
			`  static final String SNIPPET = ${q3}`,
			"      assert list.add(x);",
			`      ${q3};`,
			"}",
		].join("\n");
		expect(checkJavaAssertSideEffects(src, JAVA_PATH)).toHaveLength(0);
		// Control: a live assert AFTER the text block closes still fires.
		const live = [
			"class Doc {",
			`  static final String SNIPPET = ${q3}`,
			"      docs",
			`      ${q3};`,
			"  void f(List<String> list, String x) { assert list.add(x); }",
			"}",
		].join("\n");
		expect(checkJavaAssertSideEffects(live, JAVA_PATH).map((m) => m.line)).toEqual([5]);
	});
});
