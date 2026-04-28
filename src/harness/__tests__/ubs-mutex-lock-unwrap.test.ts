// Tests for `ubs_mutex_lock_unwrap` (row 22 of Phase-1 Plan 04 phase matrix).
// Detects `Mutex::lock().unwrap()` in Rust source — panics on poisoned mutex.

import { describe, expect, it } from "vitest";
import { checkMutexLockUnwrap } from "../checks/ubs-language-specific.js";

describe("checkMutexLockUnwrap", () => {
	it("flags `Mutex<T>` followed by `.lock().unwrap()` in .rs files", () => {
		const code = [
			"use std::sync::Mutex;",
			"let counter: Mutex<i32> = Mutex::new(0);",
			"let value = counter.lock().unwrap();",
		].join("\n");
		const matches = checkMutexLockUnwrap(code, "src/main.rs");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags Mutex<HashMap<K, V>>.lock().unwrap() (nested generic)", () => {
		const code = [
			"use std::sync::Mutex;",
			"use std::collections::HashMap;",
			"let cache: Mutex<HashMap<String, u64>> = Mutex::new(HashMap::new());",
			"let guard = cache.lock().unwrap();",
		].join("\n");
		const matches = checkMutexLockUnwrap(code, "src/lib.rs");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `Mutex::lock().expect(\"...\")` (correct usage with documented expect)", () => {
		const code = [
			"use std::sync::Mutex;",
			"let counter: Mutex<i32> = Mutex::new(0);",
			"let value = counter.lock().expect(\"poisoned mutex — bug elsewhere\");",
		].join("\n");
		expect(checkMutexLockUnwrap(code, "src/main.rs")).toEqual([]);
	});

	it("does NOT flag a bare `.lock().unwrap()` with no Mutex declaration nearby (FP guard)", () => {
		// Without the `Mutex<…>` qualifier in proximity, this is a different
		// lock primitive (e.g. file lock, RwLock variant); regex should not fire.
		const code = "file_lock.lock().unwrap();";
		expect(checkMutexLockUnwrap(code, "src/main.rs")).toEqual([]);
	});

	it("returns empty for non-Rust files (.ts, .py, etc.)", () => {
		const code = "Mutex<i32>::lock().unwrap()";
		expect(checkMutexLockUnwrap(code, "main.ts")).toEqual([]);
		expect(checkMutexLockUnwrap(code, "main.py")).toEqual([]);
	});
});
