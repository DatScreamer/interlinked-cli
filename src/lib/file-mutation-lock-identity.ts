// Portable process identity for cross-process file-mutation locks. Linux
// exposes stable boot/start identifiers through /proc. macOS needs one cached
// sysctl and ps observation per hook process; the result is reused by both
// activity and collection appends.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PROCESS_IDENTITY_CACHE_MS = 1_000;

export interface FileMutationProcessIdentity {
	bootId: string | null;
	bootStartedAtMs: number | null;
	processStartId: string | null;
	processStartedAtMs: number | null;
}

interface KernelIdentity {
	id: string;
	startedAtMs: number | null;
}

let cachedBootIdentity: KernelIdentity | null | undefined;
let cachedLinuxClockTicks: number | null | undefined;
let cachedOwnIdentity: FileMutationProcessIdentity | undefined;
let recentForeignIdentity:
	| { pid: number; observedAtMs: number; identity: FileMutationProcessIdentity }
	| undefined;

function readBootIdentity(): KernelIdentity | null {
	if (cachedBootIdentity !== undefined) return cachedBootIdentity;
	try {
		if (process.platform === "linux") {
			const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const seconds = /^btime\s+(\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
			const startedAtMs = seconds ? Number(seconds) * 1_000 : null;
			cachedBootIdentity = id ? { id: `linux:${id}`, startedAtMs } : null;
			return cachedBootIdentity;
		}
		if (process.platform === "darwin") {
			const output = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1_000,
			});
			const seconds = /\bsec\s*=\s*(\d+)/.exec(output)?.[1];
			cachedBootIdentity = seconds
				? { id: `darwin:${seconds}`, startedAtMs: Number(seconds) * 1_000 }
				: null;
			return cachedBootIdentity;
		}
	} catch (error) {
		// Identity is a recovery aid, never permission to bypass a live PID.
		void error;
	}
	cachedBootIdentity = null;
	return null;
}

function readLinuxClockTicks(): number | null {
	if (cachedLinuxClockTicks !== undefined) return cachedLinuxClockTicks;
	for (const executable of ["/usr/bin/getconf", "/bin/getconf"]) {
		try {
			const output = execFileSync(executable, ["CLK_TCK"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1_000,
			}).trim();
			const ticks = Number(output);
			if (Number.isFinite(ticks) && Number.isSafeInteger(ticks) && ticks > 0) {
				cachedLinuxClockTicks = ticks;
				return ticks;
			}
		} catch (error) {
			void error;
		}
	}
	cachedLinuxClockTicks = null;
	return null;
}

function readLinuxProcessStartIdentity(pid: number): KernelIdentity | null {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const close = stat.lastIndexOf(")");
	const startTicks = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/)[19] : undefined;
	if (!startTicks || !/^\d+$/.test(startTicks)) return null;
	const bootStartedAtMs = readBootIdentity()?.startedAtMs;
	const ticksPerSecond = readLinuxClockTicks();
	const startedAtMs =
		bootStartedAtMs !== null && bootStartedAtMs !== undefined && ticksPerSecond
			? bootStartedAtMs + (Number(startTicks) / ticksPerSecond) * 1_000
			: null;
	return { id: `linux:${startTicks}`, startedAtMs };
}

function readProcessStartIdentity(pid: number): KernelIdentity | null {
	try {
		if (process.platform === "linux") return readLinuxProcessStartIdentity(pid);
		if (process.platform === "darwin") {
			const output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
				encoding: "utf8",
				env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
				maxBuffer: 4_096,
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1_000,
			}).trim().replace(/\s+/g, " ");
			const startedAtMs = Date.parse(`${output} UTC`);
			return output && Number.isFinite(startedAtMs)
				? { id: `darwin:${output}`, startedAtMs }
				: null;
		}
	} catch (error) {
		// The process may have exited between kill(0) and this observation.
		void error;
	}
	return null;
}

/** Observe a PID's boot and process-start identity. Own identity is immutable
 * and cached for the process lifetime; foreign identity is cached for one
 * second so a contended lock cannot spawn ps repeatedly. */
export function readFileMutationProcessIdentity(
	pid: number,
	now: number,
): FileMutationProcessIdentity {
	if (pid === process.pid && cachedOwnIdentity) return cachedOwnIdentity;
	if (
		pid !== process.pid &&
		recentForeignIdentity?.pid === pid &&
		now - recentForeignIdentity.observedAtMs < PROCESS_IDENTITY_CACHE_MS
	) return recentForeignIdentity.identity;
	const boot = readBootIdentity();
	const start = readProcessStartIdentity(pid);
	const identity = {
		bootId: boot?.id ?? null,
		bootStartedAtMs: boot?.startedAtMs ?? null,
		processStartId: start?.id ?? null,
		processStartedAtMs: start?.startedAtMs ?? null,
	};
	if (pid === process.pid) cachedOwnIdentity = identity;
	else recentForeignIdentity = { pid, observedAtMs: now, identity };
	return identity;
}
