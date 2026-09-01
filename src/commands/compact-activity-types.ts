import type { FileIdentity } from "../lib/file-suffix-replacement.js";
import type { JsonObject } from "../lib/json-types.js";
import type { ArchiveManifest, ArchiveSegment } from "./compact-plain.js";

export interface ActivityRecoveryDeps {
	activityPath: string;
	archiveDir: string;
	syncStatePath: string;
	manifestPath: string;
	syncState: JsonObject;
	loadManifest: () => ArchiveManifest;
}

export interface ActivityRotationDeps extends ActivityRecoveryDeps {
	cutByte: number;
	records: number;
	syncedBytes: number;
	source: FileIdentity;
	nextSequence: (manifest: ArchiveManifest) => number;
	/** Test seam for the exact copy-to-rename append window. */
	afterInitialCopy?: () => void;
}

export interface ActivityRotationResult {
	segment: ArchiveSegment;
	liveAfterBytes: number;
	syncedThroughBytes: number;
}

export interface ActivityRotationConflict {
	segmentFile: string;
	reason: string;
}

export interface PendingActivityRotationResult extends ActivityRotationResult {
	recovered: boolean;
}
