// interlinked-tdd: exempt
// ===========================================
// interlinked init — presentation helpers
// ===========================================
// Pure output/formatting helpers extracted from init.ts to keep the
// orchestrator under the per-file line cap. Each function takes already
// resolved data and writes to the console (or is suppressed in json mode);
// none reads or mutates module-private state in init.ts. Leaf module — it
// never imports back from init.ts.

import { c } from "../lib/formatter.js";
import { HOOK_SCRIPT_VERSION } from "../lib/hooks.js";
import { ensureRemoteOnboarding } from "../lib/onboarding.js";
import type { ClientName } from "../lib/settings.js";

export function isLocalServer(url: string): boolean {
	return url.includes("localhost") || url.includes("127.0.0.1");
}

export type OnboardingResult = Awaited<ReturnType<typeof ensureRemoteOnboarding>>;

interface DetectedClientInfo {
	name: ClientName;
	exists: boolean;
}

/** Step 0: print the human banner (suppressed in json mode). */
export function printBanner(isJson: boolean): void {
	if (isJson) return;
	console.log(c.bold("Interlinked CLI — Quick Setup"));
	console.log(c.dim("═".repeat(40)));
	console.log("");
}

/** Step 1: report detected AI clients (suppressed in json mode). */
export function printDetectedClients(detectedClients: DetectedClientInfo[], isJson: boolean): void {
	if (isJson) return;
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

/** Step 2: report git/project context (suppressed in json mode). */
export function printProjectContext(
	projectName: string | null,
	projectRoot: string | null,
	isJson: boolean,
): void {
	if (isJson) return;
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

/** Step 3 (output): report the resolved server (suppressed in json mode). */
export function printServer(serverUrl: string, isJson: boolean): void {
	if (isJson) return;
	console.log(`${c.bold("3.")} Server: ${c.cyan(serverUrl)}`);
	console.log(`   ${isLocalServer(serverUrl) ? c.dim("(local dev server)") : c.dim("(production)")}`);
	console.log("");
}

/** Dry-run early exit: emit the planned configuration and stop. */
export function emitDryRun(
	serverUrl: string,
	agentName: string,
	projectName: string | null,
	syncMode: string,
	detectedNames: ClientName[],
	isJson: boolean,
): void {
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
}

/** Final human summary: the "Ready!" line plus next-step hints. */
function printSummary(
	serverUrl: string,
	agentName: string,
	serverReachable: boolean,
	onlineAgents: number,
	harnessStarted: boolean,
): void {
	console.log("");
	console.log(c.dim("═".repeat(40)));

	if (serverReachable) {
		const agentLabel =
			onlineAgents > 0 ? `${onlineAgents} agent${onlineAgents !== 1 ? "s" : ""} online` : "";
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
		console.log(`  interlinked harness start    ${c.dim("— Start guard evaluation server")}`);
	}
	console.log(`  interlinked status          ${c.dim("— Dashboard")}`);
	console.log(`  interlinked context          ${c.dim("— Show effective config")}`);
	console.log(`  interlinked inbox            ${c.dim("— Check messages")}`);
	console.log(`  interlinked tasks list       ${c.dim("— View tasks")}`);
	console.log(`  interlinked doctor           ${c.dim("— Diagnose issues")}`);
}

/** Final completion summary, dispatching between human and json output. */
export function printCompletion(
	serverUrl: string,
	agentName: string,
	projectName: string | null,
	syncMode: string,
	detectedNames: ClientName[],
	serverReachable: boolean,
	onlineAgents: number,
	onboarding: OnboardingResult,
	harnessStarted: boolean,
	isJson: boolean,
): void {
	if (!isJson) {
		printSummary(serverUrl, agentName, serverReachable, onlineAgents, harnessStarted);
		return;
	}
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
