// Test coverage for the seven swift.ts detector functions that were
// orphaned (defined but not registered) prior to the 2026-05 Swift rollout.
// All seven are now wired through `check-registry/entries-swift.ts`; these
// tests pin their behavior in their newly-active state.

import { describe, expect, it } from "vitest";
import {
	checkSwiftAbbreviations,
	checkSwiftFileIdOverFilePath,
	checkSwiftFilterCount,
	checkSwiftGlobalVarNoIsolation,
	checkSwiftSelfInEscapingClosure,
	checkSwiftTaskDetached,
	checkSwiftUnhandledTaskError,
} from "./swift.js";

describe("checkSwiftTaskDetached", () => {
	it("flags Task.detached { ... }", () => {
		const code = "Task.detached { await work() }";
		expect(checkSwiftTaskDetached(code, "Foo.swift").length).toBe(1);
	});

	it("flags Task.detached(priority:) { ... }", () => {
		const code = "Task.detached(priority: .background) { await work() }";
		expect(checkSwiftTaskDetached(code, "Foo.swift").length).toBe(1);
	});

	it("flags multiple Task.detached", () => {
		const code = "Task.detached { a() }\nTask.detached { b() }";
		expect(checkSwiftTaskDetached(code, "Foo.swift").length).toBe(2);
	});

	it("does not flag Task { ... } (structured)", () => {
		const code = "Task { await work() }";
		expect(checkSwiftTaskDetached(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag inside string literal", () => {
		const code = 'let s = "use Task.detached only when needed"';
		expect(checkSwiftTaskDetached(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "Task.detached { work() }";
		expect(checkSwiftTaskDetached(code, "Foo.ts")).toEqual([]);
	});
});

describe("checkSwiftUnhandledTaskError", () => {
	it("flags try inside Task { } with no do/catch", () => {
		const code = `
			Task {
				try await doWork()
			}
		`;
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag try? inside Task { }", () => {
		const code = `
			Task {
				try? await doWork()
			}
		`;
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag try! inside Task { } (force-try is a separate check)", () => {
		const code = `
			Task {
				try! await doWork()
			}
		`;
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag try wrapped in do/catch", () => {
		const code = `
			Task {
				do {
					try await doWork()
				} catch {
					logger.error(error)
				}
			}
		`;
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag Task without try", () => {
		const code = `Task { await doWork() }`;
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "Task { try await doWork() }";
		expect(checkSwiftUnhandledTaskError(code, "Foo.ts")).toEqual([]);
	});
});

describe("checkSwiftGlobalVarNoIsolation", () => {
	it("flags file-scope var without @MainActor", () => {
		const code = "var counter = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift").length).toBe(1);
	});

	it("flags public var at file scope", () => {
		const code = "public var sharedCount = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag var inside a class", () => {
		const code = `
			class Foo {
				var inside = 0
			}
		`;
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag let at file scope (immutable)", () => {
		const code = "let constant = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag @MainActor var at file scope", () => {
		const code = "@MainActor\nvar counter = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "var counter = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.ts")).toEqual([]);
	});
});

describe("checkSwiftSelfInEscapingClosure", () => {
	it("flags self. in @escaping closure body without capture list", () => {
		const code = `
			func register(handler: @escaping () -> Void) {
				handler()
				self.value = 42
			}
		`;
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag with [weak self]", () => {
		const code = `
			func register(handler: @escaping () -> Void) { }
			let h: () -> Void = { [weak self] in
				self?.value = 42
			}
		`;
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag with [unowned self]", () => {
		const code = `
			func register(handler: @escaping () -> Void) { }
			let h: () -> Void = { [unowned self] in
				self.value = 42
			}
		`;
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag file with no @escaping", () => {
		const code = "func f() { self.value = 42 }";
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "@escaping closure with self.x";
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.ts")).toEqual([]);
	});
});

describe("checkSwiftFilterCount", () => {
	it("flags .filter { ... }.count", () => {
		const code = "let n = items.filter { $0.isActive }.count";
		expect(checkSwiftFilterCount(code, "Foo.swift").length).toBe(1);
	});

	it("flags .filter with multiple-statement body", () => {
		const code = "let n = items.filter { x in x > 0 }.count";
		expect(checkSwiftFilterCount(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag .count alone", () => {
		const code = "let n = items.count";
		expect(checkSwiftFilterCount(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag .filter without subsequent .count", () => {
		const code = "let active = items.filter { $0.isActive }";
		expect(checkSwiftFilterCount(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag .count(where:) (the recommended replacement)", () => {
		const code = "let n = items.count(where: { $0.isActive })";
		expect(checkSwiftFilterCount(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "items.filter { $0 }.count";
		expect(checkSwiftFilterCount(code, "Foo.ts")).toEqual([]);
	});
});

describe("checkSwiftFileIdOverFilePath", () => {
	it("flags #file", () => {
		const code = "logger.log(message, file: #file)";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.swift").length).toBe(1);
	});

	it("flags #filePath", () => {
		const code = "logger.log(message, file: #filePath)";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag #fileID (the safe form)", () => {
		const code = "logger.log(message, file: #fileID)";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag #fileLiteral", () => {
		const code = "let url = #fileLiteral(resourceName: \"img\")";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in comment", () => {
		const code = "// #file is forbidden — use #fileID";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "#file";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "logger.log(message, file: #file)";
		expect(checkSwiftFileIdOverFilePath(code, "FooTests.swift")).toEqual([]);
	});
});

describe("checkSwiftAbbreviations", () => {
	it("flags var btnX", () => {
		const code = "var btnSubmit: UIButton!";
		expect(checkSwiftAbbreviations(code, "Foo.swift").length).toBe(1);
	});

	it("flags func mgrFoo", () => {
		const code = "func mgrInit() { }";
		expect(checkSwiftAbbreviations(code, "Foo.swift").length).toBe(1);
	});

	it("flags labeled parameter cfg:", () => {
		const code = "func setup(cfg: Config) { }";
		expect(checkSwiftAbbreviations(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag spelled-out names", () => {
		const code = "var submitButton: UIButton!\nfunc setup(config: Config) { }";
		expect(checkSwiftAbbreviations(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag abbreviation inside a string literal", () => {
		const code = 'let label = "btn"';
		expect(checkSwiftAbbreviations(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "var btnSubmit: UIButton";
		expect(checkSwiftAbbreviations(code, "Foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "var btnSubmit: UIButton!";
		expect(checkSwiftAbbreviations(code, "FooTests.swift")).toEqual([]);
	});
});
