import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getManagedSourceRoot,
	INTERLINKED_CLI_REPO_URL,
	resolveSourceRepoRoot,
	updateCommand,
} from "./update.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("update command module", () => {
	it("exports updateCommand as a function", () => {
		expect(typeof updateCommand).toBe("function");
	});

	it("uses the canonical GitHub source repo", () => {
		expect(INTERLINKED_CLI_REPO_URL).toBe(
			"https://github.com/QuentinCody/interlinked-cli.git",
		);
	});

	it("places the managed checkout under the user's interlinked home", () => {
		expect(getManagedSourceRoot("/tmp/home")).toBe("/tmp/home/.interlinked/interlinked-cli");
	});

	it("resolves source checkouts from the package root", () => {
		const tmp = mkdtempSync(join(tmpdir(), "interlinked-update-"));
		try {
			mkdirSync(join(tmp, ".git"));
			mkdirSync(join(tmp, "src"), { recursive: true });
			writeFileSync(join(tmp, "src", "index.ts"), "");
			expect(resolveSourceRepoRoot(tmp)).toBe(tmp);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
