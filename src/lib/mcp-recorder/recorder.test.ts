import { describe, expect, it } from "vitest";
import { McpProtocolRecorder } from "./recorder.js";
import type { McpEventRecord } from "./types.js";
import type { CollectionRecord } from "../collection/types.js";

function makeRecorder(records: McpEventRecord[], clock: { ms: number }): McpProtocolRecorder {
    return new McpProtocolRecorder({
        serverName: "context7",
        transport: "stdio",
        sessionId: "sess-1",
        now: () => new Date("2026-06-18T12:00:00.000Z"),
        clockMs: () => clock.ms,
        append: (record) => {
            records.push(record);
        },
    });
}

describe("McpProtocolRecorder", () => {
    it("records client requests and server responses with latency correlation", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1000 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine(
            "client_to_server",
            '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
        );
        clock.ms = 1042;
        recorder.recordJsonLine(
            "server_to_client",
            '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
        );

        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({
            kind: "mcp_message",
            direction: "client_to_server",
            stream: "stdin",
            message_type: "request",
            method: "tools/list",
            jsonrpc_id: 1,
            server_name: "context7",
            session_id: "sess-1",
        });
        expect(records[1]).toMatchObject({
            direction: "server_to_client",
            message_type: "response",
            request_method: "tools/list",
            latency_ms: 42,
            jsonrpc_id: 1,
        });
        expect(records[0].privacy.allowed_for_cloud_upload).toBe(false);
        expect(records[0].privacy.allowed_for_training).toBe(false);
    });

    it("dual-writes proxied tools/call requests and responses into collection.jsonl shape", () => {
        const records: McpEventRecord[] = [];
        const collection: CollectionRecord[] = [];
        const clock = { ms: 1000 };
        const recorder = new McpProtocolRecorder({
            serverName: "context7",
            transport: "stdio",
            sessionId: "sess-1",
            now: () => new Date("2026-06-18T12:00:00.000Z"),
            clockMs: () => clock.ms,
            append: (record) => {
                records.push(record);
            },
            appendCollectionRecord: (record) => {
                collection.push(record);
            },
        });

        recorder.recordJsonLine(
            "client_to_server",
            '{"jsonrpc":"2.0","id":"call-1","method":"tools/call","params":{"name":"resolve-library-id","arguments":{"libraryName":"react"}}}',
        );
        clock.ms = 1018;
        recorder.recordJsonLine(
            "server_to_client",
            '{"jsonrpc":"2.0","id":"call-1","result":{"content":[{"type":"text","text":"react docs"}]}}',
        );

        expect(collection).toHaveLength(2);
        expect(collection[0]).toMatchObject({
            schema: "collection.v1",
            provider: "mcp-proxy",
            phase: "pre",
            tool_class: "mcp_call",
            provider_tool: "mcp__context7__resolve-library-id",
            session_id: "sess-1",
            tool_use_id: "mcp:context7:string:call-1",
            action: {
                server: "context7",
                tool: "resolve-library-id",
                params: { libraryName: "react" },
            },
        });
        expect(collection[1]).toMatchObject({
            provider: "mcp-proxy",
            phase: "post",
            outcome: "ok",
            tool_class: "mcp_call",
            observation: {
                result: { content: [{ type: "text", text: "react docs" }] },
                result_ref: null,
            },
        });
        expect(records[1]).toMatchObject({
            request_method: "tools/call",
            latency_ms: 18,
        });
    });

    it("correlates server-initiated client feature requests", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 2000 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine(
            "server_to_client",
            '{"jsonrpc":"2.0","id":"sample-1","method":"sampling/createMessage","params":{"messages":[]}}',
        );
        clock.ms = 2033;
        recorder.recordJsonLine(
            "client_to_server",
            '{"jsonrpc":"2.0","id":"sample-1","result":{"role":"assistant","content":{"type":"text","text":"ok"}}}',
        );

        expect(records[0]).toMatchObject({
            direction: "server_to_client",
            message_type: "request",
            method: "sampling/createMessage",
            jsonrpc_id: "sample-1",
        });
        expect(records[1]).toMatchObject({
            direction: "client_to_server",
            message_type: "response",
            request_method: "sampling/createMessage",
            latency_ms: 33,
        });
    });

    it("records notifications without requiring an id", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine(
            "server_to_client",
            '{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"ready"}}',
        );

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            message_type: "notification",
            method: "notifications/message",
        });
        expect(records[0].jsonrpc_id).toBeUndefined();
    });

    it("records malformed JSON lines as parse-error events", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine("client_to_server", '{"jsonrpc":');

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            kind: "mcp_parse_error",
            direction: "client_to_server",
            message_type: "parse_error",
        });
        expect(records[0].payload).toMatchObject({ line: '{"jsonrpc":' });
    });

    it("splits JSON-RPC batches into per-message records", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine(
            "client_to_server",
            '[{"jsonrpc":"2.0","id":1,"method":"resources/list"},{"jsonrpc":"2.0","method":"notifications/initialized"}]',
        );

        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({
            method: "resources/list",
            batch_index: 0,
            batch_size: 2,
        });
        expect(records[1]).toMatchObject({
            method: "notifications/initialized",
            batch_index: 1,
            batch_size: 2,
        });
    });
});
