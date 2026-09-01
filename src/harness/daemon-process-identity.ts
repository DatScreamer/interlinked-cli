// ===========================================
// Harness daemon process identity
// ===========================================
// A PID names a process only temporarily. Every signal must bind to the same
// verified daemon instance so stale files and PID reuse cannot kill unrelated
// work.

import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export type ProcessIdentityReader = (cwd: string, pid: number) => string | null;

function psField(pid: number, field: "comm" | "lstart" | "command"): string {
	return execFileSync("ps", ["-p", String(pid), "-o", `${field}=`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

function daemonScriptOperand(command: string): string | null {
	const runtimeEnd = command.search(/\s/);
	if (runtimeEnd < 0) return null;
	let remainder = command.slice(runtimeEnd).trimStart();
	for (const option of [/^--max-old-space-size=\d+\s+/, /^--expose-gc\s+/]) {
		const match = option.exec(remainder);
		if (match) remainder = remainder.slice(match[0].length);
	}
	const cwdMarker = remainder.search(/ --cwd(?:=| )/);
	if (cwdMarker < 0) return null;
	const operand = remainder.slice(0, cwdMarker).trim();
	// Generated daemon commands have exactly one script operand after the two
	// supported Node flags. A flag-shaped token here means the daemon filename
	// was merely mentioned by another Node program (for example node -e or
	// app.js --note .../server.js), which must never authenticate a signal.
	if (!operand.startsWith("/") || /\s/.test(operand)) return null;
	return operand;
}

function daemonOptionSuffix(command: string, cwd: string): string | null {
	const markers = [` --cwd ${cwd}`, ` --cwd=${cwd}`];
	for (const marker of markers) {
		const index = command.indexOf(marker);
		if (index < 0) continue;
		const suffix = command.slice(index + marker.length);
		if (
			/^(?:\s+--protocol(?:=|\s+)(?:raw|framed|dual)|\s+--session-id(?:=|\s+)[A-Za-z0-9_-]{1,64}|\s+--verbose)*$/.test(
				suffix,
			)
		) {
			return suffix;
		}
	}
	return null;
}

/** Does this argv describe an Interlinked daemon serving exactly `cwd`? */
export function isHarnessDaemonCommandForCwd(args: { command: string; cwd: string }): boolean {
	const { command, cwd } = args;
	const script = daemonScriptOperand(command.trim());
	if (script === null) return false;
	if (!/(?:\/dist\/harness\/server\.js|\/src\/harness\/server\.ts|\/\.interlinked\/harness-server)$/.test(script)) {
		return false;
	}
	return daemonOptionSuffix(command, cwd) !== null;
}

/** Fail-closed identity: runtime, daemon entry, project, process start, argv. */
export function readHarnessProcessIdentity(cwd: string, pid: number): string | null {
	try {
		const runtime = basename(psField(pid, "comm"));
		if (runtime !== "node" && runtime !== "bun") return null;
		const command = psField(pid, "command");
		if (!isHarnessDaemonCommandForCwd({ command, cwd })) return null;
		const startedAt = psField(pid, "lstart");
		return startedAt === "" ? null : `${startedAt}\n${command}`;
	} catch {
		return null;
	}
}

export function verifiedProcessIdentities(
	cwd: string,
	pids: Iterable<number>,
	identify: ProcessIdentityReader,
): Map<number, string> {
	const verified = new Map<number, string>();
	for (const pid of pids) {
		const identity = identify(cwd, pid);
		if (identity !== null) verified.set(pid, identity);
	}
	return verified;
}

export function sameProcessIdentity(args: {
	cwd: string;
	pid: number;
	expectedIdentity: string;
	isAlive: (pid: number) => boolean;
	identify: ProcessIdentityReader;
}): boolean {
	const { cwd, pid, expectedIdentity, isAlive, identify } = args;
	return isAlive(pid) && identify(cwd, pid) === expectedIdentity;
}

export function stillMatchingIdentities(
	cwd: string,
	targets: ReadonlyMap<number, string>,
	isAlive: (pid: number) => boolean,
	identify: ProcessIdentityReader,
): Map<number, string> {
	return new Map(
		[...targets].filter(([pid, expectedIdentity]) =>
			sameProcessIdentity({ cwd, pid, expectedIdentity, isAlive, identify }),
		),
	);
}
