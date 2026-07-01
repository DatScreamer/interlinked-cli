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
