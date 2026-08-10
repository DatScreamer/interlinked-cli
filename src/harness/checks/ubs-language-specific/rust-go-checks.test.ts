// Smoke tests for the Rust / Go UBS detectors. The exhaustive red/green
// suites live in src/harness/__tests__/ubs-*.test.ts and exercise these via
// the ubs-language-specific.ts barrel; this colocated file covers the module
// surface directly and satisfies the colocation gate.

import { describe, expect, it } from "vitest";
import {
	checkDeferInLoop,
	checkGoroutineNoWaitgroup,
	checkGoShellInjection,
	checkMutexLockUnwrap,
} from "./rust-go-checks.js";

describe("ubs-language-specific/rust-go-checks", () => {
	it("checkMutexLockUnwrap flags `Mutex<T>...lock().unwrap()`", () => {
		const code = "let m: Mutex<u64> = Mutex::new(0);\nlet v = m.lock().unwrap();";
		expect(checkMutexLockUnwrap(code, "a.rs").length).toBeGreaterThan(0);
		expect(checkMutexLockUnwrap(code, "a.ts")).toEqual([]);
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
		expect(checkGoroutineNoWaitgroup(code, "a.go").length).toBeGreaterThan(0);
		expect(checkGoroutineNoWaitgroup(code, "a.ts")).toEqual([]);
	});

	it("checkGoroutineNoWaitgroup does not flag a goroutine with a WaitGroup", () => {
		const code =
			"func main() {\n  var wg sync.WaitGroup\n  wg.Add(1)\n  go func() { defer wg.Done(); work() }()\n  wg.Wait()\n}";
		expect(checkGoroutineNoWaitgroup(code, "a.go")).toEqual([]);
	});

	it("checkDeferInLoop flags `defer` inside a `for` loop", () => {
		const code = "func f() {\n  for i := 0; i < n; i++ {\n    defer cleanup()\n  }\n}";
		expect(checkDeferInLoop(code, "a.go").length).toBeGreaterThan(0);
	});

	it("checkDeferInLoop does not flag a top-of-function defer", () => {
		const code = "func f() {\n  defer cleanup()\n  work()\n}";
		expect(checkDeferInLoop(code, "a.go")).toEqual([]);
	});

	it("checkGoShellInjection flags exec.Command with shell interpreter", () => {
		const code = `cmd := exec.Command("sh", "-c", "ping "+host)`;
		expect(checkGoShellInjection(code, "a.go").length).toBeGreaterThan(0);
		const safe = `cmd := exec.Command("ping", "-c", "1", host)`;
		expect(checkGoShellInjection(safe, "a.go")).toEqual([]);
	});
});
