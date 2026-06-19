// interlinked-tdd: exempt
// ===========================================
// Local Activity — data-dir path helpers
// ===========================================
// Extracted from local-activity.ts to keep that module under the per-file
// line cap. Pure path joins over getDataDir — no I/O, no back-import.

import { join } from "node:path";
import { getDataDir } from "./config.js";
export function getActivityPath(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "activity.jsonl");
}

export function getSessionsDir(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "sessions");
}

export function getSyncStatePath(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "sync-state.json");
}

export function getRealtimeRetryPath(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "realtime-retry.jsonl");
}

export function getSyncErrorsPath(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "sync-errors.jsonl");
}
