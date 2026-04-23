import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCachedUpdateNotice, isNewer, isUpdateCheckDisabled } from "../update-check.js";

describe("isNewer", () => {
	it("returns true when latest > current at patch level", () => {
		expect(isNewer("0.1.1", "0.1.0")).toBe(true);
	});

	it("returns true when latest > current at minor level", () => {
		expect(isNewer("0.2.0", "0.1.9")).toBe(true);
	});

	it("returns true when latest > current at major level", () => {
		expect(isNewer("1.0.0", "0.9.99")).toBe(true);
	});

	it("returns false when latest equals current", () => {
		expect(isNewer("0.1.0", "0.1.0")).toBe(false);
	});

	it("returns false when latest < current", () => {
		expect(isNewer("0.1.0", "0.1.1")).toBe(false);
	});

	it("ignores pre-release suffixes — stable never beats same-version stable", () => {
		expect(isNewer("0.1.0-beta.1", "0.1.0")).toBe(false);
	});

	it("handles versions with different component counts", () => {
		expect(isNewer("0.1", "0.0.9")).toBe(true);
	});

	it("treats non-numeric segments as 0 (defensive)", () => {
		expect(isNewer("0.1.x", "0.1.0")).toBe(false);
	});
});

describe("isUpdateCheckDisabled", () => {
	const origEnv = { ...process.env };
	const origIsTTY = process.stderr.isTTY;

	beforeEach(() => {
		// Start from a neutral baseline each test.
		delete process.env.INTERLINKED_NO_UPDATE_CHECK;
		delete process.env.CI;
		delete process.env.NODE_ENV;
		delete process.env.VITEST;
		Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
	});

	afterEach(() => {
		process.env = { ...origEnv };
		Object.defineProperty(process.stderr, "isTTY", { value: origIsTTY, configurable: true });
	});

	it("disabled when INTERLINKED_NO_UPDATE_CHECK=1", () => {
		process.env.INTERLINKED_NO_UPDATE_CHECK = "1";
		expect(isUpdateCheckDisabled()).toBe(true);
	});

	it("disabled in CI", () => {
		process.env.CI = "true";
		expect(isUpdateCheckDisabled()).toBe(true);
	});

	it("disabled in test env", () => {
		process.env.NODE_ENV = "test";
		expect(isUpdateCheckDisabled()).toBe(true);
	});

	it("disabled under vitest", () => {
		process.env.VITEST = "true";
		expect(isUpdateCheckDisabled()).toBe(true);
	});

	it("disabled when stderr is not a TTY", () => {
		Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
		expect(isUpdateCheckDisabled()).toBe(true);
	});

	it("enabled in a TTY with no opt-out flags set", () => {
		expect(isUpdateCheckDisabled()).toBe(false);
	});
});

describe("getCachedUpdateNotice", () => {
	beforeEach(() => {
		process.env.INTERLINKED_NO_UPDATE_CHECK = "1";
	});

	afterEach(() => {
		delete process.env.INTERLINKED_NO_UPDATE_CHECK;
	});

	it("returns null when update check is disabled", () => {
		// With opt-out set, no notice should ever print.
		expect(getCachedUpdateNotice("0.1.0")).toBe(null);
	});
});
