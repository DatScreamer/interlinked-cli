import { describe, expect, it } from "vitest";
import {
	bytesToGb,
	checkCpuCores,
	checkFreeMemoryGb,
	checkOrphanHarnessCount,
	formatGb,
} from "./doctor-system.js";

describe("checkCpuCores", () => {
	it("passes when at least 4 cores are available", () => {
		const r = checkCpuCores(8);
		expect(r.status).toBe("pass");
	});

	it("warns when between 2 and 3 cores", () => {
		const r = checkCpuCores(2);
		expect(r.status).toBe("warn");
	});

	it("fails when only 1 core", () => {
		const r = checkCpuCores(1);
		expect(r.status).toBe("fail");
	});

	it("includes the core count in the message", () => {
		expect(checkCpuCores(6).message).toContain("6");
	});
});

describe("checkFreeMemoryGb", () => {
	it("passes when free memory is at least 4 GB", () => {
		const r = checkFreeMemoryGb(8 * 1024 ** 3);
		expect(r.status).toBe("pass");
	});

	it("warns when free memory is between 2 and 4 GB", () => {
		const r = checkFreeMemoryGb(3 * 1024 ** 3);
		expect(r.status).toBe("warn");
	});

	it("fails when free memory is below 2 GB", () => {
		const r = checkFreeMemoryGb(1 * 1024 ** 3);
		expect(r.status).toBe("fail");
	});

	it("formats memory as a GB-precision string", () => {
		const r = checkFreeMemoryGb(8.5 * 1024 ** 3);
		expect(r.message).toMatch(/8\.5/);
	});
});

describe("checkOrphanHarnessCount", () => {
	it("passes when no orphans", () => {
		const r = checkOrphanHarnessCount(0);
		expect(r.status).toBe("pass");
	});

	it("warns on a small number of orphans", () => {
		const r = checkOrphanHarnessCount(3);
		expect(r.status).toBe("warn");
	});

	it("fails on a large number of orphans (≥10)", () => {
		const r = checkOrphanHarnessCount(15);
		expect(r.status).toBe("fail");
	});

	it("provides a fix hint when orphans are present", () => {
		const r = checkOrphanHarnessCount(5);
		expect(r.message.toLowerCase()).toContain("reap");
	});
});

describe("bytesToGb / formatGb", () => {
	it("bytesToGb converts byte counts to GB doubles", () => {
		expect(bytesToGb(1024 ** 3)).toBeCloseTo(1, 5);
		expect(bytesToGb(2 * 1024 ** 3)).toBeCloseTo(2, 5);
	});

	it("formatGb renders a single-decimal string with a `GB` suffix", () => {
		expect(formatGb(8.5 * 1024 ** 3)).toBe("8.5 GB");
	});
});
