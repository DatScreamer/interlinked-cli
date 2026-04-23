import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	existsSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";
import { detectHookManagers } from "../hook-detection.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("detectHookManagers (hook-detection.ts)", () => {
	it("detects husky via .husky/ directory", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) =>
			String(path).endsWith(".husky"),
		);

		const result = detectHookManagers("/test/project");
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("husky");
		expect(result[0].detected_at).toBe(".husky/");
	});

	it("detects husky via package.json devDependencies", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) =>
			String(path).endsWith("package.json"),
		);
		mockReadFileSync.mockReturnValue(JSON.stringify({ devDependencies: { husky: "^9.0.0" } }));

		const result = detectHookManagers("/test/project");
		expect(result.some((m) => m.name === "husky")).toBe(true);
		expect(result.find((m) => m.name === "husky")?.detected_at).toBe("package.json");
	});

	it("detects husky via prepare script", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) =>
			String(path).endsWith("package.json"),
		);
		mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { prepare: "husky install" } }));

		const result = detectHookManagers("/test/project");
		expect(result.some((m) => m.name === "husky")).toBe(true);
	});

	it("detects lefthook via lefthook.yml", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) =>
			String(path).endsWith("lefthook.yml"),
		);

		const result = detectHookManagers("/test/project");
		expect(result.some((m) => m.name === "lefthook")).toBe(true);
		const lefthook = result.find((m) => m.name === "lefthook");
		expect(lefthook?.detected_at).toBe("lefthook.yml");
	});

	it("detects lefthook via package.json dependencies", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) =>
			String(path).endsWith("package.json"),
		);
		mockReadFileSync.mockReturnValue(JSON.stringify({ dependencies: { lefthook: "^1.0.0" } }));

		const result = detectHookManagers("/test/project");
		expect(result.some((m) => m.name === "lefthook")).toBe(true);
	});

	it("detects overcommit via .overcommit.yml", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) =>
			String(path).endsWith(".overcommit.yml"),
		);

		const result = detectHookManagers("/test/project");
		expect(result.some((m) => m.name === "overcommit")).toBe(true);
	});

	it("returns empty array when nothing detected", () => {
		mockExistsSync.mockReturnValue(false);
		const result = detectHookManagers("/test/project");
		expect(result).toHaveLength(0);
	});

	it("detects multiple managers together", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			const p = String(path);
			return p.endsWith(".husky") || p.endsWith(".overcommit.yml");
		});

		const result = detectHookManagers("/test/project");
		expect(result.length).toBe(2);
		expect(result.map((m) => m.name).sort()).toEqual(["husky", "overcommit"]);
	});

	it("survives malformed package.json without throwing", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) =>
			String(path).endsWith("package.json"),
		);
		mockReadFileSync.mockReturnValue("{ not valid json");

		expect(() => detectHookManagers("/test/project")).not.toThrow();
		expect(detectHookManagers("/test/project")).toEqual([]);
	});

	it("survives non-object package.json (arrays/primitives)", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) =>
			String(path).endsWith("package.json"),
		);
		// JSON.parse("[1,2,3]") returns an array — we must not crash or report husky.
		mockReadFileSync.mockReturnValue("[1,2,3]");

		expect(() => detectHookManagers("/test/project")).not.toThrow();
		expect(detectHookManagers("/test/project")).toEqual([]);
	});
});
