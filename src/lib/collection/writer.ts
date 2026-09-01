// ===========================================
// Collection v1 — JSONL Writer
// ===========================================
// Appends collection.v1 records to .interlinked/collection.jsonl.
// Synchronous, fire-and-forget — mirrors appendLocalActivity() semantics.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendFileWithMutationLock } from "../file-mutation-lock.js";
import type { AgentEventRecord, CollectionRecord } from "./types.js";

export function getCollectionPath(cwd: string): string {
	return join(cwd, ".interlinked", "collection.jsonl");
}

export function appendCollection(record: CollectionRecord | AgentEventRecord, cwd: string): void {
	try {
		const filePath = getCollectionPath(cwd);
		const dir = join(cwd, ".interlinked");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		appendFileWithMutationLock(filePath, `${JSON.stringify(record)}\n`);
	} catch {
		// collection is best-effort — never break the hook pipeline
	}
}
