import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendMcpEvent, captureMcpPayload, getMcpEventsPath } from "./writer.js";
import type { McpEventRecord } from "./types.js";

let tmp: string;

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "interlinked-mcp-writer-"));
});

afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
});

function baseRecord(overrides: Partial<McpEventRecord> = {}): McpEventRecord {
    return {
        schema: "mcp-events.v1",
        kind: "mcp_message",
        ts: "2026-06-18T12:00:00.000Z",
        server_name: "context7",
        transport: "stdio",
        session_id: null,
        message_type: "request",
        payload_bytes: 2,
        payload_sha256: "sha",
        fidelity: {
            source: "mcp_proxy",
            completeness: "complete",
            inline: true,
        },
        privacy: {
            redaction_status: "unscanned",
            sensitivity: "unknown",
            contains_sensitive: "unknown",
            allowed_for_training: false,
            allowed_for_cloud_upload: false,
        },
        ...overrides,
    };
}

describe("MCP recorder writer", () => {
    it("appends mcp-events.v1 records under the configured data dir", () => {
        appendMcpEvent(baseRecord({ method: "tools/list", payload: { ok: true } }), tmp);

        const path = getMcpEventsPath(tmp);
        const line = readFileSync(path, "utf-8").trim();
        const parsed = JSON.parse(line) as McpEventRecord;
        expect(parsed.schema).toBe("mcp-events.v1");
        expect(parsed.method).toBe("tools/list");
        expect(parsed.payload).toEqual({ ok: true });
    });

    it("stores large payloads as SHA-256 blobs while preserving a complete reference", () => {
        const captured = captureMcpPayload(
            { text: "x".repeat(200) },
            { cwd: tmp, inlineLimitBytes: 16 },
        );

        expect(captured.payload).toBeUndefined();
        expect(captured.payload_ref).toBeDefined();
        expect(captured.payload_ref?.kind).toBe("sha256_blob");
        expect(captured.payload_preview).toContain("\"text\"");

        const blobPath = join(tmp, ".interlinked", captured.payload_ref?.path ?? "");
        expect(existsSync(blobPath)).toBe(true);
        expect(readFileSync(blobPath, "utf-8")).toContain("x".repeat(50));
    });
});

