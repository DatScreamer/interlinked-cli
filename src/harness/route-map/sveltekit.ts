// ===========================================
// Route-map adapter — SvelteKit
// ===========================================
// SvelteKit uses a file convention identical in shape to Next.js but
// distinct in details:
//   src/routes/<path>/+server.ts exports GET / POST / ... handlers.
// Auth is project-specific (no built-in middleware.ts equivalent), so
// V1 leaves auth_chain empty.

import type { Endpoint } from "../types/session.js";
import {
	conventionPath,
	detectExportedMethods,
	findMethodExportLine,
	hasExportedMethod,
	makeEndpoint,
} from "./shared.js";

const SVELTEKIT_ROUTE_FILE = /[/\\]src[/\\]routes[/\\](.*?)[/\\]\+server\.(?:ts|js)$/;

export function extractEndpoints(filePath: string, content: string): Endpoint[] {
	const match = filePath.match(SVELTEKIT_ROUTE_FILE);
	if (!match) return [];
	const urlPath = conventionPath(match[1]);
	const methods = detectExportedMethods(content);
	if (methods.length === 1 && methods[0] === "ALL" && !hasExportedMethod(content)) {
		return [];
	}
	const endpoints: Endpoint[] = [];
	for (const method of methods) {
		const line = findMethodExportLine(content, method);
		endpoints.push(
			makeEndpoint({
				framework: "sveltekit",
				method,
				path: urlPath,
				file: filePath,
				line,
				handler_symbol: method,
			}),
		);
	}
	return endpoints;
}
