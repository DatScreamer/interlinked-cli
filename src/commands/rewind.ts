// ===========================================
// interlinked rewind — Restore working tree to a checkpoint state
// ===========================================

import { rewindToCheckpoint } from "../lib/checkpoints.js";
import { c, kvLine } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

export async function rewindCommand(
	checkpointId?: string,
	opts?: { force?: boolean; list?: boolean; json?: boolean },
): Promise<void> {
	const mode = getOutputMode(opts || {});

	if (opts?.list || !checkpointId) {
		// Shorthand for checkpoint list
		const { checkpointListCommand } = await import("./checkpoint.js");
		return checkpointListCommand(opts?.json !== undefined ? { json: opts.json } : {});
	}

	try {
		const result = rewindToCheckpoint(checkpointId, {
			...(opts?.force !== undefined ? { force: opts.force } : {}),
		});

		output(mode, result, {
			json: () => result,
			normal: () => {
				const lines: string[] = [];
				if (result.success) {
					lines.push(c.green(`Rewound to checkpoint ${c.bold(checkpointId)}`));
					lines.push(kvLine("Files restored", String(result.files_restored.length)));
					if (result.warning) {
						lines.push(c.yellow(`Warning: ${result.warning}`));
					}
				} else {
					lines.push(c.red("Rewind failed"));
				}
				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}
