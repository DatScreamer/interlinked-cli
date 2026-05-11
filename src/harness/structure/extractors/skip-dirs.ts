// ===========================================
// Shared skip-dir list for extractors
// ===========================================
// Centralised so a new "obviously not project code" directory only needs
// to be added once instead of seven times. Each extractor walks the repo
// from `repoRoot` and skips any directory whose basename is in this set.
//
// History: `reference-repos/` was missing from this list, and 7 extractors
// were each walking 38K+ files there on every PostToolUse Edit
// (273k+ stat syscalls per event, ~25s of `scored_suggestions` phase
// time in latency.jsonl `phase_breakdown`). Adding it here closed that.

/** Basename-only directory names that no extractor should descend into.
 *  Order is irrelevant; new entries can be appended at any time. */
export const SHARED_SKIP_DIRS: ReadonlySet<string> = new Set([
	// VCS + build artefacts
	"node_modules",
	".git",
	"dist",
	"build",
	"__pycache__",
	"target",
	// Interlinked's own data dirs
	".interlinked",
	"interlinked",
	// External code the user keeps locally for browsing / cross-referencing.
	// Contains tens of thousands of files from cloned upstream repos
	// (ChatTTS, supermodel-cli, sondera, ...) and is not part of this
	// project's artefact graph by definition.
	"reference-repos",
]);
