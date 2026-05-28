import { describe, expect, it } from "vitest";
import {
	checkSwiftEmptyCatch,
	checkSwiftFatalErrorInGuard,
	checkSwiftNsurlLegacyBridge,
	checkSwiftPrintInViewBody,
	checkSwiftTryQuestionDiscarded,
} from "./swift-quality.js";

describe("checkSwiftEmptyCatch", () => {
	it("flags catch { } same-line empty body", () => {
		const code = "do { try x() } catch { }";
		expect(checkSwiftEmptyCatch(code, "Foo.swift").length).toBe(1);
	});

	it("flags catch { } across two lines with only whitespace inside", () => {
		const code = "do { try x() }\ncatch {\n}\n";
		expect(checkSwiftEmptyCatch(code, "Foo.swift").length).toBe(1);
	});

	it("flags multiple empty catches", () => {
		const code = "do { try a() } catch { }\ndo { try b() } catch { }";
		expect(checkSwiftEmptyCatch(code, "Foo.swift").length).toBe(2);
	});

	it("does not flag a catch with a body", () => {
		const code = "do { try x() } catch { logger.error(error) }";
		expect(checkSwiftEmptyCatch(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag a catch with a pattern + body", () => {
		const code = "do { try x() } catch let err as MyError { handle(err) }";
		expect(checkSwiftEmptyCatch(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift files", () => {
		const code = "do { try x() } catch { }";
		expect(checkSwiftEmptyCatch(code, "Foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "do { try x() } catch { }";
		expect(checkSwiftEmptyCatch(code, "FooTests.swift")).toEqual([]);
	});
});

describe("checkSwiftTryQuestionDiscarded", () => {
	it("flags bare statement-level try?", () => {
		const code = "func f() {\n  try? doStuff()\n}";
		expect(checkSwiftTryQuestionDiscarded(code, "Foo.swift").length).toBe(1);
	});

	it("flags multiple bare try?", () => {
		const code = "try? a()\ntry? b()";
		expect(checkSwiftTryQuestionDiscarded(code, "Foo.swift").length).toBe(2);
	});

	it("does not flag bound let try?", () => {
		const code = "let result = try? doStuff()";
		expect(checkSwiftTryQuestionDiscarded(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag explicit _ = try?", () => {
		const code = "_ = try? doStuff()";
		expect(checkSwiftTryQuestionDiscarded(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag if let pattern", () => {
		const code = "if let x = try? doStuff() { print(x) }";
		expect(checkSwiftTryQuestionDiscarded(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag guard let pattern", () => {
		const code = "guard let x = try? doStuff() else { return }";
		expect(checkSwiftTryQuestionDiscarded(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag return try?", () => {
		const code = "func f() -> Foo? { return try? doStuff() }";
		expect(checkSwiftTryQuestionDiscarded(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift files", () => {
		const code = "try? doStuff()";
		expect(checkSwiftTryQuestionDiscarded(code, "Foo.ts")).toEqual([]);
	});
});

describe("checkSwiftNsurlLegacyBridge", () => {
	it("flags NSURL(string:)", () => {
		const code = 'let u = NSURL(string: "https://example.com")';
		expect(checkSwiftNsurlLegacyBridge(code, "Net.swift").length).toBe(1);
	});

	it("flags NSURLRequest(url:)", () => {
		const code = "let r = NSURLRequest(url: u)";
		expect(checkSwiftNsurlLegacyBridge(code, "Net.swift").length).toBe(1);
	});

	it("flags NSURLComponents()", () => {
		const code = "var c = NSURLComponents()";
		expect(checkSwiftNsurlLegacyBridge(code, "Net.swift").length).toBe(1);
	});

	it("does not flag URL(string:)", () => {
		const code = 'let u = URL(string: "https://example.com")';
		expect(checkSwiftNsurlLegacyBridge(code, "Net.swift")).toEqual([]);
	});

	it("does not flag URLRequest(url:)", () => {
		const code = "let r = URLRequest(url: u)";
		expect(checkSwiftNsurlLegacyBridge(code, "Net.swift")).toEqual([]);
	});

	it("does not flag inside a string literal", () => {
		const code = 'let s = "use NSURL not URL"';
		expect(checkSwiftNsurlLegacyBridge(code, "Net.swift")).toEqual([]);
	});

	it("does not flag in non-Swift files", () => {
		const code = "NSURL(string: x)";
		expect(checkSwiftNsurlLegacyBridge(code, "Net.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "NSURL(string: x)";
		expect(checkSwiftNsurlLegacyBridge(code, "NetTests.swift")).toEqual([]);
	});
});

describe("checkSwiftFatalErrorInGuard", () => {
	it("flags guard-else-fatalError on one line", () => {
		const code = 'guard let x = y else { fatalError("oops") }';
		expect(checkSwiftFatalErrorInGuard(code, "Foo.swift").length).toBe(1);
	});

	it("flags multi-line guard-else-fatalError", () => {
		const code = "guard let x = y else {\n  fatalError(\"oops\")\n}";
		expect(checkSwiftFatalErrorInGuard(code, "Foo.swift").length).toBe(1);
	});

	it("flags guard !condition with fatalError", () => {
		const code = 'guard !items.isEmpty else { fatalError("empty") }';
		expect(checkSwiftFatalErrorInGuard(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag guard with throw", () => {
		const code = "guard let x = y else { throw MyError.missing }";
		expect(checkSwiftFatalErrorInGuard(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag guard with return", () => {
		const code = "guard let x = y else { return nil }";
		expect(checkSwiftFatalErrorInGuard(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag fatalError outside a guard", () => {
		const code = 'if x == nil { fatalError("uh oh") }';
		expect(checkSwiftFatalErrorInGuard(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift files", () => {
		const code = "guard let x = y else { fatalError() }";
		expect(checkSwiftFatalErrorInGuard(code, "Foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "guard let x = y else { fatalError() }";
		expect(checkSwiftFatalErrorInGuard(code, "FooTests.swift")).toEqual([]);
	});
});

describe("checkSwiftPrintInViewBody", () => {
	it("flags print inside var body: some View", () => {
		const code = `
			struct FooView: View {
				var body: some View {
					let _ = print("rendered")
					Text("hi")
				}
			}
		`;
		expect(checkSwiftPrintInViewBody(code, "FooView.swift").length).toBe(1);
	});

	it("flags print inside body: View {}", () => {
		const code = `
			struct BarView: View {
				var body: View {
					let _ = print("debug")
					Text("hi")
				}
			}
		`;
		expect(checkSwiftPrintInViewBody(code, "BarView.swift").length).toBe(1);
	});

	it("does not flag print in .onAppear", () => {
		const code = `
			struct FooView: View {
				var body: some View {
					Text("hi").onAppear { }
				}
				func helper() { print("ok") }
			}
		`;
		expect(checkSwiftPrintInViewBody(code, "FooView.swift")).toEqual([]);
	});

	it("does not flag in a file that doesn't contain `View`", () => {
		const code = "class Foo { var x = 1 }";
		expect(checkSwiftPrintInViewBody(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag print outside body", () => {
		const code = `
			struct FooView: View {
				var body: some View {
					Text("hi")
				}
				func debugLog() { print("not in body") }
			}
		`;
		expect(checkSwiftPrintInViewBody(code, "FooView.swift")).toEqual([]);
	});

	it("does not flag in non-Swift files", () => {
		const code = "var body: some View { print('x') }";
		expect(checkSwiftPrintInViewBody(code, "FooView.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = `
			struct FooView: View {
				var body: some View {
					let _ = print("rendered")
					Text("hi")
				}
			}
		`;
		expect(checkSwiftPrintInViewBody(code, "FooViewTests.swift")).toEqual([]);
	});
});
