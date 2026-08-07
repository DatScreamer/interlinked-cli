import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execSyncMock, cpusMock, freememMock } = vi.hoisted(() => ({
	execSyncMock: vi.fn(),
	cpusMock: vi.fn(),
	freememMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execSync: execSyncMock,
}));

vi.mock("node:os", () => ({
	cpus: cpusMock,
	freemem: freememMock,
}));

import {
	bytesToGb,
	checkCpuCores,
	checkFreeMemoryGb,
	checkOrphanHarnessCount,
	formatGb,
	runSystemChecks,
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

	it("passes at the exact 4-core boundary (exact object)", () => {
		expect(checkCpuCores(4)).toEqual({
			name: "CPU cores",
			status: "pass",
			message: "4 cores — full parallel pipeline available",
		});
	});

	it("warns at 3 cores, one below the pass boundary (exact object)", () => {
		expect(checkCpuCores(3)).toEqual({
			name: "CPU cores",
			status: "warn",
			message: "3 cores — parallel pipeline will be throttled (recommended ≥ 4)",
		});
	});

	it("fails at 1 core (exact object)", () => {
		expect(checkCpuCores(1)).toEqual({
			name: "CPU cores",
			status: "fail",
			message: "1 cores — parallel pipeline disabled; expect serial check execution",
		});
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

	it("passes at the exact 4 GB boundary (exact object)", () => {
		expect(checkFreeMemoryGb(4 * 1024 ** 3)).toEqual({
			name: "Free memory",
			status: "pass",
			message: "4.0 GB free — comfortable headroom",
		});
	});

	it("warns at 3 GB, one below the pass boundary (exact object)", () => {
		expect(checkFreeMemoryGb(3 * 1024 ** 3)).toEqual({
			name: "Free memory",
			status: "warn",
			message:
				"3.0 GB free — consider closing apps before heavy verify runs (recommended ≥ 4 GB)",
		});
	});

	it("warns at the exact 2 GB boundary (exact object)", () => {
		expect(checkFreeMemoryGb(2 * 1024 ** 3)).toEqual({
			name: "Free memory",
			status: "warn",
			message:
				"2.0 GB free — consider closing apps before heavy verify runs (recommended ≥ 4 GB)",
		});
	});

	it("fails at 1 GB, one below the warn boundary (exact object)", () => {
		expect(checkFreeMemoryGb(1 * 1024 ** 3)).toEqual({
			name: "Free memory",
			status: "fail",
			message: "1.0 GB free — parallel pipeline may swap or OOM (need ≥ 2 GB)",
		});
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

	it("passes at 0 orphans (exact object)", () => {
		expect(checkOrphanHarnessCount(0)).toEqual({
			name: "Orphan harness daemons",
			status: "pass",
			message: "0 orphans — auto-reaper working as expected",
		});
	});

	it("uses singular 'daemon' at exactly 1 orphan (exact object)", () => {
		expect(checkOrphanHarnessCount(1)).toEqual({
			name: "Orphan harness daemons",
			status: "warn",
			message:
				"1 orphan daemon found — using extra memory. Run 'interlinked harness reap --force' to clean up",
		});
	});

	it("uses plural 'daemons' at 2 orphans (exact object)", () => {
		expect(checkOrphanHarnessCount(2)).toEqual({
			name: "Orphan harness daemons",
			status: "warn",
			message:
				"2 orphan daemons found — using extra memory. Run 'interlinked harness reap --force' to clean up",
		});
	});

	it("warns at 9 orphans, one below the fail boundary (exact object)", () => {
		expect(checkOrphanHarnessCount(9)).toEqual({
			name: "Orphan harness daemons",
			status: "warn",
			message:
				"9 orphan daemons found — using extra memory. Run 'interlinked harness reap --force' to clean up",
		});
	});

	it("fails at the exact 10-orphan boundary (exact object)", () => {
		expect(checkOrphanHarnessCount(10)).toEqual({
			name: "Orphan harness daemons",
			status: "fail",
			message:
				"10 orphan daemons found — significant memory pressure. Run 'interlinked harness reap --force' to clean up",
		});
	});
});

describe("runSystemChecks (mocked os/child_process — exercises countOrphanHarnesses)", () => {
	beforeEach(() => {
		cpusMock.mockReset().mockReturnValue(new Array(4));
		freememMock.mockReset().mockReturnValue(4 * 1024 ** 3);
		execSyncMock.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("calls ps with the exact command string and options", () => {
		execSyncMock.mockReturnValue("");
		runSystemChecks();
		expect(execSyncMock).toHaveBeenCalledWith("ps -ax -o pid=,ppid=,command= 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
		});
	});

	it("reports 0 orphans when ps output is empty", () => {
		execSyncMock.mockReturnValue("");
		const results = runSystemChecks();
		expect(results[2]).toEqual({
			name: "Orphan harness daemons",
			status: "pass",
			message: "0 orphans — auto-reaper working as expected",
		});
	});

	it("counts only lines that are matching, ppid<=1, AND a harness command — ignoring header/high-ppid/other-cmd lines", () => {
		const psOutput = [
			"  PID  PPID COMMAND",
			"  99999  1  /usr/local/lib/node_modules/interlinked-cli/dist/harness/server.js --daemon",
			"  100     50   /usr/bin/node other-process.js",
			"  200     1    /usr/bin/some-other-tool --flag",
		].join("\n");
		execSyncMock.mockReturnValue(psOutput);
		const results = runSystemChecks();
		expect(results[2]).toEqual({
			name: "Orphan harness daemons",
			status: "warn",
			message:
				"1 orphan daemon found — using extra memory. Run 'interlinked harness reap --force' to clean up",
		});
	});

	it("treats a multi-digit ppid text (e.g. '01') as ppid 1 and counts it as an orphan", () => {
		execSyncMock.mockReturnValue(
			"500  01  /path/interlinked-cli/dist/harness/server.js",
		);
		const results = runSystemChecks();
		expect(results[2]).toEqual({
			name: "Orphan harness daemons",
			status: "warn",
			message:
				"1 orphan daemon found — using extra memory. Run 'interlinked harness reap --force' to clean up",
		});
	});

	it("counts multiple orphan lines correctly (not decremented)", () => {
		const psOutput = [
			"1  1  /a/interlinked-cli/dist/harness/server.js",
			"2  1  /b/interlinked-cli/dist/harness/server.js",
			"3  0  /c/interlinked-cli/dist/harness/server.js",
		].join("\n");
		execSyncMock.mockReturnValue(psOutput);
		const results = runSystemChecks();
		expect(results[2]).toEqual({
			name: "Orphan harness daemons",
			status: "warn",
			message:
				"3 orphan daemons found — using extra memory. Run 'interlinked harness reap --force' to clean up",
		});
	});

	it("does not count a harness-matching process whose parent is still alive (ppid > 1)", () => {
		execSyncMock.mockReturnValue(
			"50  999  /usr/local/lib/node_modules/interlinked-cli/dist/harness/server.js",
		);
		const results = runSystemChecks();
		expect(results[2]).toEqual({
			name: "Orphan harness daemons",
			status: "pass",
			message: "0 orphans — auto-reaper working as expected",
		});
	});

	it("does not count a line whose digits aren't anchored at the start (garbled prefix)", () => {
		execSyncMock.mockReturnValue(
			"xx99999  1  /usr/local/lib/node_modules/interlinked-cli/dist/harness/server.js",
		);
		const results = runSystemChecks();
		expect(results[2]).toEqual({
			name: "Orphan harness daemons",
			status: "pass",
			message: "0 orphans — auto-reaper working as expected",
		});
	});

	it("returns 0 orphans when ps throws (caught, fails closed to non-scary)", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("ps: command not found");
		});
		const results = runSystemChecks();
		expect(results[2]).toEqual({
			name: "Orphan harness daemons",
			status: "pass",
			message: "0 orphans — auto-reaper working as expected",
		});
	});

	it("builds the full three-check array in order (cpu, memory, orphans)", () => {
		cpusMock.mockReset().mockReturnValue(new Array(8));
		freememMock.mockReset().mockReturnValue(8 * 1024 ** 3);
		execSyncMock.mockReturnValue("");
		const results = runSystemChecks();
		expect(results).toEqual([
			{
				name: "CPU cores",
				status: "pass",
				message: "8 cores — full parallel pipeline available",
			},
			{
				name: "Free memory",
				status: "pass",
				message: "8.0 GB free — comfortable headroom",
			},
			{
				name: "Orphan harness daemons",
				status: "pass",
				message: "0 orphans — auto-reaper working as expected",
			},
		]);
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
