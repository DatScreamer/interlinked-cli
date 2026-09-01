// Public facade for plain-log compaction. Keeping the stable import surface
// here lets manifest/state validation and durable rotation evolve separately.

export {
	type ArchiveManifest,
	type ArchiveSegment,
	loadOrRebuildPlainManifest,
	loadPlainManifest,
	MAX_ARCHIVE_MANIFEST_BYTES,
	parseArchiveSegment,
	type PendingLiveDrop,
	PLAIN_COMPACTABLE_LOGS,
	type PlainCompactResult,
	type PlainLogName,
	readArchiveManifestJson,
} from "./compact-plain-state.js";
export { compactPlainLog } from "./compact-plain-rotation.js";
