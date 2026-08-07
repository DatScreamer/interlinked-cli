import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearVizStatus,
	formatVizStatus,
	isPidAlive,
	parseVizStatus,
	readLiveVizStatus,
	vizStatusPath,
	writeVizStatus,
} from "./status-file.js";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "viz-status-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const status = { url: "http://127.0.0.1:6403", pid: 4242, root: "/proj" };

describe("vizStatusPath", () => {
	it("resolves under the project's .interlinked dir", () => {
		expect(vizStatusPath("/proj")).toBe(join("/proj", ".interlinked", "viz.status"));
	});
});

describe("formatVizStatus / parseVizStatus", () => {
	it("round-trips a status through the kv format", () => {
		expect(parseVizStatus(formatVizStatus(status))).toEqual(status);
	});

	it("emits one key=value per line, as the statusline's grep expects", () => {
		expect(formatVizStatus(status).split("\n").filter(Boolean)).toEqual([
			"url=http://127.0.0.1:6403",
			"pid=4242",
			"root=/proj",
		]);
	});

	it("returns null when the url is missing", () => {
		expect(parseVizStatus("pid=1\n")).toBeNull();
	});

	it("returns null when the pid is absent, non-numeric, or non-positive", () => {
		expect(parseVizStatus("url=u\n")).toBeNull();
		expect(parseVizStatus("url=u\npid=abc\n")).toBeNull();
		expect(parseVizStatus("url=u\npid=0\n")).toBeNull();
	});

	it("tolerates unknown keys and blank lines", () => {
		expect(parseVizStatus("\nfuture=1\nurl=u\npid=7\n\n")).toEqual({ url: "u", pid: 7, root: "" });
	});
});

describe("isPidAlive", () => {
	it("is true for the current process", () => {
		expect(isPidAlive(process.pid)).toBe(true);
	});

	it("is false when the probe throws (no such process)", () => {
		expect(
			isPidAlive(999999, () => {
				throw new Error("ESRCH");
			}),
		).toBe(false);
	});
});

describe("writeVizStatus / clearVizStatus", () => {
	it("creates the .interlinked dir and writes the file", () => {
		expect(writeVizStatus(dir, status)).toBe(true);
		expect(existsSync(vizStatusPath(dir))).toBe(true);
	});

	it("removes the file, and is a no-op when already absent", () => {
		writeVizStatus(dir, status);
		clearVizStatus(dir);
		expect(existsSync(vizStatusPath(dir))).toBe(false);
		expect(() => clearVizStatus(dir)).not.toThrow();
	});

	it("returns false instead of throwing when the path is unwritable", () => {
		const blocked = join(dir, "blocker");
		writeFileSync(blocked, "x");
		expect(writeVizStatus(blocked, status)).toBe(false);
	});
});

describe("readLiveVizStatus", () => {
	it("returns the status when the owning process is alive", () => {
		writeVizStatus(dir, { ...status, pid: process.pid });
		expect(readLiveVizStatus(dir)).toMatchObject({ url: status.url, pid: process.pid });
	});

	it("returns null when the owning process is gone (stale file)", () => {
		writeVizStatus(dir, { ...status, pid: 999999 });
		expect(readLiveVizStatus(dir)).toBeNull();
	});

	it("returns null when there is no status file", () => {
		expect(readLiveVizStatus(dir)).toBeNull();
	});

	it("returns null when the file is malformed", () => {
		writeVizStatus(dir, status);
		writeFileSync(vizStatusPath(dir), "garbage");
		expect(readLiveVizStatus(dir)).toBeNull();
	});
});
