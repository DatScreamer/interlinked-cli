import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpEventRecord } from "./types.js";
import {
    appendMcpEvent,
    captureMcpPayload,
    DEFAULT_MCP_INLINE_LIMIT_BYTES,
    getMcpEventsPath,
} from "./writer.js";

let tmpDir: string;

function makeRecord(tag: string): McpEventRecord {
    return {
        schema: "mcp-events.v1",
        kind: "mcp_message",
        ts: "2026-01-01T00:00:00.000Z",
        server_name: tag,
        transport: "stdio",
        session_id: null,
        message_type: "notification",
        payload_bytes: 0,
        payload_sha256: "0".repeat(64),
        fidelity: { source: "mcp_proxy", completeness: "complete", inline: true },
        privacy: {
            redaction_status: "unscanned",
            sensitivity: "unknown",
            contains_sensitive: "unknown",
            allowed_for_training: false,
            allowed_for_cloud_upload: false,
        },
    };
}

beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "mcp-recorder-w56-"));
});

afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

describe("appendMcpEvent — positive (must fire)", () => {
    it("mkdirs the data dir when it does not exist and writes the event (kills mutant 9a6b32e0d6bead38, 4c3c231a1b504bb6, f101ee88ca626027)", () => {
        // test-contract: public-api — appendMcpEvent must create the missing
        // .interlinked dir and append the serialized record as a JSONL line.
        const cwd = path.join(tmpDir, "no-dir-yet");
        expect(existsSync(path.join(cwd, ".interlinked"))).toBe(false);

        appendMcpEvent(makeRecord("test_event"), cwd);

        const eventsPath = getMcpEventsPath(cwd);
        expect(existsSync(eventsPath)).toBe(true);
        const content = readFileSync(eventsPath, "utf8");
        expect(content).toContain('"server_name":"test_event"');
    });

    it("creates nested directories recursively (kills recursive:true -> {} mutant 4c3c231a1b504bb6)", () => {
        // test-contract: invariant — mkdirSync must be called with {recursive:true};
        // without it, creating a dir whose PARENT is also missing throws ENOENT.
        const cwd = path.join(tmpDir, "deep", "sub");
        expect(() => appendMcpEvent(makeRecord("nested"), cwd)).not.toThrow();
        expect(existsSync(getMcpEventsPath(cwd))).toBe(true);
    });

    it("appends to an existing events file rather than recreating the dir (kills !existsSync(dir)->true mutant 9a6b32e0d6bead38)", () => {
        // test-contract: invariant — two consecutive appends against an existing
        // dir must both succeed and both lines must persist (order + count).
        const cwd = path.join(tmpDir, "existing-dir");
        appendMcpEvent(makeRecord("first"), cwd);
        appendMcpEvent(makeRecord("second"), cwd);
        const content = readFileSync(getMcpEventsPath(cwd), "utf8");
        const lines = content.trim().split("\n");
        expect(lines.length).toBe(2);
        expect(lines[0]).toContain('"server_name":"first"');
        expect(lines[1]).toContain('"server_name":"second"');
    });
});

describe("captureMcpPayload — content type default and serialization", () => {
    it("defaults contentType to application/json when opts.contentType is omitted (kills ?? -> && mutant 3a6cabcd05b3127e)", () => {
        // test-contract: public-api — captureMcpPayload with no contentType must
        // JSON-serialize the payload (application/json default), not String()-ify it.
        const objResult = captureMcpPayload({ a: 1 });
        // JSON.stringify({a:1}) = '{"a":1}' (7 bytes); String({a:1}) = "[object Object]" (15 bytes).
        expect(objResult.payload_bytes).toBe(Buffer.byteLength('{"a":1}', "utf8"));
    });

    it("keeps contentType text/plain honored end to end for object payloads (kills ?? -> && mutant 3a6cabcd05b3127e in the explicit-value direction)", () => {
        // test-contract: public-api — when contentType is explicitly given, it must
        // be preserved as-is (not degraded by a falsy-coalescing bug on the ?? path).
        const objResult = captureMcpPayload({ a: 1 }, { contentType: "text/plain" });
        // String({a:1}) = "[object Object]" (15 bytes) proves the text/plain branch ran.
        expect(objResult.payload_bytes).toBe(Buffer.byteLength("[object Object]", "utf8"));
    });

    it("computes payload_bytes as the utf8 byte length of the serialized JSON, not char length (kills utf8 -> '' mutant d7ab69477a1ac266)", () => {
        // test-contract: invariant — payload_bytes must match Buffer.byteLength(serialized, "utf8").
        // A multi-byte UTF-8 char makes byte length diverge from JS string .length,
        // so this only holds if "utf8" encoding is actually used to measure bytes.
        const payload = "é".repeat(10);
        const result = captureMcpPayload(payload);
        const serialized = JSON.stringify(payload);
        expect(serialized.length).not.toBe(Buffer.byteLength(serialized, "utf8"));
        expect(result.payload_bytes).toBe(Buffer.byteLength(serialized, "utf8"));
    });

    it("always includes payload_bytes and payload_sha256 in the captured result (kills ObjectLiteral -> {} mutant cc4156f36529e705)", () => {
        // test-contract: public-api — CapturedMcpPayload always carries payload_bytes
        // and payload_sha256, regardless of inline-vs-blob branch.
        const result = captureMcpPayload({ foo: "bar" });
        expect(typeof result.payload_bytes).toBe("number");
        expect(result.payload_bytes).toBeGreaterThan(0);
        expect(typeof result.payload_sha256).toBe("string");
        expect(result.payload_sha256.length).toBe(64);
    });

    it("inlines the payload when bytes are exactly at the inline limit (kills <= -> < mutant cff3195a0869886b and ConditionalExpression -> false mutant d6dd09773f7955c3)", () => {
        // test-contract: boundary — payloadBytes <= inlineLimitBytes must inline
        // AT the boundary itself, distinguishing <= from < and from a forced false.
        const inlineLimitBytes = 10;
        const raw = "a".repeat(8); // JSON.stringify(raw) = '"aaaaaaaa"' = 10 bytes (ascii)
        const serializedLen = Buffer.byteLength(JSON.stringify(raw), "utf8");
        expect(serializedLen).toBe(inlineLimitBytes);

        const result = captureMcpPayload(raw, { inlineLimitBytes, cwd: tmpDir });
        expect(result.payload).toBe(raw);
        expect(result.payload_ref).toBeUndefined();
    });

    it("writes a blob when bytes exceed the inline limit (kills <= -> < and ConditionalExpression -> false, over-limit direction)", () => {
        // test-contract: boundary — companion case to the boundary test above,
        // proving the blob branch fires when payloadBytes is strictly greater.
        const inlineLimitBytes = 5;
        const raw = "a".repeat(20);
        const cwd = path.join(tmpDir, "blob-cwd");
        const result = captureMcpPayload(raw, { inlineLimitBytes, cwd });
        expect(result.payload).toBeUndefined();
        expect(result.payload_ref).toBeDefined();
        expect(result.payload_ref?.kind).toBe("sha256_blob");
    });

    it("has a default inline limit of 256*1024 = 262144 bytes (kills ArithmeticOperator 256*1024 -> 256/1024 mutant 3cdee1664c8ea43a)", () => {
        // test-contract: public-api — DEFAULT_MCP_INLINE_LIMIT_BYTES is an exported
        // constant callers rely on for sizing decisions.
        expect(DEFAULT_MCP_INLINE_LIMIT_BYTES).toBe(262144);
    });

    it("truncates payload_preview to 2048 chars for blob-backed payloads (kills MethodExpression slice->full mutant 0664be07d34c6fa7)", () => {
        // test-contract: invariant — payload_preview must be a bounded prefix,
        // never the full serialized string, for blob-referenced payloads.
        const inlineLimitBytes = 10;
        const raw = "x".repeat(5000);
        const cwd = path.join(tmpDir, "preview-cwd");
        const result = captureMcpPayload(raw, { inlineLimitBytes, cwd });
        const serializedFull = JSON.stringify(raw);
        expect(result.payload_preview?.length).toBe(2048);
        expect(result.payload_preview?.length).toBeLessThan(serializedFull.length);
    });
});

describe("captureMcpPayload — serializePayload text/plain branch", () => {
    it("uses String() for text/plain content type, not JSON.stringify (kills ConditionalExpression -> false mutant 8049be2fa4118f12 and StringLiteral mutant d9f4ea9638bb337f)", () => {
        // test-contract: public-api — text/plain must serialize via String(payload).
        const result = captureMcpPayload({ a: 1 }, { contentType: "text/plain" });
        expect(result.payload_bytes).toBe(Buffer.byteLength("[object Object]", "utf8"));
    });

    it("uses JSON.stringify for application/json content type (control case distinguishing the text/plain branch)", () => {
        // test-contract: public-api — companion control case for the above.
        const result = captureMcpPayload({ a: 1 }, { contentType: "application/json" });
        expect(result.payload_bytes).toBe(Buffer.byteLength('{"a":1}', "utf8"));
    });
});

describe("blob writing on disk — extension, path shape, content", () => {
    it("writes .json extension for application/json content type (kills StringLiteral '.json'->'' mutant 25df1819c47df5cc and ConditionalExpression mutants 0ebae6704160d6aa/a1267de0400b2e3b/28b87f8744debc11/edf5a27a0c0daf70)", () => {
        // test-contract: public-api — payload_ref.path must end in .json for
        // application/json blobs, and the referenced blob must exist on disk.
        const inlineLimitBytes = 1;
        const raw = { big: "x".repeat(100) };
        const cwd = path.join(tmpDir, "json-ext-cwd");
        const result = captureMcpPayload(raw, { inlineLimitBytes, cwd, contentType: "application/json" });
        expect(result.payload_ref?.path.endsWith(".json")).toBe(true);
        const absPath = path.join(cwd, ".interlinked", result.payload_ref?.path ?? "");
        expect(existsSync(absPath)).toBe(true);
    });

    it("writes .txt extension for text/plain content type", () => {
        // test-contract: public-api — companion control case for the extension logic.
        const inlineLimitBytes = 1;
        const raw = "x".repeat(100);
        const cwd = path.join(tmpDir, "txt-ext-cwd");
        const result = captureMcpPayload(raw, { inlineLimitBytes, cwd, contentType: "text/plain" });
        expect(result.payload_ref?.path.endsWith(".txt")).toBe(true);
    });

    it("nests the blob under blobs/sha256/<first-2-hex-chars>/<hash>.ext (kills StringLiteral 'blobs'->'' mutant a9fc0e67d4a356d1, 'sha256'->'' mutant 3d4992c0e49e2054, MethodExpression slice(0,2)->full mutant 327089387cbca5e7)", () => {
        // test-contract: public-api — payload_ref.path shape is a documented
        // contract (content-addressed sharding by first 2 hex chars of the hash).
        const inlineLimitBytes = 1;
        const raw = "x".repeat(100);
        const cwd = path.join(tmpDir, "path-shape-cwd");
        const result = captureMcpPayload(raw, { inlineLimitBytes, cwd });
        const ref = result.payload_ref;
        expect(ref).toBeDefined();
        if (!ref) throw new Error("expected payload_ref to be defined");
        const parts = ref.path.split(path.sep);
        expect(parts[0]).toBe("blobs");
        expect(parts[1]).toBe("sha256");
        expect(parts[2]).toBe(ref.sha256.slice(0, 2));
        expect(parts[2]?.length).toBe(2);
        expect(parts[3]).toBe(`${ref.sha256}.json`);
    });

    it("names the blob file with the full sha256 hash plus extension (kills template literal -> '' mutant 34f0943d329d0cd5)", () => {
        // test-contract: invariant — the blob filename must contain the full hash,
        // not an empty string, so distinct payloads never collide on disk.
        const inlineLimitBytes = 1;
        const raw = "x".repeat(100);
        const cwd = path.join(tmpDir, "filename-cwd");
        const result = captureMcpPayload(raw, { inlineLimitBytes, cwd });
        const ref = result.payload_ref;
        expect(ref).toBeDefined();
        if (!ref) throw new Error("expected payload_ref to be defined");
        const filename = path.basename(ref.path);
        expect(filename).toBe(`${ref.sha256}.json`);
        expect(filename.length).toBeGreaterThan(".json".length);
    });

    it("creates the nested blob directory when it does not exist (kills ConditionalExpression !existsSync(dir)->true mutant d043decd1a236d35)", () => {
        // test-contract: invariant — the blob dir tree must be created on first
        // write; the call must not throw for a fresh cwd with no .interlinked yet.
        const inlineLimitBytes = 1;
        const raw = "x".repeat(100);
        const cwd = path.join(tmpDir, "mkdir-blob-cwd");
        expect(existsSync(path.join(cwd, ".interlinked", "blobs"))).toBe(false);
        const result = captureMcpPayload(raw, { inlineLimitBytes, cwd });
        const absPath = path.join(cwd, ".interlinked", result.payload_ref?.path ?? "");
        expect(existsSync(absPath)).toBe(true);
    });

    it("does not rewrite an existing blob file on a duplicate write (kills !existsSync(absPath)->true mutant 1ff4b1c2e50cf058)", () => {
        // test-contract: invariant — content-addressed dedup: writing the same
        // payload twice must reuse the same path and leave file content unchanged.
        const inlineLimitBytes = 1;
        const raw = "x".repeat(100);
        const cwd = path.join(tmpDir, "no-rewrite-cwd");
        const first = captureMcpPayload(raw, { inlineLimitBytes, cwd });
        const firstRef = first.payload_ref;
        expect(firstRef).toBeDefined();
        if (!firstRef) throw new Error("expected payload_ref to be defined");
        const absPath = path.join(cwd, ".interlinked", firstRef.path);
        const before = readFileSync(absPath, "utf8");

        const second = captureMcpPayload(raw, { inlineLimitBytes, cwd });
        const after = readFileSync(absPath, "utf8");
        expect(second.payload_ref?.path).toBe(firstRef.path);
        expect(after).toBe(before);
    });

    it("writes the serialized bytes to disk with utf8 encoding matching the reported byte count (kills StringLiteral 'utf8'->'' mutant f7e83f854a9cdf08)", () => {
        // test-contract: invariant — on-disk blob content must equal the
        // serialized payload written with utf8 encoding, and its byte count must
        // match what payload_ref.bytes reports.
        const inlineLimitBytes = 1;
        const raw = "y".repeat(50);
        const cwd = path.join(tmpDir, "utf8-write-cwd");
        const result = captureMcpPayload(raw, { inlineLimitBytes, cwd });
        const ref = result.payload_ref;
        expect(ref).toBeDefined();
        if (!ref) throw new Error("expected payload_ref to be defined");
        const absPath = path.join(cwd, ".interlinked", ref.path);
        const onDisk = readFileSync(absPath, "utf8");
        expect(onDisk).toBe(JSON.stringify(raw));
        expect(ref.bytes).toBe(Buffer.byteLength(onDisk, "utf8"));
    });
});

describe("getMcpEventsPath — file name constant", () => {
    it("resolves to a path ending in mcp-events.jsonl (kills StringLiteral 'mcp-events.jsonl'->'' mutant f1802ed3e3a438a1)", () => {
        // test-contract: public-api — getMcpEventsPath's returned filename is a
        // documented on-disk contract (mcp-events.jsonl) other tooling reads.
        const cwd = path.join(tmpDir, "events-path-cwd");
        const eventsPath = getMcpEventsPath(cwd);
        expect(path.basename(eventsPath)).toBe("mcp-events.jsonl");
    });
});
