import { join } from "node:path";
import { parseArgs } from "node:util";
import { removePidFileIfOwned } from "../daemon-pid-ownership.js";
import { daemonPathsFor } from "../session-paths.js";
import { parseProtocolMode, resolveIdleTimeoutMs, stringArg } from "./cli-args.js";
import type { HarnessProtocolMode } from "./protocol-status.js";

const IDLE_TIMEOUT_DEFAULT_MS = 0;
const EARLY_SHUTDOWN_GRACE_MS = 1500;

export interface ServerCliConfig {
	cwd: string;
	interlinkedDir: string;
	socketPath: string;
	pidPath: string;
	protocolMode: HarnessProtocolMode;
	runRawSocket: boolean;
	runFramedSocket: boolean;
	framedSessionId: string;
	framedPaths: ReturnType<typeof daemonPathsFor>;
	idleTimeoutMs: number;
	verbose: boolean | undefined;
}

/** Parse the daemon CLI once and derive every protocol/path setting. */
export function readServerCliConfig(): ServerCliConfig {
	const { values: args } = parseArgs({
		options: {
			socket: { type: "string", short: "s" },
			"pid-file": { type: "string" },
			"idle-timeout": { type: "string" },
			cwd: { type: "string" },
			protocol: { type: "string" },
			"session-id": { type: "string" },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: false,
	});
	const cwd = stringArg(args.cwd) || process.cwd();
	const interlinkedDir = join(cwd, ".interlinked");
	const protocolMode = parseProtocolMode(stringArg(args.protocol));
	const runRawSocket = protocolMode !== "framed";
	const runFramedSocket = protocolMode !== "raw";
	const framedSessionId =
		stringArg(args["session-id"]) || process.env.INTERLINKED_SESSION_ID || "default";
	return {
		cwd,
		interlinkedDir,
		socketPath: stringArg(args.socket) || join(interlinkedDir, "harness.sock"),
		pidPath: stringArg(args["pid-file"]) || join(interlinkedDir, "harness.pid"),
		protocolMode,
		runRawSocket,
		runFramedSocket,
		framedSessionId,
		framedPaths: daemonPathsFor(cwd, framedSessionId),
		idleTimeoutMs: resolveIdleTimeoutMs(
			stringArg(args["idle-timeout"]),
			IDLE_TIMEOUT_DEFAULT_MS,
		),
		verbose: args.verbose === true,
	};
}

export interface EarlyShutdownController {
	upgrade(onSignal: () => void, onPending: () => void): void;
}

/** Install the startup-safe signal handler and later replace it atomically. */
export function installEarlyShutdown(pidPath: string): EarlyShutdownController {
	let ready = false;
	let pending = false;
	function earlyShutdown(): void {
		if (ready) return;
		pending = true;
		removePidFileIfOwned(pidPath, process.pid);
		const timer = setTimeout(() => process.exit(0), EARLY_SHUTDOWN_GRACE_MS);
		timer.unref();
	}
	process.on("SIGTERM", earlyShutdown);
	process.on("SIGINT", earlyShutdown);
	return {
		upgrade(onSignal, onPending): void {
			process.removeListener("SIGTERM", earlyShutdown);
			process.removeListener("SIGINT", earlyShutdown);
			process.on("SIGINT", onSignal);
			process.on("SIGTERM", onSignal);
			ready = true;
			if (pending) onPending();
		},
	};
}
