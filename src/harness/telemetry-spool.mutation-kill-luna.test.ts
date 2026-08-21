import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FsState = {
	files: Map<string, string>;
	dirs: Set<string>;
	appendCalls: Array<{ path: string; text: string }>;
	writes: Array<{ path: string; text: string }>;
	mkdirs: Array<{ path: string; options: { recursive: boolean } }>;
	readError: boolean;
	statError: boolean;
};

const fsState = vi.hoisted<FsState>(() => ({
	files: new Map(),
	dirs: new Set(),
	appendCalls: [],
	writes: [],
	mkdirs: [],
	readError: false,
	statError: false,
}));

vi.mock("node:fs", () => ({
	appendFileSync: (path: string, text: string) => {
		if (fsState.readError) throw new Error("append failed");
		fsState.appendCalls.push({ path, text });
		fsState.files.set(path, `${fsState.files.get(path) ?? ""}${text}`);
	},
	existsSync: (path: string) => fsState.files.has(path) || fsState.dirs.has(path),
	mkdirSync: (path: string, options: { recursive: boolean }) => {
		fsState.mkdirs.push({ path, options });
		fsState.dirs.add(path);
	},
	readFileSync: (path: string) => {
		if (fsState.readError) throw new Error("read failed");
		return fsState.files.get(path) ?? "";
	},
	statSync: (path: string) => {
		if (fsState.statError) throw new Error("stat failed");
		return { size: Buffer.byteLength(fsState.files.get(path) ?? "", "utf-8") };
	},
	writeFileSync: (path: string, text: string) => {
		fsState.writes.push({ path, text });
		fsState.files.set(path, text);
	},
}));

import {
	createTelemetrySpool,
	parseJsonl,
	redactSecretsShallow,
	truncateFilePaths,
	type SpoolEvent,
} from "./telemetry-spool.js";

const PATH = "/tmp/telemetry/events.jsonl";

function event(kind: SpoolEvent["kind"] = "hook_decision", extra: Record<string, unknown> = {}): SpoolEvent {
	return { schema: "v1", kind, ts: "2026-08-20T00:00:00.000Z", ...extra };
}

function put(...events: SpoolEvent[]): void {
	fsState.files.set(PATH, events.map((value) => JSON.stringify(value)).join("\n") + "\n");
}

beforeEach(() => {
	fsState.files.clear();
	fsState.dirs.clear();
	fsState.appendCalls.length = 0;
	fsState.writes.length = 0;
	fsState.mkdirs.length = 0;
	fsState.readError = false;
	fsState.statError = false;
});

afterEach(() => vi.restoreAllMocks());

describe("parseJsonl public validation", () => {
	// test-contract: boundary — malformed, blank, primitive, array, and partially shaped lines are ignored while a valid event survives.
	it("accepts only v1 events with string kind and timestamp", () => {
		const valid = event("custom", { marker: "kept" });
		const text = [
			"",
			"not-json",
			"null",
			"42",
			"[]",
			JSON.stringify({ schema: "v2", kind: "custom", ts: valid.ts }),
			JSON.stringify({ schema: "v1", kind: 7, ts: valid.ts }),
			JSON.stringify({ schema: "v1", kind: "custom", ts: 7 }),
			JSON.stringify(valid),
		].join("\n");
		expect(parseJsonl(text)).toStrictEqual([valid]);
	});

	// test-contract: boundary — an empty input is the public zero-event result, distinct from a line containing JSON false.
	it("returns no events for empty text and for a false primitive", () => {
		expect(parseJsonl("")).toStrictEqual([]);
		expect(parseJsonl("false\n")).toStrictEqual([]);
	});
});

describe("built-in redactors", () => {
	// test-contract: security — only the top-level secrets key is removed; nested secrets and unrelated fields must remain unchanged.
	it("redacts shallow secrets without over-redacting", () => {
		const input = event("custom", { secrets: { token: "x" }, nested: { secrets: "keep" }, note: "keep" });
		const result = redactSecretsShallow(input);
		expect(result).toStrictEqual({ schema: "v1", kind: "custom", ts: input.ts, nested: { secrets: "keep" }, note: "keep" });
		expect("secrets" in result).toBe(false);
		expect("secrets" in input).toBe(true);
	});

	// test-contract: boundary — file paths at exactly 200 characters remain untouched, while 201 characters receive the documented ellipsis.
	it("truncates only paths longer than 200 characters", () => {
		const atLimit = "a".repeat(200);
		const overLimit = "b".repeat(201);
		expect(truncateFilePaths(event("custom", { file_path: atLimit })).file_path).toBe(atLimit);
		expect(truncateFilePaths(event("custom", { file_path: overLimit })).file_path).toBe(`${"b".repeat(200)}...`);
	});

	// test-contract: security — non-string file_path values are not coerced or modified by a string-only redactor.
	it("leaves non-string file paths unchanged", () => {
		const input = event("custom", { file_path: 200 });
		expect(truncateFilePaths(input)).toStrictEqual(input);
	});
});

describe("telemetry spool public contracts", () => {
	// test-contract: invariant — nested parent directories are created once at construction with recursive semantics.
	it("creates the spool directory during construction", () => {
		createTelemetrySpool({ spoolPath: PATH });
		expect(fsState.mkdirs).toStrictEqual([{ path: "/tmp/telemetry", options: { recursive: true } }]);
	});

	// test-contract: public-api — append serializes the redacted event exactly once with one trailing newline and readAll round-trips it.
	it("appends exact JSONL and reads valid events", () => {
		const spool = createTelemetrySpool({ spoolPath: PATH, redactors: [redactSecretsShallow] });
		const input = event("custom", { secrets: "remove", value: "preserve" });
		spool.append(input);
		expect(fsState.appendCalls).toStrictEqual([{ path: PATH, text: `${JSON.stringify({ ...input, secrets: undefined })}\n` }]);
		expect(spool.readAll()).toStrictEqual([event("custom", { value: "preserve" })]);
	});

	// test-contract: invariant — readAll ignores malformed lines and fails open to an empty list when the file read errors.
	it("reads valid lines around malformed data and fails open on read errors", () => {
		put(event("custom", { id: 1 }));
		fsState.files.set(PATH, `${fsState.files.get(PATH)}broken\nnull\n`);
		const spool = createTelemetrySpool({ spoolPath: PATH });
		expect(spool.readAll()).toStrictEqual([event("custom", { id: 1 })]);
		fsState.readError = true;
		expect(spool.readAll()).toStrictEqual([]);
	});

	// test-contract: boundary — size reports UTF-8 byte length for an existing file and the zero/nonexistent shape for an absent file.
	it("reports byte size and existence precisely", () => {
		const spool = createTelemetrySpool({ spoolPath: PATH });
		expect(spool.size()).toStrictEqual({ bytes: 0, exists: false });
		fsState.files.set(PATH, "é\n");
		expect(spool.size()).toStrictEqual({ bytes: 3, exists: true });
		fsState.statError = true;
		expect(spool.size()).toStrictEqual({ bytes: 0, exists: true });
	});

	// test-contract: invariant — compact keeps newest ordinary events within half-capacity while retaining preferred events and chronological disk order.
	it("compacts by byte budget, preference, and source order", () => {
		const first = event("daemon_event", { id: "old" });
		const preferred = event("check_finding", { id: "preferred" });
		const newest = event("hook_decision", { id: "new" });
		put(first, preferred, newest);
		const spool = createTelemetrySpool({ spoolPath: PATH, max_bytes: 360 });
		const result = spool.compact();
		expect(result).toStrictEqual({ removed: 1, kept: 2 });
		expect(spool.readAll()).toStrictEqual([preferred, newest]);
		expect(fsState.writes.at(-1)?.text).toBe(`${JSON.stringify(preferred)}\n${JSON.stringify(newest)}\n`);
	});

	// test-contract: boundary — a line exactly filling the target budget is retained, proving the budget comparison is strict rather than inclusive.
	it("retains an ordinary event exactly at the half-capacity boundary", () => {
		const only = event("daemon_event", { id: "exact" });
		const lineBytes = Buffer.byteLength(`${JSON.stringify(only)}\n`, "utf-8");
		put(only);
		const spool = createTelemetrySpool({ spoolPath: PATH, max_bytes: lineBytes * 2 });
		expect(spool.compact()).toStrictEqual({ removed: 0, kept: 1 });
		expect(spool.readAll()).toStrictEqual([only]);
	});

	// test-contract: boundary — append triggers compaction at the configured threshold, but not below it.
	it("honors compaction threshold equality", () => {
		const sample = event("custom", { x: "x" });
		const line = `${JSON.stringify(sample)}\n`;
		const spool = createTelemetrySpool({ spoolPath: PATH, max_bytes: Buffer.byteLength(line), trim_threshold: 1 });
		spool.append(sample);
		expect(fsState.writes).toHaveLength(1);
	});

	// test-contract: public-api — explicit compact on an absent or unreadable spool is a no-op result rather than an exception.
	it("fails open for absent and unreadable compaction inputs", () => {
		const spool = createTelemetrySpool({ spoolPath: PATH });
		expect(spool.compact()).toStrictEqual({ removed: 0, kept: 0 });
		fsState.files.set(PATH, `${JSON.stringify(event("custom"))}\n`);
		fsState.readError = true;
		expect(spool.compact()).toStrictEqual({ removed: 0, kept: 0 });
	});
});
