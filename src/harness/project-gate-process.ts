// Shared child-process exit interpretation for commit/push project gates.

/**
 * A child killed by a signal surfaces differently per platform and wrapper:
 * macOS reports `signal` directly, while Linux npm can re-encode a script's
 * signal death as `status = 128 + signum` with `signal: null`.
 */
const SIGNAL_EXIT_BASE = 128;

export function diedBySignal(result: {
	status: number | null;
	signal: NodeJS.Signals | null;
}): boolean {
	return result.signal !== null || result.status === null || result.status >= SIGNAL_EXIT_BASE;
}

const SIGNAL_NAME_BY_EXIT_CODE: Partial<Record<number, string>> = {
	129: "SIGHUP",
	130: "SIGINT",
	131: "SIGQUIT",
	132: "SIGILL",
	133: "SIGTRAP",
	134: "SIGABRT",
	135: "SIGBUS",
	136: "SIGFPE",
	137: "SIGKILL",
	138: "SIGUSR1",
	139: "SIGSEGV",
	140: "SIGUSR2",
	141: "SIGPIPE",
	142: "SIGALRM",
	143: "SIGTERM",
};

function describeSignalFromExitCode(status: number): string | null {
	if (status <= SIGNAL_EXIT_BASE) return null;
	const name = SIGNAL_NAME_BY_EXIT_CODE[status];
	if (!name) return null;
	return `signal ${name} (exit ${status})`;
}

export function describeDeath(result: {
	status: number | null;
	signal: NodeJS.Signals | null;
}): string {
	if (result.signal) return `signal ${result.signal}`;
	if (result.status === null) return "no exit status";
	const bySignalCode = describeSignalFromExitCode(result.status);
	if (bySignalCode) return bySignalCode;
	return `exit ${result.status}`;
}
