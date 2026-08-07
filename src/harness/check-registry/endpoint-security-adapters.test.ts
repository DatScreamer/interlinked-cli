// Tests for the registry-call-site shim that bridges the multi-arg
// endpoint-security detectors to the standard `(content, filePath) →
// InlineMatch[]` registry shape. The detector logic itself is exercised
// in `src/harness/__tests__/endpoint-security.test.ts`; here we just
// verify the adapter wiring (project-root discovery, RouteMap construction,
// config/sanitizer loading, finding → InlineMatch conversion, fail-open).
//
// Each adapter:
//   - Returns [] when the file has no endpoints (cheap exit before
//     loading config / sanitizers).
//   - Returns [] when the file is unparsable or the loaders throw
//     (fail-open — never bricks the pipeline on a stray edit).
//   - Returns InlineMatch[] with `line` + `text` mirroring the detector
//     finding's line + message when the detector fires.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { RouteMap } from "../route-map.js";
import {
	adaptEndpointAuthMissing,
	adaptEndpointIdorShape,
	adaptEndpointMassAssignment,
	adaptEndpointMissingTenantFilter,
	adaptEndpointSsrfShape,
} from "./endpoint-security-adapters.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "interlinked-eps-adapter-"));
	// Mark this directory as a project root so the adapter's findProjectRoot
	// walker terminates here (otherwise it climbs to the real cwd and the
	// per-project cache mixes test runs).
	writeFileSync(join(tmpRoot, "package.json"), JSON.stringify({ name: "fixture" }));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("endpoint-security-adapters: short-circuit on no endpoints", () => {
	it("returns [] when the file has no detected endpoints", () => {
		const file = join(tmpRoot, "plain.ts");
		const content = "export const greet = (name: string) => `Hello ${name}`;";
		writeFileSync(file, content);
		expect(adaptEndpointAuthMissing(content, file)).toEqual([]);
		expect(adaptEndpointIdorShape(content, file)).toEqual([]);
		expect(adaptEndpointMissingTenantFilter(content, file)).toEqual([]);
		expect(adaptEndpointSsrfShape(content, file)).toEqual([]);
		expect(adaptEndpointMassAssignment(content, file)).toEqual([]);
	});
});

describe("endpoint-security-adapters: fail-open on broken input", () => {
	it("returns [] when given a path that doesn't exist on disk", () => {
		// Detector adapters must never throw on a missing file — same
		// fail-open posture as checkExtraneousDependencies when the
		// nearest package.json is broken.
		const file = join(tmpRoot, "nonexistent.ts");
		expect(adaptEndpointAuthMissing("", file)).toEqual([]);
		expect(adaptEndpointIdorShape("", file)).toEqual([]);
		expect(adaptEndpointMissingTenantFilter("", file)).toEqual([]);
		expect(adaptEndpointSsrfShape("", file)).toEqual([]);
		expect(adaptEndpointMassAssignment("", file)).toEqual([]);
	});
});

describe("endpoint-security-adapters: detector fires (positive case)", () => {
	it("auth_missing fires on an Express route with no recognized auth middleware", () => {
		const file = join(tmpRoot, "routes.ts");
		const content = [
			'import express from "express";',
			"const app = express();",
			'app.get("/admin/users", (req, res) => {',
			"  res.json({ ok: true });",
			"});",
		].join("\n");
		writeFileSync(file, content);
		const matches = adaptEndpointAuthMissing(content, file);
		expect(matches.length).toBeGreaterThan(0);
		const m = matches[0];
		expect(typeof nonNull(m).line).toBe("number");
		expect(typeof nonNull(m).text).toBe("string");
		// The detector's message embeds the endpoint method + path, so a
		// minimum subject check is fine without pinning the exact wording.
		expect(nonNull(m).text.toLowerCase()).toContain("auth");
	});

	it("idor_shape fires when path param feeds a DB key with no auth context", () => {
		const file = join(tmpRoot, "users.ts");
		const content = [
			'import express from "express";',
			"const app = express();",
			'app.get("/users/:id", async (req, res) => {',
			"  const user = await prisma.user.findUnique({ where: { id: req.params.id } });",
			"  res.json(user);",
			"});",
		].join("\n");
		writeFileSync(file, content);
		const matches = adaptEndpointIdorShape(content, file);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("missing_tenant_filter fires when a DB query omits every tenant column", () => {
		const file = join(tmpRoot, "projects.ts");
		const content = [
			"app.get('/api/projects', async (req, res) => {",
			"  const projects = await prisma.project.findMany({ where: { status: 'active' } });",
			"  res.json(projects);",
			"});",
		].join("\n");
		writeFileSync(file, content);
		const matches = adaptEndpointMissingTenantFilter(content, file);
		expect(matches.length).toBeGreaterThan(0);
		const m = matches[0];
		expect(typeof nonNull(m).line).toBe("number");
		expect(nonNull(m).text.toLowerCase()).toContain("tenant");
	});

	it("ssrf_shape fires when a request-supplied URL flows into fetch() unchecked", () => {
		const file = join(tmpRoot, "proxy.ts");
		const content = [
			"app.post('/api/proxy', async (req, res) => {",
			"  const url = req.body.url;",
			"  const r = await fetch(url);",
			"  res.json(await r.json());",
			"});",
		].join("\n");
		writeFileSync(file, content);
		const matches = adaptEndpointSsrfShape(content, file);
		expect(matches.length).toBeGreaterThan(0);
		const m = matches[0];
		expect(typeof nonNull(m).line).toBe("number");
		expect(nonNull(m).text.toLowerCase()).toContain("allow-list");
	});

	it("mass_assignment fires when req.body is spread into a create() call", () => {
		const file = join(tmpRoot, "users.ts");
		const content = [
			"app.post('/api/users', async (req, res) => {",
			"  const user = await prisma.user.create({ data: req.body });",
			"  res.json(user);",
			"});",
		].join("\n");
		writeFileSync(file, content);
		const matches = adaptEndpointMassAssignment(content, file);
		expect(matches.length).toBeGreaterThan(0);
		const m = matches[0];
		expect(typeof nonNull(m).line).toBe("number");
		expect(nonNull(m).text.toLowerCase()).toContain("allowlist");
	});
});

describe("endpoint-security-adapters: endpoints exist but the detector reports nothing", () => {
	it("returns [] and skips annotation when endpoints are detected but no finding fires", () => {
		// Endpoint exists (GET /api/ping) but its handler makes no DB call, so
		// tenant-filter has nothing to flag -- exercises applyAnnotations'
		// `findings.length === 0` early-return branch.
		const file = join(tmpRoot, "ping.ts");
		const content = [
			"app.get('/api/ping', (req, res) => {",
			"  res.json({ ok: true });",
			"});",
		].join("\n");
		writeFileSync(file, content);
		expect(adaptEndpointMissingTenantFilter(content, file)).toEqual([]);
	});
});

describe("endpoint-security-adapters: catch-all fail-open on adapter-level throw", () => {
	it("returns [] when RouteMap.extractEndpointsForFile throws mid-pipeline", () => {
		const file = join(tmpRoot, "routes.ts");
		const content = [
			'app.get("/admin/users", (req, res) => {',
			"  res.json({ ok: true });",
			"});",
		].join("\n");
		writeFileSync(file, content);
		const spy = vi
			.spyOn(RouteMap.prototype, "extractEndpointsForFile")
			.mockImplementation(() => {
				throw new Error("route-map extraction blew up");
			});
		try {
			expect(adaptEndpointAuthMissing(content, file)).toEqual([]);
		} finally {
			spy.mockRestore();
		}
	});
});
