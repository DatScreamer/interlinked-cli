// ===========================================
// First-Run Entry Flow
// ===========================================
// Invoked when users run `interlinked` with no arguments.
// - If not configured: launch setup wizard (TTY) or auto-bootstrap (non-TTY)
// - If configured: show status dashboard

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolveAuthToken } from "../lib/auth.js";
import { isConfigured, resolveConfig } from "../lib/config.js";
import { c } from "../lib/formatter.js";
import { ensureRemoteOnboarding } from "../lib/onboarding.js";
import { enableCommand } from "./enable.js";
import { loginCommand } from "./login.js";
import { statusCommand } from "./status.js";

// No hardcoded production default — the public distribution has no server
// to point at. Users supply one via `--server`, and the probe/local
// defaults fall through to localhost.
const DEFAULT_REMOTE_SERVER = "http://localhost:8787";
const DEFAULT_LOCAL_SERVER = "http://localhost:8787";

/** Default timeout when probing whether the configured server is reachable during first-run. */
const SERVER_REACHABLE_TIMEOUT_MS = 1200;

type SyncMode = "realtime" | "local" | "manual";

function isInteractiveTty(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function printEntrypointQuickStart(): void {
	const config = resolveConfig();
	const hasAuth = Boolean(resolveAuthToken());
	const localServer = isLocalServer(config.server_url);

	const suggestions: string[] = [];
	if (!config.agent_name) {
		suggestions.push("interlinked attach --agent <name>");
	}
	if (!localServer && !hasAuth) {
		suggestions.push("interlinked login");
	}
	suggestions.push("interlinked activity --since 1h");
	if (config.sync_mode !== "local") {
		suggestions.push("interlinked sync");
	}
	suggestions.push("interlinked tasks list");
	suggestions.push("interlinked --help");

	if (suggestions.length === 0) return;

	console.log("");
	console.log(c.bold("Command Quick Start"));
	console.log(c.dim("───────────────────"));
	for (const command of suggestions) {
		console.log(`  ${command}`);
	}
}

function isLocalServer(serverUrl: string): boolean {
	return serverUrl.includes("localhost") || serverUrl.includes("127.0.0.1");
}

function normalizeSyncMode(raw: string | undefined): SyncMode {
	const value = (raw || "").trim().toLowerCase();
	if (value === "local" || value === "manual") return value;
	return "realtime";
}

function getDefaultAgentName(): string {
	return (
		process.env.INTERLINKED_AGENT_NAME ||
		process.env.INTERLINKED_AGENT ||
		process.env.AGENT_NAME ||
		process.env.USER ||
		"Agent"
	);
}

function getEnvToken(): string | undefined {
	return process.env.INTERLINKED_TOKEN || process.env.INTERLINKED_ACCESS_TOKEN;
}

interface YesNoOpts {
	defaultValue: boolean;
}

function parseYesNo(raw: string, opts: YesNoOpts): boolean {
	const v = raw.trim().toLowerCase();
	if (!v) return opts.defaultValue;
	if (["y", "yes", "1", "true"].includes(v)) return true;
	if (["n", "no", "0", "false"].includes(v)) return false;
	return opts.defaultValue;
}

async function isServerReachable(
	serverUrl: string,
	timeoutMs: number = SERVER_REACHABLE_TIMEOUT_MS,
): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${serverUrl}/health`, { signal: controller.signal });
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

async function chooseDefaultServer(): Promise<string> {
	const explicit = process.env.INTERLINKED_SERVER_URL;
	if (explicit) return explicit;
	const localHealthy = await isServerReachable(DEFAULT_LOCAL_SERVER);
	return localHealthy ? DEFAULT_LOCAL_SERVER : DEFAULT_REMOTE_SERVER;
}

async function runInteractiveWizard(): Promise<void> {
	const defaultServer = await chooseDefaultServer();
	const defaultAgent = getDefaultAgentName();
	const envToken = getEnvToken();

	console.log(c.bold("Interlinked CLI Setup Wizard"));
	console.log(c.dim("────────────────────────"));
	console.log(c.dim("Press Enter to accept defaults.\n"));

	const rl = createInterface({ input, output });
	let server = defaultServer;
	let agent = defaultAgent;
	let syncMode: SyncMode = "realtime";
	let doLogin = true;
	let didRunLogin = false;
	try {
		const serverRaw = await rl.question(`Server URL [${defaultServer}]: `);
		server = serverRaw.trim() || defaultServer;

		const agentRaw = await rl.question(`Agent name [${defaultAgent}]: `);
		agent = agentRaw.trim() || defaultAgent;

		const syncRaw = await rl.question("Sync mode [realtime]: ");
		syncMode = normalizeSyncMode(syncRaw);

		if (!envToken && !isLocalServer(server) && !resolveAuthToken()) {
			const loginRaw = await rl.question("Authenticate now? [Y/n]: ");
			const yesNoOpts = { defaultValue: true };
			doLogin = parseYesNo(loginRaw, yesNoOpts);
		}
	} finally {
		rl.close();
	}

	await enableCommand({
		server,
		agent,
		syncMode,
	});

	if (envToken) {
		console.log(c.dim("\nUsing INTERLINKED_TOKEN from environment."));
		await loginCommand({ server, token: envToken });
		didRunLogin = true;
	} else if (!isLocalServer(server) && !resolveAuthToken()) {
		if (doLogin) {
			await loginCommand({ server });
			didRunLogin = true;
		} else {
			console.log(c.yellow("\nAuthentication skipped. Run `interlinked login` when ready."));
		}
	}

	if (!didRunLogin) {
		const onboarding = await ensureRemoteOnboarding({ serverUrl: server });
		if (onboarding.status === "linked") {
			const mode = onboarding.isNewAgent
				? "new"
				: onboarding.reclaimedAgent
					? "reclaimed"
					: "existing";
			console.log(
				c.dim(
					`Remote agent linked: ${onboarding.agentName || "agent"} (${mode})${
						onboarding.agentHandle ? ` ${onboarding.agentHandle}` : ""
					}`,
				),
			);
		} else if (onboarding.status === "skipped" && onboarding.reason === "agent_name_missing") {
			console.log(
				c.dim("Remote onboarding skipped: set agent name to auto-link remote identity."),
			);
		}
	}

	console.log(c.green("\nSetup complete."));
	const statusOpts = { short: true };
	await statusCommand(statusOpts);
}

async function runNonInteractiveBootstrap(): Promise<void> {
	const server = await chooseDefaultServer();
	const agent = getDefaultAgentName();
	const syncMode = normalizeSyncMode(process.env.INTERLINKED_SYNC_MODE);
	const clients = process.env.INTERLINKED_CLIENTS;
	const token = getEnvToken();
	let didRunLogin = false;

	console.log(c.dim("[interlinked] No config found. Running non-interactive bootstrap..."));
	await enableCommand({
		server,
		agent,
		syncMode,
		clients,
	});

	if (token) {
		await loginCommand({ server, token });
		didRunLogin = true;
	} else if (!isLocalServer(server) && !resolveAuthToken()) {
		console.log(
			c.yellow(
				"[interlinked] No token available. Set INTERLINKED_TOKEN or run `interlinked login` interactively.",
			),
		);
	}

	if (!didRunLogin) {
		const onboarding = await ensureRemoteOnboarding({ serverUrl: server });
		if (onboarding.status === "linked") {
			console.log(
				c.dim(
					`[interlinked] Remote agent linked: ${onboarding.agentName || "agent"}${
						onboarding.agentHandle ? ` (${onboarding.agentHandle})` : ""
					}`,
				),
			);
		}
	}
}

export async function handleImplicitEntry(): Promise<boolean> {
	const argv = process.argv.slice(2);
	if (argv.length > 0) return false;

	if (!isConfigured()) {
		if (isInteractiveTty()) {
			await runInteractiveWizard();
		} else {
			await runNonInteractiveBootstrap();
		}
		return true;
	}

	await statusCommand({});
	if (isInteractiveTty()) {
		printEntrypointQuickStart();
	}
	return true;
}
