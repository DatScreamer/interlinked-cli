import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAuthToken } from "../lib/auth.js";
import { type CloudVerdict, evaluateRemote } from "../lib/cloud-governor.js";
import { isJsonObject } from "../lib/json-types.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

// Static file-config for the cloud governor. The bearer is NO LONGER stored
// here — it's the OAuth access_token from `interlinked login`, resolved fresh
// per call via resolveAuthToken so a token refresh is picked up without a
// daemon restart. Only these static settings are cached.
interface CloudGovernorSettings {
	enabled: boolean;
	url: string;
	timeout_ms?: number | undefined;
}

let cachedConfig: CloudGovernorSettings | null = null;
let configLoaded = false;

function loadCloudConfig(cwd: string): CloudGovernorSettings | null {
	if (configLoaded) return cachedConfig;
	configLoaded = true;
	try {
		const path = join(cwd, ".interlinked", "config.local.json");
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		if (!isJsonObject(parsed)) return null;
		const cg = parsed.cloud_governor;
		if (!isJsonObject(cg)) return null;
		if (typeof cg.enabled !== "boolean") return null;
		if (typeof cg.url !== "string") return null;
		cachedConfig = {
			enabled: cg.enabled,
			url: cg.url,
			timeout_ms: typeof cg.timeout_ms === "number" ? cg.timeout_ms : undefined,
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
	// Meta-test wrapper short-circuit — see `evaluator/pre-tool.ts` for the
	// same skip applied locally. Cloud needs its own copy because the local
	// evaluator returns allow on the wrapper (no warnings, no rule_id), which
	// is indistinguishable from a normal allow to forwardCloud; without this,
	// cloud's rule regexes still match the inner quoted-string content of the
	// wrapper and meta-fire on the outer.
	if (isMetaTestWrapper(event)) return localDecision;
	const config = loadCloudConfig(cwd);
	if (!config || !config.enabled) return localDecision;
	// The bearer is the OAuth access_token from `interlinked login`, resolved
	// fresh each call. No token → not logged in → cloud governor is effectively
	// off (fail-open to the local decision).
	const token = resolveAuthToken(cwd);
	if (!token) return localDecision;
	// `timeout_ms` is conditionally spread so an absent value is omitted rather
	// than passed as `undefined` (exactOptionalPropertyTypes: the consumer's
	// `timeout_ms?: number` does not accept an explicit `undefined`).
	const cloudVerdict = await evaluateRemote(event, {
		enabled: config.enabled,
		url: config.url,
		...(config.timeout_ms !== undefined ? { timeout_ms: config.timeout_ms } : {}),
		bearer_token: token,
	});
	return mergeCloudVerdict(localDecision, cloudVerdict);
}

const META_TEST_RE = /^\s*interlinked\s+harness\s+test\b/;

export function isMetaTestWrapper(event: HarnessEvent): boolean {
	if (event.tool_name !== "Bash" && event.tool_name !== "Shell" && event.tool_name !== "run_command") {
		return false;
	}
	const command = event.tool_input?.command;
	return typeof command === "string" && META_TEST_RE.test(command);
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
