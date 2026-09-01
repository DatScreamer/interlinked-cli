import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fileIdentity,
	FileIdentityChangedError,
	replaceFileWithSuffix,
} from "./file-suffix-replacement.js";
import {
	appendFileWithMutationLock,
	FileMutationLockTimeoutError,
} from "./file-mutation-lock.js";

describe("append-safe suffix replacement", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "suffix-replacement-"));
		path = join(dir, "activity.jsonl");
		writeFileSync(path, "old-1\nold-2\nkeep\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("preserves an append injected after the initial suffix copy and before rename", () => {
		const start = Buffer.byteLength("old-1\nold-2\n");
		const prepared = replaceFileWithSuffix(path, start, {
			afterInitialCopy: () => appendFileSync(path, "racing-append\n"),
		});
		expect(readFileSync(path, "utf8")).toBe("keep\nracing-append\n");
		expect(prepared.retainedBytes).toBe(Buffer.byteLength("keep\nracing-append\n"));
	});

	it("publishes source and replacement inode identities before the atomic swap", () => {
		const source = fileIdentity(path);
		let callbackSawReplacement = false;
		const prepared = replaceFileWithSuffix(path, Buffer.byteLength("old-1\n"), {
			expectedSource: source,
			beforeReplace: (pending) => {
				callbackSawReplacement = readFileSync(pending.temporaryPath, "utf8") === "old-2\nkeep\n";
			},
		});
		expect(callbackSawReplacement).toBe(true);
		expect(fileIdentity(path)).toEqual(prepared.replacement);
	});

	it("refuses to replace a different inode than the caller planned", () => {
		const expected = fileIdentity(path);
		rmSync(path);
		writeFileSync(path, "foreign\n");
		expect(() => replaceFileWithSuffix(path, 0, { expectedSource: expected })).toThrow(
			FileIdentityChangedError,
		);
		expect(readFileSync(path, "utf8")).toBe("foreign\n");
	});

	it("runs afterReplace after the rename but before releasing the append lock", () => {
		let sawReplacement = false;
		const prepared = replaceFileWithSuffix(path, Buffer.byteLength("old-1\n"), {
			afterReplace: (replacement) => {
				sawReplacement = fileIdentity(path).ino === replacement.replacement.ino;
				expect(() =>
					appendFileWithMutationLock(path, "overlap\n", { waitMs: 0 }),
				).toThrow(FileMutationLockTimeoutError);
			},
		});
		expect(sawReplacement).toBe(true);
		expect(fileIdentity(path)).toEqual(prepared.replacement);
		expect(readFileSync(path, "utf8")).toBe("old-2\nkeep\n");
	});
});
