// ===========================================
// MCP registrar — protocol recording wrappers
// ===========================================

import { type Command, type OptionValues } from "commander";
import { DEFAULT_MCP_INLINE_LIMIT_BYTES } from "../lib/mcp-recorder/writer.js";

export function registerMcpCommands(program: Command): void {
    const mcp = program
        .command("mcp")
        .description("Record mediated MCP server protocol traffic");

    mcp
        .command("stdio")
        .description("Proxy a stdio MCP server and record JSON-RPC traffic locally")
        .requiredOption("--server <name>", "MCP server name for attribution")
        .option("--cwd <dir>", "Workspace/data directory for Interlinked logs")
        .option("--server-cwd <dir>", "Working directory for the real MCP server command")
        .option("--session <id>", "Optional agent/client session id for correlation")
        .option(
            "--inline-limit <bytes>",
            "Max payload bytes to keep inline before writing a SHA-256 blob",
            String(DEFAULT_MCP_INLINE_LIMIT_BYTES),
        )
        .allowUnknownOption(true)
        .argument("<command>", "Real MCP server command")
        .argument("[args...]", "Arguments for the real MCP server command")
        .action(async (command: string, args: string[], opts: OptionValues) => {
            const { mcpStdioCommand } = await import("../commands/mcp.js");
            await mcpStdioCommand(command, args, {
                server: String(opts.server),
                cwd: typeof opts.cwd === "string" ? opts.cwd : undefined,
                serverCwd: typeof opts.serverCwd === "string" ? opts.serverCwd : undefined,
                session: typeof opts.session === "string" ? opts.session : undefined,
                inlineLimit: typeof opts.inlineLimit === "string" ? opts.inlineLimit : undefined,
            });
        });
}
