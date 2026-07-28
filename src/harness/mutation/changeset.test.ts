import { describe, expect, it } from "vitest";
import { type ChangeSet, changedPaths, normalizeChangeSet } from "./changeset.js";

describe("normalizeChangeSet", () => {
	it("normalizes a Write", () => {
		expect(normalizeChangeSet("Write", { file_path: "a.ts", content: "x" })).toEqual({
			ops: [{ kind: "write", path: "a.ts", content: "x" }],
		});
	});

	it("normalizes an Edit into a one-edit patch", () => {
		expect(normalizeChangeSet("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" })).toEqual({
			ops: [{ kind: "patch", path: "a.ts", edits: [{ oldString: "x", newString: "y" }] }],
		});
	});

	it("normalizes a MultiEdit into a multi-edit patch", () => {
		const input = {
			file_path: "a.ts",
			edits: [
				{ old_string: "x", new_string: "y" },
				{ old_string: "p", new_string: "q" },
			],
		};
		expect(normalizeChangeSet("MultiEdit", input)).toEqual({
			ops: [
				{
					kind: "patch",
					path: "a.ts",
					edits: [
						{ oldString: "x", newString: "y" },
						{ oldString: "p", newString: "q" },
					],
				},
			],
		});
	});

	it.each<[string, string, unknown]>([
		["a non-mutating tool", "Read", { file_path: "a.ts" }],
		["null input", "Write", null],
		["Write missing content", "Write", { file_path: "a.ts" }],
		["Write missing path", "Write", { content: "x" }],
		["Edit missing new_string", "Edit", { file_path: "a.ts", old_string: "x" }],
		["MultiEdit non-array edits", "MultiEdit", { file_path: "a.ts", edits: "nope" }],
		["MultiEdit edit missing a field", "MultiEdit", { file_path: "a.ts", edits: [{ old_string: "x" }] }],
		["MultiEdit edit not an object", "MultiEdit", { file_path: "a.ts", edits: [42] }],
		["MultiEdit missing path", "MultiEdit", { edits: [] }],
	])("returns null for %s", (_label, tool, input) => {
		expect(normalizeChangeSet(tool, input)).toBeNull();
	});
});

describe("changedPaths", () => {
	it("collects and dedupes paths across op kinds, expanding renames", () => {
		const set: ChangeSet = {
			ops: [
				{ kind: "write", path: "a.ts", content: "" },
				{ kind: "patch", path: "a.ts", edits: [] },
				{ kind: "delete", path: "b.ts" },
				{ kind: "rename", from: "c.ts", to: "d.ts" },
			],
		};
		expect(changedPaths(set).sort()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
	});
});

// ---------------------------------------------------------------------------
// Phase D ratchet: 8 survivors of 93, all in the field-presence guards. This is
// where a tool_input becomes the thing the gate measures — a guard that stops
// rejecting produces a ChangeSet with an undefined path or body, and the run
// then measures something other than the edit.
// ---------------------------------------------------------------------------

describe("Write requires both a path and a body", () => {
	it("accepts a well-formed Write", () => {
		expect(normalizeChangeSet("Write", { file_path: "a.ts", content: "x" })).not.toBeNull();
	});

	it("rejects a Write with no file_path", () => {
		expect(normalizeChangeSet("Write", { content: "x" })).toBeNull();
	});

	it("rejects a Write with no content", () => {
		expect(normalizeChangeSet("Write", { file_path: "a.ts" })).toBeNull();
	});

	it("rejects a Write whose fields are not strings", () => {
		expect(normalizeChangeSet("Write", { file_path: 1, content: "x" })).toBeNull();
		expect(normalizeChangeSet("Write", { file_path: "a.ts", content: 1 })).toBeNull();
	});

	it("accepts an empty body — an empty file is a real edit, not a missing field", () => {
		expect(normalizeChangeSet("Write", { file_path: "a.ts", content: "" })).not.toBeNull();
	});
});

describe("Edit requires a path and both sides of the replacement", () => {
	const ok = { file_path: "a.ts", old_string: "x", new_string: "y" };

	it("accepts a well-formed Edit", () => {
		expect(normalizeChangeSet("Edit", ok)).not.toBeNull();
	});

	for (const field of ["file_path", "old_string", "new_string"] as const) {
		it(`rejects an Edit with no ${field}`, () => {
			const { [field]: _omitted, ...rest } = ok;
			expect(normalizeChangeSet("Edit", rest)).toBeNull();
		});

		it(`rejects an Edit whose ${field} is not a string`, () => {
			expect(normalizeChangeSet("Edit", { ...ok, [field]: 7 })).toBeNull();
		});
	}

	it("accepts an empty new_string — deletion is a legal edit", () => {
		expect(normalizeChangeSet("Edit", { ...ok, new_string: "" })).not.toBeNull();
	});
});

describe("MultiEdit rejects a partially-malformed edit list", () => {
	const edit = { old_string: "x", new_string: "y" };

	it("accepts a list of well-formed edits", () => {
		expect(normalizeChangeSet("MultiEdit", { file_path: "a.ts", edits: [edit, edit] })).not.toBeNull();
	});

	it("rejects the WHOLE patch when one edit is malformed", () => {
		// All-or-nothing on purpose: applying the good half of a patch would
		// measure a state the agent never proposed.
		expect(normalizeChangeSet("MultiEdit", { file_path: "a.ts", edits: [edit, { old_string: "x" }] })).toBeNull();
	});

	it("rejects a non-object entry in the edit list", () => {
		expect(normalizeChangeSet("MultiEdit", { file_path: "a.ts", edits: [edit, null] })).toBeNull();
	});

	it("rejects an edits field that is not an array", () => {
		expect(normalizeChangeSet("MultiEdit", { file_path: "a.ts", edits: "nope" })).toBeNull();
	});
});
