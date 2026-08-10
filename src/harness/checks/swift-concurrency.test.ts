import { describe, expect, it } from "vitest";
import {
	checkSwiftDispatchMainSync,
	checkSwiftTaskSleepLegacy,
} from "./swift-concurrency.js";

describe("checkSwiftDispatchMainSync", () => {
	it("flags DispatchQueue.main.sync", () => {
		const code = "func f() { DispatchQueue.main.sync { doStuff() } }";
		expect(checkSwiftDispatchMainSync(code, "View.swift").length).toBe(1);
	});

	it("flags DispatchQueue.main.sync with extra whitespace", () => {
		const code = "DispatchQueue . main . sync { x() }";
		expect(checkSwiftDispatchMainSync(code, "View.swift").length).toBe(1);
	});

	it("flags multiple occurrences", () => {
		const code =
			"func a() { DispatchQueue.main.sync {} }\nfunc b() { DispatchQueue.main.sync {} }";
		expect(checkSwiftDispatchMainSync(code, "View.swift").length).toBe(2);
	});

	it("does not flag DispatchQueue.main.async (the safe variant)", () => {
		const code = "DispatchQueue.main.async { update() }";
		expect(checkSwiftDispatchMainSync(code, "View.swift")).toEqual([]);
	});

	it("does not flag a global queue sync (different deadlock surface)", () => {
		const code = "DispatchQueue.global().sync { compute() }";
		expect(checkSwiftDispatchMainSync(code, "View.swift")).toEqual([]);
	});

	it("does not flag inside a string literal", () => {
		const code = 'let s = "do not call DispatchQueue.main.sync here"';
		expect(checkSwiftDispatchMainSync(code, "View.swift")).toEqual([]);
	});

	it("does not flag in non-Swift files", () => {
		const code = "DispatchQueue.main.sync { update() }";
		expect(checkSwiftDispatchMainSync(code, "View.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "DispatchQueue.main.sync { update() }";
		expect(checkSwiftDispatchMainSync(code, "ViewTests.swift")).toEqual([]);
	});

	it("N1: checkSwiftDispatchMainSync does not fire when the call is only in a comment", () => {
		const code = "// TODO: replace DispatchQueue.main.sync { legacy() } with async";
		expect(checkSwiftDispatchMainSync(code, "View.swift")).toEqual([]);
	});

	it("N2: checkSwiftDispatchMainSync does not fire on a custom queue named 'main'", () => {
		const code = 'let queue = DispatchQueue(label: "main")\nqueue.sync { doStuff() }';
		expect(checkSwiftDispatchMainSync(code, "View.swift")).toEqual([]);
	});
});

describe("checkSwiftTaskSleepLegacy", () => {
	it("flags Task.sleep(nanoseconds:)", () => {
		const code = "try await Task.sleep(nanoseconds: 1_000_000_000)";
		expect(checkSwiftTaskSleepLegacy(code, "Service.swift").length).toBe(1);
	});

	it("flags Task.sleep with explicit type prefix", () => {
		const code = "try await _Concurrency.Task.sleep(nanoseconds: 500_000)";
		expect(checkSwiftTaskSleepLegacy(code, "Service.swift").length).toBe(1);
	});

	it("flags multiple occurrences", () => {
		const code =
			"try await Task.sleep(nanoseconds: 1)\ntry await Task.sleep(nanoseconds: 2)";
		expect(checkSwiftTaskSleepLegacy(code, "Service.swift").length).toBe(2);
	});

	it("does not flag Task.sleep(for:)", () => {
		const code = "try await Task.sleep(for: .seconds(1))";
		expect(checkSwiftTaskSleepLegacy(code, "Service.swift")).toEqual([]);
	});

	it("does not flag Task.sleep(until:clock:)", () => {
		const code = "try await Task.sleep(until: .now + .seconds(1), clock: .continuous)";
		expect(checkSwiftTaskSleepLegacy(code, "Service.swift")).toEqual([]);
	});

	it("does not flag inside a string", () => {
		const code = 'let s = "Task.sleep(nanoseconds: 1) is deprecated"';
		expect(checkSwiftTaskSleepLegacy(code, "Service.swift")).toEqual([]);
	});

	it("does not flag in non-Swift files", () => {
		const code = "Task.sleep(nanoseconds: 100)";
		expect(checkSwiftTaskSleepLegacy(code, "Service.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "try await Task.sleep(nanoseconds: 100)";
		expect(checkSwiftTaskSleepLegacy(code, "ServiceTests.swift")).toEqual([]);
	});

	it("N1: checkSwiftTaskSleepLegacy does not fire when the call is only in a comment", () => {
		const code = "// migrate: Task.sleep(nanoseconds: 1_000_000_000) is deprecated";
		expect(checkSwiftTaskSleepLegacy(code, "Service.swift")).toEqual([]);
	});

	it("N2: checkSwiftTaskSleepLegacy does not fire on a different receiver's sleep(nanoseconds:)", () => {
		const code = "await MockClock.sleep(nanoseconds: 1_000)";
		expect(checkSwiftTaskSleepLegacy(code, "Service.swift")).toEqual([]);
	});
});
