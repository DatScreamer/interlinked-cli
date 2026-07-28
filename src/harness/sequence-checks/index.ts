// interlinked-tdd: exempt — barrel re-exports only, no runtime logic.
// Public surface for the sequence-detector framework. Callers import from
// here so the internal layout (registry / dispatcher / per-family files) can
// be reorganized without touching consumers.

export type { DetectorEnabledPredicate } from "./dispatcher.js";
export {
	defaultDetectorEnabledPredicate,
	formatSequenceFinding,
	runSequenceDetectorsForPhase,
} from "./dispatcher.js";
export {
	ALL_SEQUENCE_DETECTORS,
	getSequenceDetectorById,
} from "./registry.js";
export type {
	SequenceDetector,
	SequenceDetectorFamily,
	SequenceDetectorFn,
	SequenceDetectorPhase,
	SequenceFinding,
	SequenceMatch,
} from "./types.js";
