// ===========================================
// interlinked doctor — System-requirements helpers
// ===========================================
// Surfaces CPU / memory / disk / tool / orphan-daemon signals from inside
// the existing `doctor` command. Phase E.1 of the Free CLI Phase-2 roadmap.
//
// Each helper returns a `CheckResult` shaped like the rest of the doctor
// command's results, so the caller can `push(...checks)` and render uniformly.
// Pure computation where possible — the outer command does the os/process
// reads and passes raw values in. Lets the entire surface be unit-testable
// without monkey-patching `os` or `child_process`.

import { execSync } from "node:child_process";
import { cpus, freemem } from "node:os";

export type CheckStatus = "pass" | "fail" | "warn";

export interface SystemCheckResult {
	name: string;
	status: CheckStatus;
	message: string;
}

const BYTES_PER_GB = 1024 ** 3;

/** Convert raw bytes to gigabytes as a double. */
export function bytesToGb(bytes: number): number {
	return bytes / BYTES_PER_GB;
}

/** Render a byte count as a one-decimal `<n>.<m> GB` string. */
export function formatGb(bytes: number): string {
	return `${bytesToGb(bytes).toFixed(1)} GB`;
}

/**
 * Check CPU core count. The post-event check pipeline runs ~6 concurrent
 * subprocesses at peak (Phase A); below 4 cores parallelism is throttled,
 * below 2 it stops being parallel at all.
 *
 * Pass ≥ 4 cores. Warn 2–3. Fail < 2 (single-core machine; some checks
 * will starve).
 */
export function checkCpuCores(coreCount: number): SystemCheckResult {
	if (coreCount >= 4) {
		return {
			name: "CPU cores",
			status: "pass",
			message: `${coreCount} cores — full parallel pipeline available`,
		};
	}
	if (coreCount >= 2) {
		return {
			name: "CPU cores",
			status: "warn",
			message: `${coreCount} cores — parallel pipeline will be throttled (recommended ≥ 4)`,
		};
	}
	return {
		name: "CPU cores",
		status: "fail",
		message: `${coreCount} cores — parallel pipeline disabled; expect serial check execution`,
	};
}

/**
 * Check available physical memory. The daemon's working set is ~200–500 MB;
 * the parallel check pipeline peaks at ~2 GB; we want at least 4 GB free for
 * comfortable operation alongside an editor and other apps.
 */
export function checkFreeMemoryGb(freeMemoryBytes: number): SystemCheckResult {
	const gb = bytesToGb(freeMemoryBytes);
	if (gb >= 4) {
		return {
			name: "Free memory",
			status: "pass",
			message: `${gb.toFixed(1)} GB free — comfortable headroom`,
		};
	}
	if (gb >= 2) {
		return {
			name: "Free memory",
			status: "warn",
			message: `${gb.toFixed(1)} GB free — consider closing apps before heavy verify runs (recommended ≥ 4 GB)`,
		};
	}
	return {
		name: "Free memory",
		status: "fail",
		message: `${gb.toFixed(1)} GB free — parallel pipeline may swap or OOM (need ≥ 2 GB)`,
	};
}

/**
 * Check for orphan harness daemons. The daemon is always-on by default —
 * each CWD that's hosted a session keeps its harness alive until the user
 * runs `interlinked harness stop` or `interlinked harness clean`. A growing
 * count across many directories suggests the user should run `harness clean`
 * to reclaim daemons attached to repos they're no longer working in.
 */
export function checkOrphanHarnessCount(orphanCount: number): SystemCheckResult {
	if (orphanCount === 0) {
		return {
			name: "Orphan harness daemons",
			status: "pass",
			message: "0 orphans — auto-reaper working as expected",
		};
	}
	const fixHint = ` Run 'interlinked harness reap --force' to clean up`;
	if (orphanCount < 10) {
		return {
			name: "Orphan harness daemons",
			status: "warn",
			message: `${orphanCount} orphan daemon${orphanCount === 1 ? "" : "s"} found — using extra memory.${fixHint}`,
		};
	}
	return {
		name: "Orphan harness daemons",
		status: "fail",
		message: `${orphanCount} orphan daemons found — significant memory pressure.${fixHint}`,
	};
}

/**
 * Inspect the CPU + memory state, plus list orphan harness daemons
 * (interlinked-cli/dist/harness/server processes whose ppid ≤ 1).
 *
 * Combines all three into a single `runSystemChecks()` call the doctor
 * command consumes. Pure-shell side effects only happen inside; the
 * underlying primitives are unit-tested via the other exports above.
 */
export function runSystemChecks(): SystemCheckResult[] {
	const results: SystemCheckResult[] = [];
	results.push(checkCpuCores(cpus().length));
	results.push(checkFreeMemoryGb(freemem()));
	results.push(checkOrphanHarnessCount(countOrphanHarnesses()));
	return results;
}

/**
 * Count interlinked harness daemons whose parent has exited (ppid ≤ 1).
 * Best-effort: returns 0 on any `ps` failure rather than fabricating a
 * scary number. Mirrors the selection logic in
 * `commands/harness.ts:reapOrphanHarnesses` — keep them consistent if
 * either is updated.
 */
function countOrphanHarnesses(): number {
	try {
		const ps = execSync("ps -ax -o pid=,ppid=,command= 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
		});
		let count = 0;
		for (const line of ps.split("\n")) {
			const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
			if (!m) continue;
			const ppid = Number.parseInt(m[2] as string, 10);
			const cmd = m[3] as string;
			if (Number.isNaN(ppid)) continue;
			if (ppid > 1) continue; // Has a living parent — not orphan
			if (!cmd.includes("interlinked-cli/dist/harness/server")) continue;
			count++;
		}
		return count;
	} catch (e) {
		void e;
		return 0;
	}
}
