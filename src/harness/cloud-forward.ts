import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CloudGovernorConfig,
	type CloudVerdict,
	evaluateRemote,
} from "../lib/cloud-governor.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

// Module-cached config. v0: load once at first call, no hot-reload — restart
// the daemon to pick up config changes. Sufficient for the opt-in dev path;
// proper file-watcher hot-reload is a v0.1 follow-up.
let cachedConfig: CloudGovernorConfig | null = null;
let configLoaded = false;

function loadCloudConfig(cwd: string): CloudGovernorConfig | null {
	if (configLoaded) return cachedConfig;
	configLoaded = true;
	try {
		const path = join(cwd, ".interlinked", "config.local.json");
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as { cloud_governor?: unknown };
		const cg = parsed.cloud_governor;
		if (!cg || typeof cg !== "object") return null;
		const candidate = cg as {
			enabled?: unknown;
			url?: unknown;
			bearer_token?: unknown;
			timeout_ms?: unknown;
		};
		if (typeof candidate.enabled !== "boolean") return null;
		if (typeof candidate.url !== "string" || typeof candidate.bearer_token !== "string") {
			return null;
		}
		cachedConfig = {
			enabled: candidate.enabled,
			url: candidate.url,
			bearer_token: candidate.bearer_token,
			timeout_ms:
				typeof candidate.timeout_ms === "number" ? candidate.timeout_ms : undefined,
		};
		return cachedConfig;
	} catch {
		return null;
	}
}

// Test-only: reset the module cache so a different config file is re-read.
// Kept on the public surface because the cache is module-local; without this,
// tests would have to import / mutate the private state directly.
export function _resetCloudConfigCache(): void {
	cachedConfig = null;
	configLoaded = false;
}

const ALLOW: HarnessDecision["decision"] = "allow";
const BLOCK: HarnessDecision["decision"] = "block";

export async function forwardCloudPreToolUse(
	event: HarnessEvent,
	localDecision: HarnessDecision,
	cwd: string = process.cwd(),
): Promise<HarnessDecision> {
	const config = loadCloudConfig(cwd);
	if (!config || !config.enabled) return localDecision;
	const cloudVerdict = await evaluateRemote(event, config);
	return mergeCloudVerdict(localDecision, cloudVerdict);
}

// Merge a cloud verdict into the local HarnessDecision. Local authority:
// block / ask are preserved as-is (cloud cannot downgrade or escalate them).
// On local allow: cloud block escalates; cloud warnings union into local
// warnings, each prefixed `[cloud]` so the agent sees where the finding came
// from when both layers fire at once.
export function mergeCloudVerdict(
	local: HarnessDecision,
	cloud: CloudVerdict | null,
): HarnessDecision {
	if (!cloud) return local;
	if (local.decision !== ALLOW) return local;
	if (cloud.decision === BLOCK) {
		return {
			...local,
			decision: BLOCK,
			reason: `[cloud] ${cloud.reason ?? "blocked by cloud governor"}`,
		};
	}
	const cloudWarnings = (cloud.warnings ?? []).map((w) => `[cloud] ${w}`);
	if (cloudWarnings.length === 0) return local;
	const localWarnings = local.warnings ?? [];
	return { ...local, warnings: [...localWarnings, ...cloudWarnings] };
}
