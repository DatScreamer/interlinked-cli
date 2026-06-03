// ===========================================
// interlinked init — One-command onboarding
// ===========================================
// Combines auto-detection, setup, login, and verification into
// a single streamlined flow for both humans and agents.
//
// What it does:
// 1. Auto-detect installed AI clients (Claude Code, Gemini CLI, Codex)
// 2. Auto-detect git remote → suggest workspace name
// 3. Install hooks for all detected clients
// 4. Login (interactive OAuth or env token)
// 5. Attach to workspace and register agent
// 6. Health check + send introduction message
// 7. Print summary: "Connected to X as Y. N agents online."

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolveAuthToken } from "../lib/auth.js";
import { initConfig, type LocalConfig, updateLocalConfig } from "../lib/config.js";
import { c } from "../lib/formatter.js";
import {
	findProjectRoot,
	HOOK_SCRIPT_VERSION,
	installAllHooks,
	writeHookScript,
} from "../lib/hooks.js";
import { ensureRemoteOnboarding } from "../lib/onboarding.js";
import { type ClientName, detectClients } from "../lib/settings.js";
import { harnessStartCommand, isHarnessRunning } from "./harness.js";
import { loginCommand } from "./login.js";

// No hardcoded production default — the public distribution has no server
// to point at. Users supply one via `--server`, and the probe/local
// defaults fall through to localhost.
const DEFAULT_REMOTE_SERVER = "http://localhost:8787";
const DEFAULT_LOCAL_SERVER = "http://localhost:8787";

/** Default timeout when probing whether the configured server is reachable during init. */
const SERVER_REACHABLE_TIMEOUT_MS = 2000;

interface InitOptions {
	server?: string;
	agent?: string;
	"sync-mode"?: string;
	"dry-run"?: boolean;
	json?: boolean;
	yes?: boolean;
}

function isInteractiveTty(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
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

function isLocalServer(url: string): boolean {
	return url.includes("localhost") || url.includes("127.0.0.1");
}

/**
 * Derive a workspace/project name from git remote URL.
 * e.g., "git@github.com:user/my-project.git" → "my-project"
 */
function deriveProjectFromGit(cwd: string): string | null {
	const projectRoot = findProjectRoot(cwd);
	if (!projectRoot) return null;

	// Try git remote URL first
	const gitConfigPath = join(projectRoot, ".git", "config");
	if (existsSync(gitConfigPath)) {
		try {
			const content = readFileSync(gitConfigPath, "utf-8");
			const urlMatch = content.match(/url\s*=\s*(.+)/);
			if (urlMatch) {
				const url = urlMatch[1].trim();
				// Extract repo name from URL
				const repoMatch = url.match(/\/([^/]+?)(?:\.git)?$/);
				if (repoMatch) return repoMatch[1];
			}
		} catch (_) {
			/* intentional: unable to parse git config, fall through to directory name */
		}
	}

	// Fallback: directory name
	return basename(projectRoot);
}

/**
 * Suggest an agent name based on environment and client.
 */
function suggestAgentName(detectedClients: ClientName[]): string {
	const envName = process.env.INTERLINKED_AGENT_NAME || process.env.INTERLINKED_AGENT;
	if (envName) return envName;

	const user = process.env.USER || process.env.USERNAME || "agent";
	const client = detectedClients[0] || "cli";
	return `${user}-${client}`;
}

export async function initCommand(options: InitOptions): Promise<void> {
	const cwd = process.cwd();
	const dryRun = options["dry-run"] || false;
	const isJson = options.json || false;
	const autoConfirm = options.yes || !isInteractiveTty();

	if (!isJson) {
		console.log(c.bold("Interlinked CLI — Quick Setup"));
		console.log(c.dim("═".repeat(40)));
		console.log("");
	}

	// Step 1: Auto-detect clients
	const allClients = detectClients(cwd);
	const detectedClients = allClients.filter((c) => c.exists);
	const detectedNames = detectedClients.map((c) => c.name);

	if (!isJson) {
		console.log(`${c.bold("1.")} Detecting AI clients...`);
		if (detectedClients.length > 0) {
			for (const client of detectedClients) {
				console.log(`   ${c.green("✓")} ${client.name}`);
			}
		} else {
			console.log(
				`   ${c.dim("No AI client directories found. Hooks will be installed when clients are set up.")}`,
			);
		}
		console.log("");
	}

	// Step 2: Detect git context
	const projectName = deriveProjectFromGit(cwd);
	const projectRoot = findProjectRoot(cwd);

	if (!isJson) {
		console.log(`${c.bold("2.")} Detecting project context...`);
		if (projectName) {
			console.log(`   ${c.green("✓")} Git project: ${c.cyan(projectName)}`);
		} else {
			console.log(`   ${c.dim("No git repository detected.")}`);
		}
		if (projectRoot) {
			console.log(`   ${c.dim(`Root: ${projectRoot}`)}`);
		}
		console.log("");
	}

	// Step 3: Determine server
	let serverUrl = options.server || process.env.INTERLINKED_SERVER_URL;
	if (!serverUrl) {
		const localHealthy = await isServerReachable(DEFAULT_LOCAL_SERVER);
		serverUrl = localHealthy ? DEFAULT_LOCAL_SERVER : DEFAULT_REMOTE_SERVER;
	}

	if (!isJson) {
		console.log(`${c.bold("3.")} Server: ${c.cyan(serverUrl)}`);
		console.log(
			`   ${isLocalServer(serverUrl) ? c.dim("(local dev server)") : c.dim("(production)")}`,
		);
		console.log("");
	}

	// Step 4: Agent name
	let agentName = options.agent || suggestAgentName(detectedNames);

	// Interactive prompt for agent name if TTY and not auto-confirmed
	if (isInteractiveTty() && !autoConfirm && !options.agent) {
		const rl = createInterface({ input, output });
		try {
			const answer = await rl.question(`${c.bold("4.")} Agent name [${agentName}]: `);
			if (answer.trim()) agentName = answer.trim();
		} finally {
			rl.close();
		}
	} else if (!isJson) {
		console.log(`${c.bold("4.")} Agent name: ${c.cyan(agentName)}`);
	}

	if (!isJson) console.log("");

	// Step 5: Sync mode
	const syncMode = options["sync-mode"] || "realtime";

	if (dryRun) {
		if (isJson) {
			console.log(
				JSON.stringify({
					dry_run: true,
					server_url: serverUrl,
					agent_name: agentName,
					project: projectName,
					sync_mode: syncMode,
					detected_clients: detectedNames,
					hook_version: HOOK_SCRIPT_VERSION,
				}),
			);
		} else {
			console.log(c.bold("Dry run — no changes made."));
			console.log(c.dim("Would install hooks, configure, and authenticate."));
		}
		return;
	}

	// Step 6: Install hooks and config
	if (!isJson) {
		console.log(`${c.bold("5.")} Installing...`);
	}

	// Initialize config
	initConfig({ serverUrl, agentName }, cwd);
	updateLocalConfig({ sync_mode: syncMode as NonNullable<LocalConfig["sync_mode"]> }, cwd);

	if (!isJson) {
		console.log(`   ${c.green("✓")} Config written to .interlinked/`);
	}

	// Write the generated .mjs — kept as the unbuilt-source-checkout binary
	// fallback; the canonical hook binary is resolved inside installAllHooks.
	writeHookScript(cwd);
	if (!isJson) {
		console.log(`   ${c.green("✓")} Hook script v${HOOK_SCRIPT_VERSION}`);
	}

	// Install hooks for detected clients
	if (detectedNames.length > 0) {
		const results = installAllHooks(cwd, detectedNames);
		for (const r of results) {
			if (r.installed && !isJson) {
				console.log(`   ${c.green("✓")} ${r.client} hooks (${r.events.length} events)`);
			} else if (r.error && !isJson) {
				console.log(`   ${c.yellow("!")} ${r.client}: ${r.error}`);
			}
		}
	}
	if (!isJson) console.log("");

	// Step 7: Authentication
	const hasAuth = !!resolveAuthToken();
	const envToken = process.env.INTERLINKED_TOKEN || process.env.INTERLINKED_ACCESS_TOKEN;

	if (!hasAuth && !isLocalServer(serverUrl)) {
		if (!isJson) {
			console.log(`${c.bold("6.")} Authenticating...`);
		}
		if (envToken) {
			await loginCommand({ server: serverUrl, token: envToken });
		} else if (isInteractiveTty()) {
			await loginCommand({ server: serverUrl });
		} else {
			if (!isJson) {
				console.log(
					`   ${c.yellow("Skipped")} — no TTY. Set INTERLINKED_TOKEN or run: interlinked login`,
				);
			}
		}
	} else if (!isJson) {
		console.log(`${c.bold("6.")} Auth: ${c.green("already authenticated")}`);
	}
	if (!isJson) console.log("");

	// Step 8: Remote onboarding (register agent on server)
	if (!isJson) {
		console.log(`${c.bold("7.")} Connecting to workspace...`);
	}

	const onboarding = await ensureRemoteOnboarding({ serverUrl });
	if (onboarding.status === "linked") {
		if (!isJson) {
			const tag = onboarding.isNewAgent ? "registered" : "reconnected";
			console.log(
				`   ${c.green("✓")} Agent ${c.cyan(onboarding.agentName || agentName)} ${tag}`,
			);
			if (onboarding.workspaceName) {
				console.log(`   ${c.dim(`Workspace: ${onboarding.workspaceName}`)}`);
			}
		}
	} else if (onboarding.status === "skipped") {
		if (!isJson) {
			console.log(
				`   ${c.dim(`Remote onboarding skipped: ${onboarding.reason || "unknown"}`)}`,
			);
		}
	} else {
		if (!isJson) {
			console.log(`   ${c.yellow("!")} Remote onboarding: ${onboarding.error || "failed"}`);
		}
	}

	// Step 9: Verification — health check
	let serverReachable = false;
	let onlineAgents = 0;
	try {
		const { InterlinkedClient } = await import("../lib/api-client.js");
		const token = resolveAuthToken();
		const client = new InterlinkedClient({
			serverUrl,
			...(token ? { token } : {}),
		});
		await client.callTool("health_check");
		serverReachable = true;

		// Try to get online agent count
		try {
			const result = await client.callTool<{ agents?: { name: string }[] }>(
				"list_online_agents",
				{ threshold_minutes: 5 },
			);
			onlineAgents = result.agents?.length || 0;
		} catch (_) {
			/* intentional: list_online_agents is best-effort during init */
		}
	} catch (_) {
		/* intentional: init-time workspace check is best-effort, proceed without context */
	}

	// Step 8: Harness setup
	let harnessStarted = false;
	const harnessStatus = isHarnessRunning(cwd);

	if (!isJson) {
		console.log("");
		console.log(`${c.bold("8.")} Harness setup...`);
	}

	if (harnessStatus.running) {
		if (!isJson) {
			console.log(`   ${c.green("✓")} Harness already running (PID ${harnessStatus.pid})`);
		}
		harnessStarted = true;
	} else {
		let shouldStart = autoConfirm;
		if (!shouldStart && isInteractiveTty()) {
			const rl = createInterface({ input, output });
			try {
				const answer = await rl.question(
					"   Start harness server for guard evaluation? [Y/n] ",
				);
				shouldStart = !answer.trim() || answer.trim().toLowerCase() !== "n";
			} finally {
				rl.close();
			}
		}
		if (shouldStart) {
			const harnessInitOpts = { daemon: true, json: true };
			await harnessStartCommand(harnessInitOpts);
			const afterStart = isHarnessRunning(cwd);
			harnessStarted = afterStart.running;
			if (!isJson) {
				if (afterStart.running) {
					console.log(`   ${c.green("✓")} Harness started (PID ${afterStart.pid})`);
				} else {
					console.log(
						`   ${c.yellow("!")} Failed to start harness. Run: interlinked harness start --verbose`,
					);
				}
			}
		} else if (!isJson) {
			console.log(`   ${c.dim("Skipped — start later with: interlinked harness start")}`);
		}
	}

	if (!isJson) {
		console.log("");
		console.log(c.dim("═".repeat(40)));

		if (serverReachable) {
			const agentLabel =
				onlineAgents > 0
					? `${onlineAgents} agent${onlineAgents !== 1 ? "s" : ""} online`
					: "";
			console.log(
				c.green(
					`\nReady! Connected to ${isLocalServer(serverUrl) ? "local server" : "production"} as ${c.cyan(agentName)}.`,
				) + (agentLabel ? ` ${c.dim(agentLabel)}` : ""),
			);
		} else {
			console.log(
				`${c.green("\nSetup complete.")} ${c.yellow("Server not reachable — hooks will buffer locally.")}`,
			);
		}

		console.log(`\n${c.bold("Next steps:")}`);
		if (!harnessStarted) {
			console.log(
				`  interlinked harness start    ${c.dim("— Start guard evaluation server")}`,
			);
		}
		console.log(`  interlinked status          ${c.dim("— Dashboard")}`);
		console.log(`  interlinked context          ${c.dim("— Show effective config")}`);
		console.log(`  interlinked inbox            ${c.dim("— Check messages")}`);
		console.log(`  interlinked tasks list       ${c.dim("— View tasks")}`);
		console.log(`  interlinked doctor           ${c.dim("— Diagnose issues")}`);
	} else {
		console.log(
			JSON.stringify({
				status: "complete",
				server_url: serverUrl,
				agent_name: agentName,
				project: projectName,
				sync_mode: syncMode,
				detected_clients: detectedNames,
				server_reachable: serverReachable,
				online_agents: onlineAgents,
				onboarding: onboarding.status,
			}),
		);
	}
}
