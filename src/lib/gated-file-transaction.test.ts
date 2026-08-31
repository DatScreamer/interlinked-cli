import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	captureGatedWriteBaseline,
	commitGatedWrites,
	GatedWriteConflictError,
	GatedWriteLockError,
	gatedWriteLockPath,
} from "./gated-file-transaction.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-gated-write-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function read(path: string): string {
	return readFileSync(join(root, path), "utf-8");
}

describe("gated file transaction", () => {
	it("commits a multi-file batch and preserves an existing file mode", () => {
		writeFileSync(join(root, "a.txt"), "before-a");
		writeFileSync(join(root, "b.txt"), "before-b");
		chmodSync(join(root, "a.txt"), 0o744);
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "a.txt", content: "after-a" },
			{ path: "b.txt", content: "after-b" },
		]);

		commitGatedWrites(transaction);

		expect(read("a.txt")).toBe("after-a");
		expect(read("b.txt")).toBe("after-b");
		expect(lstatSync(join(root, "a.txt")).mode & 0o7777).toBe(0o744);
		expect(existsSync(gatedWriteLockPath(root))).toBe(false);
	});

	it("aborts the whole batch when any target drifts after capture", () => {
		writeFileSync(join(root, "a.txt"), "before-a");
		writeFileSync(join(root, "b.txt"), "before-b");
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "a.txt", content: "after-a" },
			{ path: "b.txt", content: "after-b" },
		]);
		writeFileSync(join(root, "b.txt"), "third-party");

		expect(() => commitGatedWrites(transaction)).toThrow(GatedWriteConflictError);
		expect(read("a.txt")).toBe("before-a");
		expect(read("b.txt")).toBe("third-party");
	});

	it("makes two same-baseline transactions serialize through CAS", () => {
		writeFileSync(join(root, "target.txt"), "base");
		const first = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "first" },
		]);
		const second = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "second" },
		]);

		commitGatedWrites(first);
		expect(() => commitGatedWrites(second)).toThrow(GatedWriteConflictError);
		expect(read("target.txt")).toBe("first");
	});

	it("detects a file created during the gate window", () => {
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "new.txt", content: "ours" },
		]);
		writeFileSync(join(root, "new.txt"), "theirs");

		expect(() => commitGatedWrites(transaction)).toThrow(GatedWriteConflictError);
		expect(read("new.txt")).toBe("theirs");
	});

	it("detects deletion and mode drift during the gate window", () => {
		writeFileSync(join(root, "deleted.txt"), "before");
		writeFileSync(join(root, "mode.txt"), "before");
		const deletion = captureGatedWriteBaseline(root, [
			{ path: "deleted.txt", content: "ours" },
		]);
		const mode = captureGatedWriteBaseline(root, [{ path: "mode.txt", content: "ours" }]);
		rmSync(join(root, "deleted.txt"));
		chmodSync(join(root, "mode.txt"), 0o700);

		expect(() => commitGatedWrites(deletion)).toThrow(GatedWriteConflictError);
		expect(() => commitGatedWrites(mode)).toThrow(GatedWriteConflictError);
		expect(existsSync(join(root, "deleted.txt"))).toBe(false);
		expect(read("mode.txt")).toBe("before");
	});

	it("supports creating and deleting regular files", () => {
		writeFileSync(join(root, "gone.txt"), "remove me");
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "created.txt", content: "created", mode: 0o640 },
			{ path: "gone.txt", content: null },
		]);

		commitGatedWrites(transaction);

		expect(read("created.txt")).toBe("created");
		expect(lstatSync(join(root, "created.txt")).mode & 0o7777).toBe(0o640);
		expect(existsSync(join(root, "gone.txt"))).toBe(false);
	});

	it("applies the process umask to a new file's default mode", () => {
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "default-mode.txt", content: "created" },
		]);

		commitGatedWrites(transaction);

		expect(lstatSync(join(root, "default-mode.txt")).mode & 0o7777).toBe(
			0o666 & ~process.umask(),
		);
	});

	it("fails closed on an existing lock and never overwrites it", () => {
		writeFileSync(join(root, "target.txt"), "before");
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "after" },
		]);
		const lockPath = gatedWriteLockPath(root);
		mkdirSync(join(root, ".interlinked", "transactions"), { recursive: true });
		writeFileSync(lockPath, JSON.stringify({ token: "incumbent" }));

		expect(() => commitGatedWrites(transaction)).toThrow(GatedWriteLockError);
		expect(read("target.txt")).toBe("before");
		expect(readFileSync(lockPath, "utf-8")).toContain("incumbent");
	});

	it("rejects duplicate, escaping, and symlink targets before gating", () => {
		writeFileSync(join(root, "real.txt"), "real");
		symlinkSync(join(root, "real.txt"), join(root, "link.txt"));

		expect(() =>
			captureGatedWriteBaseline(root, [
				{ path: "real.txt", content: "one" },
				{ path: join(root, "real.txt"), content: "two" },
			]),
		).toThrow(/Duplicate transactional target/);
		expect(() =>
			captureGatedWriteBaseline(root, [{ path: "../outside.txt", content: "no" }]),
		).toThrow(/escapes the Git worktree/);
		expect(() =>
			captureGatedWriteBaseline(root, [{ path: "link.txt", content: "no" }]),
		).toThrow(/regular file or missing/);
	});

	it("cleans transaction temp files after success and conflict", () => {
		writeFileSync(join(root, "target.txt"), "before");
		const success = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "after" },
		]);
		commitGatedWrites(success);
		const conflict = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "loser" },
		]);
		writeFileSync(join(root, "target.txt"), "newer");
		expect(() => commitGatedWrites(conflict)).toThrow(GatedWriteConflictError);

		expect(readdirSync(root).filter((name) => name.includes("interlinked-tx"))).toEqual([]);
	});

	it("uses distinct lock paths for distinct worktree roots", () => {
		const other = mkdtempSync(join(tmpdir(), "interlinked-gated-write-other-"));
		try {
			expect(gatedWriteLockPath(other)).not.toBe(gatedWriteLockPath(root));
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});
