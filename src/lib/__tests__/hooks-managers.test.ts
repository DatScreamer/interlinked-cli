import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	unlinkSync: vi.fn(),
	chmodSync: vi.fn(),
	rmSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";
import { detectHookManagers } from "../hooks.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("detectHookManagers", () => {
	it("detects husky via .husky/ directory", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			return String(path).endsWith(".husky");
		});

		const result = detectHookManagers("/test/project");
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("husky");
		expect(result[0].detected_at).toBe(".husky/");
	});

	it("detects husky via package.json devDependencies", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			return String(path).endsWith("package.json");
		});
		mockReadFileSync.mockReturnValue(JSON.stringify({ devDependencies: { husky: "^9.0.0" } }));

		const result = detectHookManagers("/test/project");
		expect(result.some((m) => m.name === "husky")).toBe(true);
	});

	it("detects husky via prepare script", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			return String(path).endsWith("package.json");
		});
		mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { prepare: "husky install" } }));

		const result = detectHookManagers("/test/project");
		expect(result.some((m) => m.name === "husky")).toBe(true);
	});

	it("detects lefthook via lefthook.yml", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			return String(path).endsWith("lefthook.yml");
		});

		const result = detectHookManagers("/test/project");
		expect(result.some((m) => m.name === "lefthook")).toBe(true);
		expect(result.find((m) => m.name === "lefthook")!.detected_at).toBe("lefthook.yml");
	});

	it("detects overcommit via .overcommit.yml", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			return String(path).endsWith(".overcommit.yml");
		});

		const result = detectHookManagers("/test/project");
		expect(result.some((m) => m.name === "overcommit")).toBe(true);
	});

	it("returns empty array when nothing detected", () => {
		mockExistsSync.mockReturnValue(false);
		const result = detectHookManagers("/test/project");
		expect(result).toHaveLength(0);
	});

	it("detects multiple managers", () => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			const p = String(path);
			return p.endsWith(".husky") || p.endsWith(".overcommit.yml");
		});

		const result = detectHookManagers("/test/project");
		expect(result.length).toBe(2);
		expect(result.map((m) => m.name).sort()).toEqual(["husky", "overcommit"]);
	});
});
