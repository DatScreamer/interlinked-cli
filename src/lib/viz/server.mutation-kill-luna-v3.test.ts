import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { contentTypeFor, resolveVizAsset, startVizServer } from "./server.js";

describe("viz server observable contracts", () => {
    // test-contract: invariant — every supported filename suffix maps to its exact advertised media type.
    it("maps supported media types and preserves the no-extension fallback", () => {
        expect(contentTypeFor("icon.svg")).toBe("image/svg+xml");
        expect(contentTypeFor(".json")).toBe("application/json; charset=utf-8");
        expect(contentTypeFor("README")).toBe("application/octet-stream");
        expect(contentTypeFor("name.")).toBe("application/octet-stream");
    });

    // test-contract: public-api — the resolver finds the checked-in dashboard and rejects an absent asset.
    it("resolves dashboard assets", () => {
        expect(resolveVizAsset("index.html")).not.toBeNull();
        expect(resolveVizAsset("missing-viz-asset.invalid")).toBeNull();
    });

    // test-contract: public-api — the index alias returns configured HTML and the documented cache policy.
    it("serves the root and index dashboard routes", async () => {
        const root = mkdtempSync(join(tmpdir(), "viz-server-"));
        const webRoot = join(root, "web");
        mkdirSync(webRoot, { recursive: true });
        writeFileSync(join(root, "entry.ts"), "export const entry = true;\n");
        writeFileSync(join(webRoot, "index.html"), "<html>custom dashboard</html>\n");
        const server = await startVizServer({ root, port: 0, webRoot });
        try {
            for (const route of ["/", "/index.html"]) {
                const response = await fetch(server.url + route);
                expect(response.status).toBe(200);
                expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
                expect(response.headers.get("cache-control")).toBe("no-store");
                expect(await response.text()).toBe("<html>custom dashboard</html>\n");
            }
        } finally {
            await server.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    // test-contract: boundary — missing routes return an exact plain-text 404 response with its declared media type.
    it("returns the exact unknown-route failure", async () => {
        const root = mkdtempSync(join(tmpdir(), "viz-server-"));
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "entry.ts"), "export const entry = true;\n");
        const server = await startVizServer({ root, port: 0 });
        try {
            const response = await fetch(server.url + "/not-a-route");
            expect(response.status).toBe(404);
            expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
            expect(await response.text()).toBe("not found");
        } finally {
            await server.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    // test-contract: boundary — absent dashboard assets produce the exact plain-text error response.
    it("reports a missing configured dashboard asset", async () => {
        const root = mkdtempSync(join(tmpdir(), "viz-server-"));
        const emptyWebRoot = join(root, "empty");
        mkdirSync(emptyWebRoot, { recursive: true });
        writeFileSync(join(root, "entry.ts"), "export const entry = true;\n");
        const server = await startVizServer({ root, port: 0, webRoot: emptyWebRoot });
        try {
            const response = await fetch(server.url + "/");
            expect(response.status).toBe(500);
            expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
            expect(await response.text()).toBe("dashboard asset missing");
        } finally {
            await server.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    // test-contract: invariant — an ephemeral listener reports its actual loopback port and trims trailing separators from the health label.
    it("reports the actual port and normalized root label", async () => {
        const root = mkdtempSync(join(tmpdir(), "viz-server-"));
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "entry.ts"), "export const entry = true;\n");
        const server = await startVizServer({ root: root + "/", port: 0, pollMs: 0 });
        try {
            expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
            expect(server.port).toBeGreaterThan(0);
            const health = await fetch(server.url + "/api/health");
            expect(health.status).toBe(200);
            expect((await health.json()).root).toBe(root.split("/").at(-1));
        } finally {
            await server.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    // test-contract: invariant — graph and health responses expose stable data, cache headers, and one serialized graph body.
    it("caches graph data and reports health", async () => {
        const root = mkdtempSync(join(tmpdir(), "viz-server-"));
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "entry.ts"), "export const entry = true;\n");
        const server = await startVizServer({ root, port: 0 });
        try {
            const firstResponse = await fetch(server.url + "/api/graph");
            expect(firstResponse.status).toBe(200);
            expect(firstResponse.headers.get("cache-control")).toBe("no-store");
            const first = await firstResponse.text();
            // interlinked: defer hardcoded_timeout_in_tests -- asserts the response is CACHED (byte-identical) across two immediately-successive fetches; a fixed short delay is the mutation-kill fixture for the cache path, not a wait-for-condition.
            await new Promise((resolve) => setTimeout(resolve, 5));
            const second = await (await fetch(server.url + "/api/graph")).text();
            expect(second).toBe(first);
            const health = await (await fetch(server.url + "/api/health")).json();
            expect(health.ok).toBe(true);
            expect(health.root).toBe(root.split("/").at(-1));
            expect(health.node_count).toBe(1);
        } finally {
            await server.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    // test-contract: invariant — SSE streams advertise no-cache keep-alive semantics and close cleanly with the server.
    it("closes an active SSE client cleanly", async () => {
        const root = mkdtempSync(join(tmpdir(), "viz-server-"));
        mkdirSync(root, { recursive: true });
        const activity = join(root, "activity.jsonl");
        writeFileSync(join(root, "entry.ts"), "export const entry = true;\n");
        writeFileSync(activity, "");
        const server = await startVizServer({ root, port: 0, activityPath: activity, pollMs: 10 });
        const response = await fetch(server.url + "/api/stream");
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        expect(response.headers.get("cache-control")).toBe("no-cache");
        expect(response.headers.get("connection")).toBe("keep-alive");
        const reader = response.body?.getReader();
        expect(reader).not.toBeUndefined();
        await server.close();
        if (reader) {
            let result = await reader.read();
            for (let index = 0; index < 10 && !result.done; index += 1) {
                result = await reader.read();
            }
            expect(result.done).toBe(true);
        }
        rmSync(root, { recursive: true, force: true });
    });
});
