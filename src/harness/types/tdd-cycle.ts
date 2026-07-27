// ===========================================
// TDD cycle tracking — types
// ===========================================
// Extracted from `session.ts` (which sits at the per-file line cap) so the
// cycle shape can carry the provenance the commit gate needs. Re-exported from
// `session.ts`, so every existing importer is unaffected.

/** State of the TDD red/green cycle for a single source file */
export type TddCycleState = "no_test" | "red" | "green" | "regression";

/** Tracks the red/green TDD cycle for a source file and its corresponding test */
export interface TddCycle {
	/** Absolute path to the source file being tested */
	source_file: string;
	/** Absolute path to the corresponding test file (null if none found) */
	test_file: string | null;
	/** Current state of the TDD cycle */
	state: TddCycleState;
	/** tool_call_count when the test file was first written/edited this session */
	test_written_at?: number | undefined;
	/** tool_call_count when tests first failed (entered RED) */
	red_at?: number | undefined;
	/**
	 * The command whose failure set the current RED, truncated for display.
	 *
	 * The commit gate's block reason previously named a file and nothing else,
	 * which is not enough to judge whether the block is live or a leftover from
	 * a failure many steps ago. Recording the run that caused it makes a stale
	 * red self-evident.
	 */
	red_command?: string | undefined;
	/** tool_call_count when tests first passed after being red (entered GREEN) */
	green_at?: number | undefined;
	/** Number of impl edits before any test interaction (writing test or running test) */
	impl_edits_before_test: number;
	/** Previous state — used to detect transitions (e.g., green→red = regression) */
	previous_state?: TddCycleState | undefined;
}
