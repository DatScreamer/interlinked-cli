import { describe, expect, it } from "vitest";
import {
	checkSwiftCombineNoStore,
	checkSwiftNotificationObserverNoRemoval,
	checkSwiftTimerNoInvalidate,
} from "./swift-lifecycle.js";

describe("checkSwiftNotificationObserverNoRemoval", () => {
	it("flags addObserver without removeObserver in the file", () => {
		const code = `
			class Foo {
				init() {
					NotificationCenter.default.addObserver(self, selector: #selector(handle), name: .x, object: nil)
				}
			}
		`;
		expect(checkSwiftNotificationObserverNoRemoval(code, "Foo.swift").length).toBe(1);
	});

	it("flags block-based addObserver(forName:object:queue:using:) without removal", () => {
		const code = `
			class Bar {
				init() {
					NotificationCenter.default.addObserver(forName: .x, object: nil, queue: .main) { _ in }
				}
			}
		`;
		expect(checkSwiftNotificationObserverNoRemoval(code, "Bar.swift").length).toBe(1);
	});

	it("flags multiple addObserver calls when no remove anywhere", () => {
		const code = `
			NotificationCenter.default.addObserver(self, selector: #selector(a), name: .a, object: nil)
			NotificationCenter.default.addObserver(self, selector: #selector(b), name: .b, object: nil)
		`;
		expect(checkSwiftNotificationObserverNoRemoval(code, "X.swift").length).toBe(2);
	});

	it("N1: does not flag when removeObserver is present somewhere in the file (removal in deinit)", () => {
		const code = `
			class Foo {
				init() {
					NotificationCenter.default.addObserver(self, selector: #selector(handle), name: .x, object: nil)
				}
				deinit {
					NotificationCenter.default.removeObserver(self)
				}
			}
		`;
		expect(checkSwiftNotificationObserverNoRemoval(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag a file with no addObserver", () => {
		const code = "class Foo { func bar() {} }";
		expect(checkSwiftNotificationObserverNoRemoval(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift files", () => {
		const code = "NotificationCenter.default.addObserver(self)";
		expect(checkSwiftNotificationObserverNoRemoval(code, "Foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code =
			"NotificationCenter.default.addObserver(self, selector: #selector(x), name: .y, object: nil)";
		expect(checkSwiftNotificationObserverNoRemoval(code, "FooTests.swift")).toEqual([]);
	});
});

describe("checkSwiftTimerNoInvalidate", () => {
	it("flags Timer.scheduledTimer without invalidate", () => {
		const code = `
			class Foo {
				init() {
					Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in }
				}
			}
		`;
		expect(checkSwiftTimerNoInvalidate(code, "Foo.swift").length).toBe(1);
	});

	it("flags multiple Timer.scheduledTimer calls", () => {
		const code = `
			Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in }
			Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { _ in }
		`;
		expect(checkSwiftTimerNoInvalidate(code, "X.swift").length).toBe(2);
	});

	it("flags scheduledTimer with selector form", () => {
		const code =
			"Timer.scheduledTimer(timeInterval: 1, target: self, selector: #selector(tick), userInfo: nil, repeats: true)";
		expect(checkSwiftTimerNoInvalidate(code, "X.swift").length).toBe(1);
	});

	it("N1: does not flag when timer.invalidate() is present", () => {
		const code = `
			class Foo {
				var t: Timer?
				init() {
					t = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in }
				}
				deinit { t?.invalidate() }
			}
		`;
		expect(checkSwiftTimerNoInvalidate(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag a file with no scheduledTimer", () => {
		const code = "class Foo { func bar() {} }";
		expect(checkSwiftTimerNoInvalidate(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift files", () => {
		const code = "Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in }";
		expect(checkSwiftTimerNoInvalidate(code, "Foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in }";
		expect(checkSwiftTimerNoInvalidate(code, "FooTests.swift")).toEqual([]);
	});
});

describe("checkSwiftCombineNoStore", () => {
	it("flags .sink without .store(in:)", () => {
		const code = `
			class Foo {
				init() {
					publisher.sink { value in print(value) }
				}
			}
		`;
		expect(checkSwiftCombineNoStore(code, "Foo.swift").length).toBe(1);
	});

	it("flags .assign(to:on:) without .store(in:)", () => {
		const code = "publisher.assign(to: \\.name, on: self)";
		expect(checkSwiftCombineNoStore(code, "Foo.swift").length).toBe(1);
	});

	it("flags chained .sink missing store", () => {
		const code = "publisher.map { $0 * 2 }.sink { print($0) }";
		expect(checkSwiftCombineNoStore(code, "Foo.swift").length).toBe(1);
	});

	it("N1: does not flag when .store(in: &cancellables) is present", () => {
		const code = `
			class Foo {
				var cancellables = Set<AnyCancellable>()
				init() {
					publisher.sink { value in print(value) }.store(in: &cancellables)
				}
			}
		`;
		expect(checkSwiftCombineNoStore(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag when .store(in: &bag) is present", () => {
		const code = "publisher.assign(to: \\.name, on: self).store(in: &bag)";
		expect(checkSwiftCombineNoStore(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag a file with no .sink/.assign", () => {
		const code = "class Foo { func bar() {} }";
		expect(checkSwiftCombineNoStore(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift files", () => {
		const code = "publisher.sink { print($0) }";
		expect(checkSwiftCombineNoStore(code, "Foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "publisher.sink { print($0) }";
		expect(checkSwiftCombineNoStore(code, "FooTests.swift")).toEqual([]);
	});
});
