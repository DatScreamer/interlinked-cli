// MCP server fixture — exposes a handful of tools via server.tool().
// interlinked-tdd: exempt — fixture file consumed verbatim as a string.

// biome-ignore lint: stub for fixture-only typing
declare const McpServer: any;

const server = new McpServer({ name: "demo", version: "1.0.0" });

server.tool("search_files", { query: "string" }, async (args: any) => {
	return { files: [] };
});

server.tool("read_file", { path: "string" }, async (args: any) => {
	return { content: "" };
});

server.tool("write_file", { path: "string", content: "string" }, async (args: any) => {
	return { ok: true };
});

server.tool("delete_file", { path: "string" }, async (args: any) => {
	return { ok: true };
});

server.tool("list_directory", { path: "string" }, async (args: any) => {
	return { entries: [] };
});

server.tool("get_workspace_info", {}, async () => {
	return { name: "demo" };
});

export { server };
