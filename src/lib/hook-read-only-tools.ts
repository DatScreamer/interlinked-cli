// ===========================================
// Read-only tool names — the ONE definition
// ===========================================
// A tool in this set CANNOT write a file. Two surfaces need that fact and used
// to answer it separately:
//
//   1. the generated `.mjs` hook runtime (`hooks-template.ts`), which
//      fast-paths a successful read-only PostToolUse without contacting the
//      daemon at all; and
//   2. the daemon's PostToolUse path resolver
//      (`harness/server/post-tool-pipeline-paths.ts`), which must not
//      ATTRIBUTE observed filesystem effects to a call that cannot have caused
//      them.
//
// (2) is the load-bearing one. The daemon builds a PostToolUse's edited-file
// list from `event.change_set.files` — a post-call filesystem DIFF. A Read /
// Grep / WebFetch cannot write, so any path in its ChangeSet was written by
// somebody else inside the call's window (another agent on the same tree, a
// background test run, a watcher). Attributing those paths to the read-only
// call dragged the whole per-file quality pipeline — including `affected_tests`,
// which shells out to vitest — onto a command that changed nothing: an `rg`
// measured at ~21s reporting a test failure it did not cause.
//
// One list, two consumers, so the two surfaces cannot drift into two opinions.
//
// **Bash is deliberately NOT here.** A shell command's effects are only knowable
// from the post-call comparison, and the bash-edit obligation gate is built on
// exactly that ChangeSet. Nor is an unknown tool: a tool nobody has classified
// keeps its ChangeSet, so a new writer cannot open the bypass merely by using
// an unfamiliar name.

/**
 * Tool names with no write capability. Claude Code spelling is canonical;
 * {@link isReadOnlyToolName} matches the normalized spellings other runners
 * deliver (`web_fetch`, `read`, …) against the same list.
 *
 * Interpolated verbatim into the generated `.mjs` hook runtime — keep the
 * values JSON-serializable strings.
 */
export const READ_ONLY_TOOL_NAMES = [
	"Read",
	"Glob",
	"Grep",
	"WebFetch",
	"WebSearch",
	"TodoRead",
	"NotebookRead",
	"ListFiles",
	// Codex collaboration-control calls can start or observe another agent, but
	// the call itself does not write this workspace. Any filesystem delta in its
	// hook window belongs to that other agent and must not be charged to the
	// coordinator (observed live on wait_agent during concurrent edits).
	"collaborationspawn_agent",
	"collaborationsend_message",
	"collaborationfollowup_task",
	"collaborationinterrupt_agent",
	"collaborationlist_agents",
	"collaborationwait_agent",
] as const;

/** Case- and separator-insensitive key: `WebFetch`, `web_fetch` and `webfetch`
 *  all collapse to `webfetch`. The daemon sees Claude Code's native casing but
 *  the *normalized* lowercase_snake spelling from every other runner (see
 *  `evaluator-unified.ts::nativeToolName`), so a raw string compare would let
 *  a Copilot/Gemini read through as a writer. */
function readOnlyToolKey(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const READ_ONLY_TOOL_KEYS: ReadonlySet<string> = new Set(
	READ_ONLY_TOOL_NAMES.map(readOnlyToolKey),
);

/**
 * True when this tool name cannot write a file.
 *
 * Unknown names return false — the safe direction. Being wrong here costs a
 * needless check pass; being wrong the other way silently drops a real edit
 * out of the quality pipeline.
 */
export function isReadOnlyToolName(toolName: string | null | undefined): boolean {
	if (!toolName) return false;
	return READ_ONLY_TOOL_KEYS.has(readOnlyToolKey(toolName));
}
