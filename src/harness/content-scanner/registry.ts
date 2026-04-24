// ===========================================
// Content Scanner — Registry (factory)
// ===========================================
//
// Given a ContentScannerConfig, returns the right backend instance — or
// `undefined` when the feature is disabled. Consumed by server.ts at harness
// startup.

import { OpfHttpScanner } from "./opf-http.js";
import { OpfLocalScanner } from "./opf-local.js";
import type { ContentScanner, ContentScannerConfig } from "./types.js";

/**
 * Build a content scanner for the given config, or `undefined` if disabled
 * or misconfigured. Never throws — startup errors surface as `ready() ===
 * false` on the returned scanner instead, consistent with fail-open posture.
 */
export function createScanner(config: ContentScannerConfig): ContentScanner | undefined {
	if (!config.enabled) return undefined;
	switch (config.runtime) {
		case "local":
			return new OpfLocalScanner(config);
		case "huggingface":
		case "custom_http":
			return new OpfHttpScanner(config);
		default:
			return undefined;
	}
}
