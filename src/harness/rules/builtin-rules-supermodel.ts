// ===========================================
// Built-in Rules — Supermodel `.graph.*` shard write protection
// ===========================================
// Supermodel's daemon owns `.graph.*` shards. Agent writes corrupt the
// codebase graph because the daemon's next refresh treats the agent's
// payload as ground truth. Block writes at PreToolUse via the canonical
// pattern engine — matches Write/Edit/MultiEdit/NotebookEdit when
// `tool_input.file_path` ends in `.graph` or `.graph.<ext>`.
//
// `apply_patch` is covered separately in
// `evaluator/pre-tool.ts::checkSupermodelShardWrite` because that tool
// encodes file paths inside the patch text rather than in `file_path` —
// a regex-pattern rule on `field: file_path` cannot see them.
// Belt-and-suspenders.
//
// See `docs/design/graph-prediction-protocol.md §9`.

import type { GuardRule } from "../types.js";

const SHARD_REGEX = "\\.graph(\\.[a-zA-Z0-9]+)?$";

const REASON =
	"Supermodel `.graph.*` shards are read-only artifacts owned by Supermodel's daemon. " +
	"Writing to them corrupts the codebase graph and silently breaks impact analysis. " +
	"The graph_prediction contract lives in your response text, not on disk.";

const SUGGESTION =
	"If you intended to update the graph: edit the underlying source file and let Supermodel's " +
	"daemon re-emit the shard. If you intended to emit a graph_prediction: do so in a fenced " +
	"```yaml block in your response text.";

export const SUPERMODEL_RULES: GuardRule[] = [
	{
		id: "builtin-supermodel-graph-write-blocked",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
		action: "block",
		patterns: [
			{
				field: "file_path",
				regex: SHARD_REGEX,
				flags: "i",
			},
		],
		reason: REASON,
		suggestion: SUGGESTION,
		severity: "high",
		category: "filesystem",
	},
];
