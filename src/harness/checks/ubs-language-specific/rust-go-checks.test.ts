// Smoke tests for the Rust / Go UBS detectors. The exhaustive red/green
// suites live in src/harness/__tests__/ubs-*.test.ts and exercise these via
// the ubs-language-specific.ts barrel; this colocated file covers the module
// surface directly and satisfies the colocation gate.

import { describe, expect, it } from "vitest";
import {
	checkRustDebugAssertSideEffects,
	checkDeferInLoop,
	checkGoroutineNoWaitgroup,
	checkGoShellInjection,
	checkMutexLockUnwrap,
} from "./rust-go-checks.js";

describe("ubs-language-specific/rust-go-checks", () => {
	it("checkMutexLockUnwrap flags `Mutex<T>...lock().unwrap()`", () => {
		const code = "let m: Mutex<u64> = Mutex::new(0);\nlet v = m.lock().unwrap();";
		expect(checkMutexLockUnwrap(code, "a.rs")).toEqual([
			{ line: 2, text: "let v = m.lock().unwrap();" },
		]);
		expect(checkMutexLockUnwrap(code, "a.ts")).toEqual([]);
	});

	it("checkMutexLockUnwrap accepts nested generics and whitespace around calls", () => {
		const code = [
			"let m: Mutex <HashMap<String, u64>> = make();",
			"let v = m.lock ( ) .unwrap ( );",
		].join("\n");
		expect(checkMutexLockUnwrap(code, "nested.rs")).toEqual([
			{ line: 2, text: "let v = m.lock ( ) .unwrap ( );" },
		]);
	});

	it("checkMutexLockUnwrap anchors the warning to unwrap when it starts on a later line", () => {
		const code = "let m: Mutex<u64> = make();\nlet v = m.lock()\n    .unwrap();";
		expect(checkMutexLockUnwrap(code, "multiline.rs")).toEqual([
			{ line: 3, text: ".unwrap();" },
		]);
	});

	it("checkMutexLockUnwrap caps findings at ten", () => {
		const code = Array.from(
			{ length: 11 },
			(_, i) => `let m${i}: Mutex<u64> = make(); let v${i} = m${i}.lock().unwrap();`,
		).join("\n");
		const matches = checkMutexLockUnwrap(code, "many.rs");
		expect(matches).toHaveLength(10);
		expect(matches[0]).toEqual({
			line: 1,
			text: "let m0: Mutex<u64> = make(); let v0 = m0.lock().unwrap();",
		});
	});

	// test-contract: boundary — Mutex warnings require the documented lock().unwrap() call boundary
	it("checkMutexLockUnwrap does not accept an identifier appended to lock", () => {
		const code = "let m: Mutex<u64> = make();\nlet v = m.locked().unwrap();";
		expect(checkMutexLockUnwrap(code, "boundary.rs")).toEqual([]);
	});

	it("N1: checkMutexLockUnwrap does not fire on `.lock().expect(reason)` (documented recovery, not unwrap)", () => {
		const code = 'let m: Mutex<u64> = Mutex::new(0);\nlet v = m.lock().expect("mutex poisoned by a prior panic");';
		expect(checkMutexLockUnwrap(code, "a.rs")).toEqual([]);
	});

	it("N2: checkMutexLockUnwrap does not fire on a `match` over the lock Result (handles Err explicitly)", () => {
		const code =
			"let m: Mutex<u64> = Mutex::new(0);\nmatch m.lock() {\n    Ok(guard) => use_guard(guard),\n    Err(poisoned) => recover(poisoned),\n}";
		expect(checkMutexLockUnwrap(code, "a.rs")).toEqual([]);
	});

	it("N3: checkMutexLockUnwrap does not fire on `if let Ok(guard) = m.lock()` (no unwrap call at all)", () => {
		const code = "let m: Mutex<u64> = Mutex::new(0);\nif let Ok(guard) = m.lock() {\n    use_guard(guard);\n}";
		expect(checkMutexLockUnwrap(code, "a.rs")).toEqual([]);
	});

	it("N4: checkMutexLockUnwrap does not fire on the exact triggering pattern in a non-Rust file", () => {
		const code = "let m: Mutex<u64> = Mutex::new(0);\nlet v = m.lock().unwrap();";
		expect(checkMutexLockUnwrap(code, "a.go")).toEqual([]);
	});

	it("checkGoroutineNoWaitgroup flags a fire-and-forget goroutine", () => {
		const code = "func main() {\n  go func() { work() }()\n}";
		expect(checkGoroutineNoWaitgroup(code, "a.go")).toEqual([
			{ line: 2, text: "go func() { work() }()" },
		]);
		expect(checkGoroutineNoWaitgroup(code, "a.ts")).toEqual([]);
	});

	it("checkGoroutineNoWaitgroup does not flag a goroutine with a WaitGroup", () => {
		const code =
			"func main() {\n  var wg sync.WaitGroup\n  wg.Add(1)\n  go func() { defer wg.Done(); work() }()\n  wg.Wait()\n}";
		expect(checkGoroutineNoWaitgroup(code, "a.go")).toEqual([]);
	});

	it("checkGoroutineNoWaitgroup recognizes channel receives with or without spacing", () => {
		expect(checkGoroutineNoWaitgroup("go func() { x<- ch }()", "channels.go")).toEqual([]);
		expect(checkGoroutineNoWaitgroup("go func() { x<-ch }()", "channels.go")).toEqual([]);
		expect(checkGoroutineNoWaitgroup("go func() { work() }()", "channels.go")).toEqual([
			{ line: 1, text: "go func() { work() }()" },
		]);
	});

	it("checkGoroutineNoWaitgroup ignores comments and strings and reports exact multiline output", () => {
		const code = [
			'// go func() { fake() }()',
			'var example = "go func() { fake() }()"',
			"func main() {",
			"  go func() {",
			"    work()",
			"  }()",
			"}",
		].join("\n");
		expect(checkGoroutineNoWaitgroup(code, "main.go")).toEqual([
			{ line: 4, text: "go func() {" },
		]);
	});

	it("Go goroutine checks skip test files and non-Go extensions", () => {
		const code = "go func() { work() }()";
		expect(checkGoroutineNoWaitgroup(code, "src/tests/example.go")).toEqual([]);
		expect(checkGoroutineNoWaitgroup(code, "example.rs")).toEqual([]);
	});

	it("checkGoroutineNoWaitgroup caps findings at ten", () => {
		const code = Array.from({ length: 11 }, (_, i) => `go func() { work${i}() }()`).join("\n");
		expect(checkGoroutineNoWaitgroup(code, "many.go")).toHaveLength(10);
	});

	// test-contract: boundary — goroutine synchronization is considered only inside the documented local context window
	it("checkGoroutineNoWaitgroup excludes synchronization outside its context window", () => {
		const distantBefore = `wg.Wait();${"x".repeat(280)}\n`;
		const distantAfter = `go func() { work() }()\n${"x".repeat(280)}\nwg.Wait()`;
		expect(checkGoroutineNoWaitgroup(`${distantBefore}go func() { work() }()`, "window.go")).toEqual([
			{ line: 2, text: "go func() { work() }()" },
		]);
		expect(checkGoroutineNoWaitgroup(distantAfter, "window.go")).toEqual([
			{ line: 1, text: "go func() { work() }()" },
		]);
	});

	it("checkDeferInLoop flags `defer` inside a `for` loop", () => {
		const code = "func f() {\n  for i := 0; i < n; i++ {\n    defer cleanup()\n  }\n}";
		expect(checkDeferInLoop(code, "a.go")).toEqual([
			{ line: 3, text: "defer cleanup()" },
		]);
	});

	it("checkDeferInLoop does not flag a top-of-function defer", () => {
		const code = "func f() {\n  defer cleanup()\n  work()\n}";
		expect(checkDeferInLoop(code, "a.go")).toEqual([]);
	});

	it("checkDeferInLoop unwinds nested loops and leaves a later top-level defer alone", () => {
		const code = [
			"func f() {",
			"  for range items {",
			"    for range other {",
			"      defer inner()",
			"    }",
			"    defer outer()",
			"  }",
			"  defer final()",
			"}",
		].join("\n");
		expect(checkDeferInLoop(code, "nested.go")).toEqual([
			{ line: 4, text: "defer inner()" },
			{ line: 6, text: "defer outer()" },
		]);
	});

	it("checkDeferInLoop requires a braced loop and accepts multiple spaces after defer", () => {
		const code = [
			"func f() {",
			"  for range items",
			"  defer outside()",
			"  for range items {",
			"    defer    cleanup()",
			"  }",
			"}",
		].join("\n");
		expect(checkDeferInLoop(code, "spacing.go")).toEqual([
			{ line: 5, text: "defer    cleanup()" },
		]);
	});

	it("checkDeferInLoop skips test files and non-Go extensions", () => {
		const code = "for range items {\n  defer cleanup()\n}";
		expect(checkDeferInLoop(code, "src/tests/example.go")).toEqual([]);
		expect(checkDeferInLoop(code, "example.rs")).toEqual([]);
	});

	it("checkDeferInLoop caps findings at ten", () => {
		const code = [
			"func f() {",
			...Array.from({ length: 11 }, (_, i) => `  for { defer cleanup${i}() }`),
			"}",
		].join("\n");
		expect(checkDeferInLoop(code, "many.go")).toHaveLength(10);
	});

	it("checkGoShellInjection flags exec.Command with shell interpreter", () => {
		const code = `cmd := exec.Command("sh", "-c", "ping "+host)`;
		expect(checkGoShellInjection(code, "a.go")).toEqual([
			{ line: 1, text: 'cmd := exec.Command("sh", "-c", "ping "+host)' },
		]);
		const safe = `cmd := exec.Command("ping", "-c", "1", host)`;
		expect(checkGoShellInjection(safe, "a.go")).toEqual([]);
	});

	it("checkGoShellInjection accepts whitespace in the call and absolute shell paths", () => {
		const code = [
			'cmd := exec.Command \t( \n  "/bin/bash", "-c", input)',
			'other := exec.Command("/bin/sh", "-c", input)',
		].join("\n");
		expect(checkGoShellInjection(code, "shell.go")).toEqual([
			{ line: 1, text: 'cmd := exec.Command \t(' },
			{ line: 3, text: 'other := exec.Command("/bin/sh", "-c", input)' },
		]);
	});

	it("checkGoShellInjection strips multiline comments before scanning", () => {
		const code = [
			'cmd := exec.Command("bash", "-c", input)',
			'/* fake exec.Command("sh", "-c", input)',
			'   and fake exec.Command("bash", "-c", input) */',
		].join("\n");
		expect(checkGoShellInjection(code, "comments.go")).toEqual([
			{ line: 1, text: 'cmd := exec.Command("bash", "-c", input)' },
		]);
	});

	// test-contract: public-api — shell findings retain the source line after comments are removed
	it("checkGoShellInjection preserves line attribution with trailing source", () => {
		const code = [
			"// explanatory comment",
			'exec.Command("sh", "-c", input)',
			"// later source keeps the line-count partition observable",
		].join("\n");
		expect(checkGoShellInjection(code, "lines.go")).toEqual([
			{ line: 2, text: 'exec.Command("sh", "-c", input)' },
		]);
	});

	it("checkGoShellInjection skips test files and non-Go extensions", () => {
		const code = 'exec.Command("sh", "-c", input)';
		expect(checkGoShellInjection(code, "src/tests/example.go")).toEqual([]);
		expect(checkGoShellInjection(code, "example.rs")).toEqual([]);
	});

	it("checkGoShellInjection caps findings at ten", () => {
		const code = Array.from({ length: 11 }, (_, i) => `exec.Command("sh", "-c", input${i})`).join("\n");
		expect(checkGoShellInjection(code, "many.go")).toHaveLength(10);
	});

	it("Rust debug_assert side-effect checks distinguish side-effect categories", () => {
		const code = [
			"fn f(value: &mut Vec<u8>, result: Result<u8, E>) {",
			"  debug_assert!(value.pop().is_some());",
			"  debug_assert!(value.len() == 0);",
			"  debug_assert!(value.len() == 0 && (value.push(1), true));",
			"  debug_assert!(result? == 1);",
			"  debug_assert!(value[0] += 1);",
			"  debug_assert!((value = other) == other);",
			"  debug_assert!(value.len() > 0);",
			"}",
		].join("\n");
		expect(checkRustDebugAssertSideEffects(code, "src/lib.rs")).toEqual([
			{ line: 2, text: "debug_assert!(value.pop().is_some());" },
			{ line: 4, text: "debug_assert!(value.len() == 0 && (value.push(1), true));" },
			{ line: 5, text: "debug_assert!(result? == 1);" },
			{ line: 6, text: "debug_assert!(value[0] += 1);" },
			{ line: 7, text: "debug_assert!((value = other) == other);" },
		]);
	});

	it("Rust debug_assert side-effect checks handle nested calls and malformed macros", () => {
		const code = [
			"fn f(queue: &mut Vec<u8>) {",
			"  debug_assert!(ready(make_value()) && queue.pop().is_some());",
			"  debug_assert!(ready(make_value())); queue.pop();",
			"  debug_assert!(queue.push(make_value());",
			"}",
		].join("\n");
		expect(checkRustDebugAssertSideEffects(code, "nested.rs")).toEqual([
			{ line: 2, text: "debug_assert!(ready(make_value()) && queue.pop().is_some());" },
		]);
	});

	it("Rust debug_assert side-effect checks support suffixed and generic mutators", () => {
		const code = [
			"fn f(queue: &mut Vec<u8>) {",
			"  debug_assert!(queue.insert_stale::<u8>(0, 1));",
			"  debug_assert!(queue.push  (1));",
			"}",
		].join("\n");
		expect(checkRustDebugAssertSideEffects(code, "mutators.rs")).toHaveLength(2);
	});

	it("Rust debug_assert side-effect checks preserve exact output, cap matches, and skip tests", () => {
		const longCall = `debug_assert!(queue.pop_0()); ${"x".repeat(180)}`;
		const code = Array.from({ length: 11 }, (_, i) => `  ${longCall.replace("pop_0", `pop_${i}`)}`).join("\n");
		const matches = checkRustDebugAssertSideEffects(code, "many.rs");
		expect(matches).toHaveLength(10);
		expect(matches[0]).toEqual({ line: 1, text: longCall.slice(0, 150) });
		expect(checkRustDebugAssertSideEffects("debug_assert!(queue.pop());", "src/tests/foo.rs")).toEqual([]);
		expect(checkRustDebugAssertSideEffects("debug_assert!(queue.pop());", "src/foo.go")).toEqual([]);
	});

	it("Rust debug_assert side-effect checks ignore comments, strings, and predicate-only assertions", () => {
		const code = [
			"// debug_assert!(queue.pop());",
			'const text = "debug_assert!(queue.pop())";',
			"fn f(queue: &mut Vec<u8>) {",
			"  debug_assert!(queue.is_empty());",
			"  debug_assert_eq!(queue.len(), 0);",
			"  debug_assert_ne!(queue.len(), 1);",
			"}",
		].join("\n");
		expect(checkRustDebugAssertSideEffects(code, "predicate.rs")).toEqual([]);
	});

	// test-contract: boundary — Rust debug assertions ignore null-coalescing question operators
	it("Rust debug_assert side-effect checks require a standalone try operator", () => {
		const code = [
			"fn f(value: Option<u8>, other: Option<u8>) {",
			"  debug_assert!(value ?? other);",
			"  debug_assert!(value?);",
			"}",
		].join("\n");
		expect(checkRustDebugAssertSideEffects(code, "question.rs")).toEqual([
			{ line: 3, text: "debug_assert!(value?);" },
		]);
	});

	// test-contract: public-api — RUST_SIDE_EFFECT_CALL_RE documents an optional
	// underscore-suffix, optional whitespace, and optional `::<T>` generic before
	// the call's `(` (see the const's own doc grammar); every documented shape
	// must fire, including a bare call with no suffix and no generic at all.
	it("Rust debug_assert side-effect checks recognize every documented call-name shape", () => {
		const code = [
			"fn f(queue: &mut Vec<u8>) {",
			"  debug_assert!(queue.push(1));",
			"  debug_assert!(queue.push_xy(1));",
			"  debug_assert!(queue.push (1));",
			"  debug_assert!(queue.push::<u8>(1));",
			"  debug_assert!(queue.push::<u8> (1));",
			"}",
		].join("\n");
		expect(checkRustDebugAssertSideEffects(code, "shapes.rs")).toEqual([
			{ line: 2, text: "debug_assert!(queue.push(1));" },
			{ line: 3, text: "debug_assert!(queue.push_xy(1));" },
			{ line: 4, text: "debug_assert!(queue.push (1));" },
			{ line: 5, text: "debug_assert!(queue.push::<u8>(1));" },
			{ line: 6, text: "debug_assert!(queue.push::<u8> (1));" },
		]);
	});

	// test-contract: invariant — a predicate-only debug_assert sharing a line
	// with a side-effecting one must be judged independently: its own paren
	// span, not a neighbor's, decides whether it gets flagged.
	it("Rust debug_assert side-effect checks judge each call on a shared line independently", () => {
		const code = "fn f(queue: &mut Vec<u8>) {\n  debug_assert!(queue.is_empty()); debug_assert!(queue.push(1));\n}";
		expect(checkRustDebugAssertSideEffects(code, "shared.rs")).toEqual([
			{ line: 2, text: "debug_assert!(queue.is_empty()); debug_assert!(queue.push(1));" },
		]);
	});

	// test-contract: boundary — reported text is capped at 150 characters
	// (mirrors the existing "preserve exact output, cap matches" convention).
	it("Rust debug_assert side-effect checks truncate a long line to 150 characters", () => {
		const longLine = `  debug_assert!(queue.push(1)); ${"x".repeat(200)}`;
		expect(checkRustDebugAssertSideEffects(longLine, "long.rs")).toEqual([
			{ line: 1, text: longLine.trim().slice(0, 150) },
		]);
	});

	// test-contract: boundary — the try-operator detector requires a standalone
	// `?` not immediately adjacent to another `?`/`=`; body "value? == 1" places
	// the `?` mid-body (not at body-start) to isolate that specific boundary.
	it("Rust debug_assert side-effect checks flag a standalone try operator mid-body", () => {
		const code = "debug_assert!(value? == 1);";
		expect(checkRustDebugAssertSideEffects(code, "trymid.rs")).toEqual([
			{ line: 1, text: "debug_assert!(value? == 1);" },
		]);
	});

	// test-contract: boundary — the try-operator detector's `^` alternative
	// covers `?` as the very first character of the body (start-of-string is a
	// safe preceding context, same as a non-`:`/`?` character elsewhere).
	it("Rust debug_assert side-effect checks flag a try operator at the very start of the body", () => {
		const code = "debug_assert!(?x == 1);";
		expect(checkRustDebugAssertSideEffects(code, "trystart.rs")).toEqual([
			{ line: 1, text: "debug_assert!(?x == 1);" },
		]);
	});

	// test-contract: boundary — a `for` line needs an ACTUAL `{` (openCount > 0
	// strictly) to start loop tracking; the bare keyword must not suffice, even
	// on a contrived line that also contains `defer`.
	it("checkDeferInLoop requires more than the `for` keyword to start loop tracking", () => {
		const code = "for range items defer weird()";
		expect(checkDeferInLoop(code, "nobrace.go")).toEqual([]);
	});

	// test-contract: boundary — reported text is capped at 150 characters.
	it("checkDeferInLoop truncates a long defer line to 150 characters", () => {
		const inner = `  defer f(${"x".repeat(200)})`;
		const code = `for range xs {\n${inner}\n}`;
		expect(checkDeferInLoop(code, "long.go")).toEqual([
			{ line: 2, text: inner.trim().slice(0, 150) },
		]);
	});

	// test-contract: boundary — reported text is capped at 150 characters.
	it("checkGoroutineNoWaitgroup truncates a long goroutine line to 150 characters", () => {
		const code = `go func() { work(${"x".repeat(200)}) }()`;
		expect(checkGoroutineNoWaitgroup(code, "long.go")).toEqual([
			{ line: 1, text: code.trim().slice(0, 150) },
		]);
	});

	// test-contract: boundary — a block comment immediately preceded (no
	// separator) by a word character must not create a spurious word boundary:
	// stripping it fuses the surrounding characters, and `exec.Command` glued
	// onto a preceding letter is correctly NOT a `\b`-bounded match.
	it("checkGoShellInjection does not flag exec.Command fused onto a preceding letter after comment removal", () => {
		const code = 'a/* z */exec.Command("sh", "-c", input)';
		expect(checkGoShellInjection(code, "fused.go")).toEqual([]);
	});

	// test-contract: boundary — a genuine multi-word `//` line comment consumes
	// the rest of its line, so an exec.Command-shaped fragment written inside
	// one must NOT be reported (it is commentary, not code).
	it("checkGoShellInjection ignores an exec.Command shape written inside a real line comment", () => {
		const code = 'a// text exec.Command("sh", "-c", input)\nb := 1';
		expect(checkGoShellInjection(code, "commentbody.go")).toEqual([]);
	});

	// test-contract: boundary — reported text is capped at 150 characters.
	it("checkGoShellInjection truncates a long exec.Command line to 150 characters", () => {
		const code = `exec.Command("sh", "-c", "${"x".repeat(200)}")`;
		expect(checkGoShellInjection(code, "long.go")).toEqual([
			{ line: 1, text: code.trim().slice(0, 150) },
		]);
	});

	// test-contract: boundary — the AFTER-nested-generic segment (content
	// between an inner generic's `>` and the outer `>`) accepts ordinary
	// non-angle-bracket characters, not just an empty span.
	it("checkMutexLockUnwrap accepts trailing content between a nested generic and the outer close", () => {
		const code = "let m: Mutex<Vec<u8> extra> = make();\nlet v = m.lock().unwrap();";
		expect(checkMutexLockUnwrap(code, "aftercontent.rs")).toEqual([
			{ line: 2, text: "let v = m.lock().unwrap();" },
		]);
	});

	// test-contract: invariant — the reported line anchors to the `.unwrap`
	// token itself, not to wherever the overall match happens to end; a
	// newline inside `.unwrap( )`'s own parens must not shift the report.
	it("checkMutexLockUnwrap anchors to `.unwrap` even when its own parens span a newline", () => {
		const code = "let m: Mutex<u64> = make();\nlet v = m.lock().unwrap(\n);";
		expect(checkMutexLockUnwrap(code, "unwrapspan.rs")).toEqual([
			{ line: 2, text: "let v = m.lock().unwrap(" },
		]);
	});

	// test-contract: boundary — reported text is capped at 150 characters.
	it("checkMutexLockUnwrap truncates a long line to 150 characters", () => {
		const code = `let m: Mutex<u64> = make(); let v = m.lock().unwrap(); ${"x".repeat(200)}`;
		expect(checkMutexLockUnwrap(code, "long.rs")).toEqual([
			{ line: 1, text: code.trim().slice(0, 150) },
		]);
	});
});
