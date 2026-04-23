import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectClients } from "../settings.js";

describe("detectClients", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "settings-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns one entry per registered client", () => {
		const clients = detectClients(tmp);
		// At minimum claude + copilot are registered.
		expect(clients.length).toBeGreaterThanOrEqual(2);
		expect(clients.map((c) => c.name)).toEqual(expect.arrayContaining(["claude", "copilot"]));
	});

	it("marks exists=false when the config dir is missing", () => {
		const clients = detectClients(tmp);
		for (const c of clients) {
			expect(c.exists, `${c.name} should not exist in fresh tmpdir`).toBe(false);
		}
	});

	it("marks exists=true once the config dir is created", () => {
		mkdirSync(join(tmp, ".claude"), { recursive: true });
		const clients = detectClients(tmp);
		const claude = clients.find((c) => c.name === "claude");
		expect(claude?.exists).toBe(true);
	});

	it("settingsPath is absolute and under cwd", () => {
		const clients = detectClients(tmp);
		for (const c of clients) {
			expect(c.settingsPath.startsWith(tmp)).toBe(true);
			expect(c.settingsPath.endsWith(".json")).toBe(true);
		}
	});
});
