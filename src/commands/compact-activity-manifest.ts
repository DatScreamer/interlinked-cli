import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../lib/config.js";
import { isJsonObject } from "../lib/json-types.js";
import {
	type ArchiveManifest,
	type ArchiveSegment,
	parseArchiveSegment,
	readArchiveManifestJson,
} from "./compact-plain.js";

export function activityArchiveDir(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "archive");
}

export function activityManifestPath(cwd: string = process.cwd()): string {
	return join(activityArchiveDir(cwd), "manifest.json");
}

function parseActivityManifest(value: unknown): ArchiveManifest | null {
	if (!isJsonObject(value) || value.version !== 1 || !Array.isArray(value.segments)) return null;
	const segments: ArchiveSegment[] = [];
	for (const entry of value.segments) {
		const segment = parseArchiveSegment(entry, "activity");
		if (!segment) return null;
		segments.push(segment);
	}
	return { version: 1, segments };
}

const ACTIVITY_SEGMENT_RE = /^activity-(\d{4,})\.jsonl\.gz$/;

/** Pick one sequence beyond both indexed and self-describing on-disk rows. */
export function nextActivitySegmentSeq(
	cwd: string,
	manifest: ArchiveManifest,
): number {
	let max = 0;
	for (const segment of manifest.segments) {
		if (segment.seq > max) max = segment.seq;
	}
	try {
		for (const name of readdirSync(activityArchiveDir(cwd))) {
			const match = ACTIVITY_SEGMENT_RE.exec(name);
			if (!match) continue;
			// SAFETY: the capture group is digits, so it is present and numeric.
			const seq = Number.parseInt(match[1] as string, 10);
			if (Number.isFinite(seq) && seq > max) max = seq;
		}
	} catch {
		/* no archive directory yet; the manifest maximum stands */
	}
	return max + 1;
}

export function loadArchiveManifest(cwd: string = process.cwd()): ArchiveManifest {
	const path = activityManifestPath(cwd);
	if (!existsSync(path)) return { version: 1, segments: [] };
	try {
		return parseActivityManifest(readArchiveManifestJson(path)) ?? { version: 1, segments: [] };
	} catch {
		return { version: 1, segments: [] };
	}
}

/** Rebuild the activity index from its self-describing segment filenames. */
function rebuildActivityManifestFromDisk(cwd: string): ArchiveManifest {
	const archiveDir = activityArchiveDir(cwd);
	const segments: ArchiveSegment[] = [];
	try {
		for (const name of readdirSync(archiveDir)) {
			const match = ACTIVITY_SEGMENT_RE.exec(name);
			if (!match) continue;
			// SAFETY: the capture group is digits, so it is present and numeric.
			const seq = Number.parseInt(match[1] as string, 10);
			if (!Number.isFinite(seq)) continue;
			let gzBytes = 0;
			try {
				gzBytes = statSync(join(archiveDir, name)).size;
			} catch {
				/* unreadable stat: retain the self-describing segment row */
			}
			segments.push({
				seq,
				file: name,
				bytes: 0,
				gz_bytes: gzBytes,
				records: 0,
				created_at: "",
				recovered: true,
			});
		}
	} catch {
		/* no archive directory yet */
	}
	segments.sort((a, b) => a.seq - b.seq);
	return { version: 1, segments };
}

/** Rebuild only for the writer; audit verification still fails closed. */
export function loadOrRebuildArchiveManifest(
	cwd: string = process.cwd(),
): ArchiveManifest {
	if (!existsSync(activityManifestPath(cwd))) return { version: 1, segments: [] };
	const loaded = loadArchiveManifest(cwd);
	if (loaded.segments.length > 0) return loaded;
	return rebuildActivityManifestFromDisk(cwd);
}
