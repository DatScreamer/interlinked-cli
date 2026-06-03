// ===========================================
// Route-map adapter — MCP server.tool()
// ===========================================
// Not an HTTP framework — MCP servers expose named tools via:
//   server.tool("name", schema, async (args) => { ... })
// We treat each tool as a "TOOL" method endpoint so downstream
// detectors (endpoint-security pack, recurrence aggregation) can apply
// the same shape to MCP servers as to HTTP routes.

import type { Endpoint } from "../types/session.js";
import { isInsideStringLiteral, lineNumberAt, makeEndpoint } from "./shared.js";

const TOOL_RE = /(?:^|[^.\w])([A-Za-z_$][\w$]*)\.tool\s*\(\s*["'`]([^"'`]+)["'`]/gi;
const TOOL_RECEIVER_RE = /(?:server|mcp|app|tools|toolServer)$/i;

export function extractEndpoints(filePath: string, content: string): Endpoint[] {
	const endpoints: Endpoint[] = [];
	const seen = new Set<string>();
	const lines = content.split("\n");
	TOOL_RE.lastIndex = 0;
	for (let m = TOOL_RE.exec(content); m !== null; m = TOOL_RE.exec(content)) {
		const receiver = m[1];
		const toolName = m[2];
		if (receiver === undefined || toolName === undefined) continue;
		if (!TOOL_RECEIVER_RE.test(receiver)) continue;
		const receiverOffset = m.index + (m[0].indexOf(receiver) >= 0 ? m[0].indexOf(receiver) : 0);
		const line = lineNumberAt(content, receiverOffset);
		const lineText = lines[line - 1] ?? "";
		if (/^\s*\/\//.test(lineText)) continue;
		if (isInsideStringLiteral(receiverOffset, content)) continue;
		const key = `TOOL:${toolName}:${line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		endpoints.push(
			makeEndpoint({
				framework: "mcp",
				method: "TOOL",
				path: toolName,
				file: filePath,
				line,
				declared_params: [],
			}),
		);
	}
	return endpoints;
}
