import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRunMcpStdioProxy } = vi.hoisted(() => ({
    mockRunMcpStdioProxy: vi.fn(),
}));

vi.mock("../../lib/mcp-recorder/stdio-proxy.js", () => ({
    runMcpStdioProxy: mockRunMcpStdioProxy,
}));

import { mcpStdioCommand } from "../mcp.js";

describe("mcp stdio command", () => {
    const originalExitCode = process.exitCode;

    beforeEach(() => {
        vi.clearAllMocks();
        process.exitCode = undefined;
        mockRunMcpStdioProxy.mockResolvedValue(0);
    });

    afterEach(() => {
        process.exitCode = originalExitCode;
    });

    it("passes --server-cwd and --inline-limit through to the stdio proxy", async () => {
        await mcpStdioCommand("node", ["server.js"], {
            server: "filesystem",
            cwd: "/tmp/interlinked-workspace",
            serverCwd: "/tmp/mcp-server",
            session: "session-1",
            inlineLimit: "123",
        });

        expect(mockRunMcpStdioProxy).toHaveBeenCalledWith({
            serverName: "filesystem",
            command: "node",
            args: ["server.js"],
            cwd: "/tmp/interlinked-workspace",
            serverCwd: "/tmp/mcp-server",
            sessionId: "session-1",
            inlineLimitBytes: 123,
        });
        expect(process.exitCode).toBe(0);
    });
});
