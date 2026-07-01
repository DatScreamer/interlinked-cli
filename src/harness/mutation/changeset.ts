// ===========================================
// Per-edit mutation — ChangeSet normalization (build step 3, spec §5/§7)
// ===========================================
// A tool_input is not one file: Claude Code Write/Edit/MultiEdit (and, later,
// Codex apply_patch) can touch multiple files. The mutation gate's overlay,
// affected-test set, and changed region all derive from ONE atomic ChangeSet —
// so this normalizes the runner-specific tool_input into that shape. Reads
// `unknown` input through type predicates (no casts).

export interface PatchEdit {
	oldString: string;
	newString: string;
}

export type FileOp =
	| { kind: "write"; path: string; content: string }
	| { kind: "patch"; path: string; edits: PatchEdit[] }
	| { kind: "delete"; path: string }
	| { kind: "rename"; from: string; to: string };

export interface ChangeSet {
	ops: FileOp[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object";
}

function str(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

function writeOp(input: Record<string, unknown>): ChangeSet | null {
	const path = str(input.file_path);
	const content = str(input.content);
	if (path === null || content === null) return null;
	return { ops: [{ kind: "write", path, content }] };
}

function editOp(input: Record<string, unknown>): ChangeSet | null {
	const path = str(input.file_path);
	const oldString = str(input.old_string);
	const newString = str(input.new_string);
	if (path === null || oldString === null || newString === null) return null;
	return { ops: [{ kind: "patch", path, edits: [{ oldString, newString }] }] };
}

function parseEdits(value: unknown): PatchEdit[] | null {
	if (!Array.isArray(value)) return null;
	const edits: PatchEdit[] = [];
	for (const raw of value) {
		if (!isRecord(raw)) return null;
		const oldString = str(raw.old_string);
		const newString = str(raw.new_string);
		if (oldString === null || newString === null) return null;
		edits.push({ oldString, newString });
	}
	return edits;
}

function multiEditOp(input: Record<string, unknown>): ChangeSet | null {
	const path = str(input.file_path);
	const edits = parseEdits(input.edits);
	if (path === null || edits === null) return null;
	return { ops: [{ kind: "patch", path, edits }] };
}

/** Normalize a Claude Code tool_input into a ChangeSet, or null for non-mutating tools. */
export function normalizeChangeSet(toolName: string, toolInput: unknown): ChangeSet | null {
	if (!isRecord(toolInput)) return null;
	switch (toolName) {
		case "Write":
			return writeOp(toolInput);
		case "Edit":
			return editOp(toolInput);
		case "MultiEdit":
			return multiEditOp(toolInput);
		default:
			return null;
	}
}

/** Every path the change set touches (affected-test selection + changed-region scope). */
export function changedPaths(set: ChangeSet): string[] {
	const paths = new Set<string>();
	for (const op of set.ops) {
		if (op.kind === "rename") {
			paths.add(op.from);
			paths.add(op.to);
		} else {
			paths.add(op.path);
		}
	}
	return [...paths];
}
