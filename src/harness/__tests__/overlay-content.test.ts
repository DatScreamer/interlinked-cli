// Behavioral tests for overlay content resolution (`resolveProposedContent`).
//
// The function computes the PROPOSED FULL FILE CONTENT for a write/edit tool
// call so downstream content-quality checks see the post-patch file rather
// than just the replacement snippet. We mock `node:fs` so disk state is
// deterministic and so the defensive `readFileSync` catch branch is reachable
// (existsSync true + readFileSync throwing).

import { existsSync as mockedExistsSync, readFileSync as mockedReadFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../../lib/json-types.js";
import { resolveProposedContent } from "../overlay-content.js";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
}));

const existsSync = vi.mocked(mockedExistsSync);
const readFileSync = vi.mocked(mockedReadFileSync);

const FILE = "/repo/src/example.ts";

/** Configure the mocked disk: a path either has content or doesn't exist. */
function setDisk(content: string | null): void {
	if (content === null) {
		existsSync.mockReturnValue(false);
		readFileSync.mockImplementation(() => {
			throw new Error("ENOENT: should not be read when file is absent");
		});
		return;
	}
	existsSync.mockReturnValue(true);
	readFileSync.mockReturnValue(content);
}

beforeEach(() => {
	vi.clearAllMocks();
	setDisk(null);
});

describe("resolveProposedContent — Write tool", () => {
	it("returns tool_input.content verbatim as the full file", () => {
		const content = "export const x = 1;\n// full file body\n";
		const input: JsonObject = { content };
		expect(resolveProposedContent(FILE, input)).toBe(content);
		// Write short-circuits before any disk access.
		expect(existsSync).not.toHaveBeenCalled();
		expect(readFileSync).not.toHaveBeenCalled();
	});

	it("treats an empty-string content as the full (empty) file", () => {
		// `typeof "" === "string"` so this must short-circuit, not fall through.
		const input: JsonObject = { content: "" };
		expect(resolveProposedContent(FILE, input)).toBe("");
		expect(existsSync).not.toHaveBeenCalled();
	});

	it("does not treat a non-string content as a Write (falls through to Edit path)", () => {
		setDisk("disk base\n");
		// content is a number → not a Write; no edits/old_string → fallback path.
		const input: JsonObject = { content: 123 };
		// No old_string, no new_string → newString("") || base → base.
		expect(resolveProposedContent(FILE, input)).toBe("disk base\n");
		expect(existsSync).toHaveBeenCalledWith(FILE);
	});
});

describe("resolveProposedContent — Edit tool", () => {
	it("splices new_string into disk content at old_string", () => {
		setDisk("const a = 1;\nconst b = OLD;\nconst c = 3;\n");
		const input: JsonObject = { old_string: "OLD", new_string: "NEW" };
		expect(resolveProposedContent(FILE, input)).toBe(
			"const a = 1;\nconst b = NEW;\nconst c = 3;\n",
		);
	});

	it("replaces only the FIRST occurrence of old_string (String.replace semantics)", () => {
		setDisk("X then X again\n");
		const input: JsonObject = { old_string: "X", new_string: "Y" };
		expect(resolveProposedContent(FILE, input)).toBe("Y then X again\n");
	});

	it("falls back to new_string when old_string is not found on disk", () => {
		setDisk("totally unrelated content\n");
		const input: JsonObject = { old_string: "ABSENT", new_string: "snippet only\n" };
		// Splice can't succeed → fallback to the raw new_string.
		expect(resolveProposedContent(FILE, input)).toBe("snippet only\n");
	});

	it("falls back to new_string for a new-file Edit (file missing on disk)", () => {
		setDisk(null); // existsSync false → base stays ""
		const input: JsonObject = { old_string: "anything", new_string: "fresh file body\n" };
		expect(resolveProposedContent(FILE, input)).toBe("fresh file body\n");
		// existsSync queried, readFileSync never called (guarded by existsSync).
		expect(existsSync).toHaveBeenCalledWith(FILE);
		expect(readFileSync).not.toHaveBeenCalled();
	});

	it("returns disk base when both new_string and old_string are absent", () => {
		setDisk("base survives\n");
		// No old_string/new_string → oldString "" (skip splice), newString "" → base.
		const input: JsonObject = {};
		expect(resolveProposedContent(FILE, input)).toBe("base survives\n");
	});

	it("returns empty string when file missing and no new_string given", () => {
		setDisk(null);
		const input: JsonObject = {};
		// base "" and newString "" → "" || "" → "".
		expect(resolveProposedContent(FILE, input)).toBe("");
	});

	it("ignores a non-string old_string (coerced to '') and uses new_string fallback", () => {
		setDisk("disk content with marker\n");
		// old_string is a number → typeof check fails → oldString "" → skip splice.
		const input: JsonObject = { old_string: 42, new_string: "fallback body\n" };
		expect(resolveProposedContent(FILE, input)).toBe("fallback body\n");
	});

	it("ignores a non-string new_string (coerced to '') and returns disk base", () => {
		setDisk("disk content\n");
		// old_string absent (skip splice), new_string non-string → newString "" → base.
		const input: JsonObject = { new_string: { not: "a string" } };
		expect(resolveProposedContent(FILE, input)).toBe("disk content\n");
	});

	it("splices an empty new_string (deletion) when old_string matches", () => {
		setDisk("keep REMOVE keep\n");
		// new_string "" is falsy but the splice path is taken because old_string matches.
		const input: JsonObject = { old_string: "REMOVE ", new_string: "" };
		expect(resolveProposedContent(FILE, input)).toBe("keep keep\n");
	});
});

describe("resolveProposedContent — MultiEdit tool", () => {
	it("applies the edits array in sequence against disk content", () => {
		setDisk("alpha beta gamma\n");
		const input: JsonObject = {
			edits: [
				{ old_string: "alpha", new_string: "ALPHA" },
				{ old_string: "gamma", new_string: "GAMMA" },
			],
		};
		expect(resolveProposedContent(FILE, input)).toBe("ALPHA beta GAMMA\n");
	});

	it("applies edits cumulatively — a later edit sees an earlier edit's output", () => {
		setDisk("step0\n");
		const input: JsonObject = {
			edits: [
				{ old_string: "step0", new_string: "step1" },
				{ old_string: "step1", new_string: "step2" },
			],
		};
		expect(resolveProposedContent(FILE, input)).toBe("step2\n");
	});

	it("skips edits whose old_string is not present, applies the rest", () => {
		setDisk("only-this-exists\n");
		const input: JsonObject = {
			edits: [
				{ old_string: "missing", new_string: "x" },
				{ old_string: "only-this-exists", new_string: "replaced" },
			],
		};
		expect(resolveProposedContent(FILE, input)).toBe("replaced\n");
	});

	it("skips edits with an empty/absent old_string (no global insert)", () => {
		setDisk("untouched base\n");
		const input: JsonObject = {
			// One entry with empty old_string, one with old_string omitted entirely.
			edits: [{ old_string: "", new_string: "ignored" }, { new_string: "also ignored" }],
		};
		expect(resolveProposedContent(FILE, input)).toBe("untouched base\n");
	});

	it("skips null and non-object entries inside the edits array", () => {
		setDisk("target here\n");
		const input: JsonObject = {
			edits: [null, "a bare string", 7, { old_string: "target", new_string: "hit" }],
		};
		expect(resolveProposedContent(FILE, input)).toBe("hit here\n");
	});

	it("treats an absent new_string in an edit entry as deletion ('')", () => {
		setDisk("drop[THIS]keep\n");
		const input: JsonObject = {
			edits: [{ old_string: "[THIS]" }], // new_string omitted → "" → deletion
		};
		expect(resolveProposedContent(FILE, input)).toBe("dropkeep\n");
	});

	it("returns the unmodified disk base when the edits array is empty", () => {
		setDisk("nothing to do\n");
		const input: JsonObject = { edits: [] };
		expect(resolveProposedContent(FILE, input)).toBe("nothing to do\n");
	});

	it("starts MultiEdit from an empty base when the file is missing", () => {
		setDisk(null);
		const input: JsonObject = {
			// No old_string matches empty base, so nothing applies → "".
			edits: [{ old_string: "x", new_string: "y" }],
		};
		expect(resolveProposedContent(FILE, input)).toBe("");
		expect(readFileSync).not.toHaveBeenCalled();
	});
});

describe("resolveProposedContent — defensive disk-read failure", () => {
	it("falls through to new_string when existsSync is true but readFileSync throws", () => {
		// Force the catch branch: file reported present, read explodes (e.g. EACCES).
		existsSync.mockReturnValue(true);
		readFileSync.mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});
		const input: JsonObject = { old_string: "anything", new_string: "recovered snippet\n" };
		// base stays "" → splice can't match → fallback to new_string.
		expect(resolveProposedContent(FILE, input)).toBe("recovered snippet\n");
		expect(readFileSync).toHaveBeenCalledWith(FILE, "utf-8");
	});

	it("recovers to empty content for a MultiEdit when readFileSync throws", () => {
		existsSync.mockReturnValue(true);
		readFileSync.mockImplementation(() => {
			throw new Error("EIO: read error");
		});
		const input: JsonObject = { edits: [{ old_string: "z", new_string: "w" }] };
		// base "" after catch → no edit matches → "".
		expect(resolveProposedContent(FILE, input)).toBe("");
	});
});
