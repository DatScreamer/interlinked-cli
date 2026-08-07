// ===========================================
// Tests — Endpoint Security Detectors (Phase B pass 1)
// ===========================================
// ≥3 positive + ≥3 negative cases per detector. Each test loads a small
// `Endpoint[]` array (either by calling `extractEndpointsForFile` on a
// fixture string OR by constructing `Endpoint` objects literally) and
// asserts the detector returns the expected `DetectorFinding[]`.
//
// The detector functions are pure — no I/O, no daemon, no harness state.
// That makes these unit tests trivially fast (sub-50ms total).

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkEndpointAuthMissing,
	checkEndpointIdorShape,
	checkEndpointMassAssignment,
	checkEndpointMissingTenantFilter,
	checkEndpointSsrfShape,
	type DetectorFinding,
	runAllEndpointSecurityChecks,
} from "../checks/endpoint-security.js";
import { extractEndpoints as extractExpressEndpoints } from "../route-map/express.js";
import { extractEndpoints as extractFastapiEndpoints } from "../route-map/fastapi.js";
import { extractEndpoints as extractHonoEndpoints } from "../route-map/hono.js";
import { validate as validateSanitizers } from "../sanitizer-registry.js";
import { defaultConfig } from "../security-config.js";
import type { Endpoint } from "../types/session.js";

const FILE = "/tmp/test-handler.ts";
const PY_FILE = "/tmp/test-handler.py";

const SANITIZERS = validateSanitizers({
	sanitizers: {
		url: [
			{
				name: "is-allowed-url",
				kind: "function",
				pattern: "isAllowedUrl",
			},
			{
				name: "url-host-allowlist",
				kind: "regex",
				pattern: "new\\s+URL\\s*\\([^)]*\\)\\s*\\.\\s*host[\\s\\S]{0,200}(?:\\.includes|\\.indexOf|\\.has|===|==)",
			},
		],
	},
});

const CONFIG = defaultConfig();

// ---------- B1: endpoint_auth_missing ----------

describe("checkEndpointAuthMissing (B1)", () => {
	it("fires on an Express endpoint with no auth chain", () => {
		const content = [
			"import express from 'express';",
			"const app = express();",
			"app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointAuthMissing(FILE, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check_id).toBe("endpoint_auth_missing");
		expect(nonNull(findings[0]).endpoint_path).toBe("/api/users/:id");
	});

	it("fires on a Hono endpoint with no auth chain", () => {
		const content = [
			"import { Hono } from 'hono';",
			"const app = new Hono();",
			"app.post('/admin/users', (c) => c.json({ ok: true }));",
		].join("\n");
		const endpoints = extractHonoEndpoints(FILE, content);
		const findings = checkEndpointAuthMissing(FILE, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).endpoint_method).toBe("POST");
	});

	it("fires on a FastAPI endpoint with no Depends() auth", () => {
		const content = [
			"from fastapi import FastAPI",
			"app = FastAPI()",
			"",
			"@app.get('/api/items/{item_id}')",
			"def get_item(item_id: int):",
			"    return {'id': item_id}",
		].join("\n");
		const endpoints = extractFastapiEndpoints(PY_FILE, content);
		const findings = checkEndpointAuthMissing(PY_FILE, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does NOT fire when endpoint has an auth_chain (Express requireAuth middleware)", () => {
		const content = [
			"import express from 'express';",
			"const app = express();",
			"app.use(requireAuth);",
			"app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		// Sanity-check: auth_chain populated by the express adapter
		expect(nonNull(endpoints[0]).auth_chain.length).toBeGreaterThan(0);
		const findings = checkEndpointAuthMissing(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("does NOT fire on exempt /health path", () => {
		const content = [
			"import express from 'express';",
			"const app = express();",
			"app.get('/health', (req, res) => res.json({ status: 'ok' }));",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointAuthMissing(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("does NOT fire on OPTIONS / HEAD methods", () => {
		const literalEndpoints: Endpoint[] = [
			{
				framework: "express",
				method: "OPTIONS",
				path: "/api/users",
				file: FILE,
				line: 3,
				auth_chain: [],
				declared_params: [],
			},
			{
				framework: "express",
				method: "HEAD",
				path: "/api/users",
				file: FILE,
				line: 4,
				auth_chain: [],
				declared_params: [],
			},
		];
		const findings = checkEndpointAuthMissing(FILE, "", literalEndpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("does NOT fire when router-mount auth.use() declared at top-level", () => {
		// Conservative check: the auth-chain extractor already covers this,
		// but pin the behavior. We construct the endpoint literally with a
		// populated auth_chain to assert the detector's contract.
		const literalEndpoints: Endpoint[] = [
			{
				framework: "express",
				method: "GET",
				path: "/api/secure",
				file: FILE,
				line: 5,
				auth_chain: [{ name: "authMiddleware", kind: "middleware" }],
				declared_params: [],
			},
		];
		const findings = checkEndpointAuthMissing(FILE, "", literalEndpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("does NOT fire when the auth middleware is mounted BELOW the route (whole-file scan, not upstream-only)", () => {
		// detectAuthChain (the extractor) only walks lines strictly ABOVE the
		// route, so auth_chain stays empty here. scanForMountLevelAuth is a
		// whole-file scan and must still catch it as the defense-in-depth pass.
		const content = [
			"app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));",
			"app.use(requireAuth);",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		expect(nonNull(endpoints[0]).auth_chain).toEqual([]);
		const findings = checkEndpointAuthMissing(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("still fires when a top-level .use() call names something other than an auth middleware", () => {
		// scanForMountLevelAuth must actually iterate the regex match (not just
		// short-circuit on "no .use() at all") and find the name doesn't match.
		const content = [
			"import express from 'express';",
			"const app = express();",
			"app.use(logger);",
			"app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointAuthMissing(FILE, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
	});

	it("defaults the finding line to 1 when the endpoint has no line number", () => {
		const literalEndpoints: Endpoint[] = [
			{
				framework: "express",
				method: "GET",
				path: "/api/unlined",
				file: FILE,
				line: undefined,
				auth_chain: [],
				declared_params: [],
			},
		];
		const findings = checkEndpointAuthMissing(FILE, "", literalEndpoints, CONFIG);
		expect(findings).toEqual([
			{
				check_id: "endpoint_auth_missing",
				file: FILE,
				line: 1,
				message:
					"Endpoint GET /api/unlined has no recognized auth middleware. Add an auth check (e.g. requireAuth, currentUser) or add the path to .interlinked/security-config.json#endpoint_auth_missing.exempt_paths.",
				endpoint_path: "/api/unlined",
				endpoint_method: "GET",
			},
		]);
	});
});

// ---------- B2: endpoint_idor_shape ----------

describe("checkEndpointIdorShape (B2)", () => {
	it("fires on Express endpoint reading req.params.id and querying DB by it", () => {
		const content = [
			"app.get('/api/orders/:id', async (req, res) => {",
			"  const order = await prisma.order.findUnique({ where: { id: req.params.id } });",
			"  res.json(order);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointIdorShape(FILE, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check_id).toBe("endpoint_idor_shape");
	});

	it("fires on Hono endpoint with c.req.param() flowing to findOne", () => {
		const content = [
			"import { Hono } from 'hono';",
			"const app = new Hono();",
			"app.get('/projects/:projectId', async (c) => {",
			"  const projectId = c.req.param('projectId');",
			"  const proj = await db.projects.findOne({ where: { id: projectId } });",
			"  return c.json(proj);",
			"});",
		].join("\n");
		const endpoints = extractHonoEndpoints(FILE, content);
		const findings = checkEndpointIdorShape(FILE, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
	});

	it("fires on FastAPI endpoint where path param flows directly into find_by_id", () => {
		const content = [
			"@app.get('/items/{item_id}')",
			"def get_item(item_id: int):",
			"    item = Item.find_by_id(item_id)",
			"    return item",
		].join("\n");
		const endpoints = extractFastapiEndpoints(PY_FILE, content);
		const findings = checkEndpointIdorShape(PY_FILE, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does NOT fire when the WHERE clause also references req.user.id", () => {
		const content = [
			"app.get('/api/orders/:id', async (req, res) => {",
			"  const order = await prisma.order.findUnique({",
			"    where: { id: req.params.id, ownerId: req.user.id },",
			"  });",
			"  res.json(order);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointIdorShape(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("does NOT fire when handler reads param but does no DB call", () => {
		const content = [
			"app.get('/api/echo/:id', (req, res) => {",
			"  res.json({ echoed: req.params.id });",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointIdorShape(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("does NOT fire on endpoint with no path params", () => {
		const content = [
			"app.get('/api/orders', async (req, res) => {",
			"  const orders = await prisma.order.findMany({ where: { ownerId: req.user.id } });",
			"  res.json(orders);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointIdorShape(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("does NOT fire when the declared path param is never read in the handler body", () => {
		const content = [
			"app.get('/api/orders/:id', (req, res) => {",
			"  res.json({ ok: true });",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointIdorShape(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("defaults the finding line to 1 when the endpoint has no line number", () => {
		const content = "const order = await prisma.order.findUnique({ where: { id: req.params.id } });";
		const literalEndpoints: Endpoint[] = [
			{
				framework: "express",
				method: "GET",
				path: "/api/orders/:id",
				file: FILE,
				line: undefined,
				auth_chain: [],
				declared_params: [{ name: "id", source: "path" }],
			},
		];
		const findings = checkEndpointIdorShape(FILE, content, literalEndpoints, CONFIG);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(1);
	});
});

// ---------- B3: endpoint_missing_tenant_filter ----------

describe("checkEndpointMissingTenantFilter (B3)", () => {
	it("fires on Prisma findMany missing workspace_id in WHERE", () => {
		const content = [
			"app.get('/api/projects', async (req, res) => {",
			"  const projects = await prisma.project.findMany({ where: { status: 'active' } });",
			"  res.json(projects);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointMissingTenantFilter(FILE, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check_id).toBe("endpoint_missing_tenant_filter");
	});

	it("fires on Hono endpoint with raw SQL WHERE missing org_id", () => {
		const content = [
			"import { Hono } from 'hono';",
			"const app = new Hono();",
			"app.get('/widgets', async (c) => {",
			"  const rows = await db.query('SELECT * FROM widgets WHERE status = ?', ['active']);",
			"  return c.json(rows);",
			"});",
		].join("\n");
		const endpoints = extractHonoEndpoints(FILE, content);
		const findings = checkEndpointMissingTenantFilter(FILE, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
	});

	it("fires on FastAPI handler with SQLAlchemy Query.filter() missing tenant_id", () => {
		const content = [
			"@app.get('/reports')",
			"def list_reports(db: Session = Depends(get_db)):",
			"    rows = db.query(Report).filter(Report.status == 'open').all()",
			"    return rows",
		].join("\n");
		const endpoints = extractFastapiEndpoints(PY_FILE, content);
		const findings = checkEndpointMissingTenantFilter(PY_FILE, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does NOT fire when query includes workspace_id", () => {
		const content = [
			"app.get('/api/projects', async (req, res) => {",
			"  const projects = await prisma.project.findMany({",
			"    where: { workspace_id: req.user.workspaceId, status: 'active' },",
			"  });",
			"  res.json(projects);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointMissingTenantFilter(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("does NOT fire on exempt table (sessions)", () => {
		const content = [
			"app.get('/api/sessions', async (req, res) => {",
			"  const all = await prisma.session.findMany({ where: { active: true } });",
			"  res.json(all);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointMissingTenantFilter(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("does NOT fire when handler has no DB call at all", () => {
		const content = [
			"app.get('/api/ping', (req, res) => {",
			"  res.json({ ok: true });",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointMissingTenantFilter(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("does NOT fire when the query builds its WHERE clause dynamically", () => {
		const content = [
			"app.patch('/api/projects/:id', async (req, res) => {",
			"  const updated = await prisma.project.update({ where: ...buildWhere(req), data: req.body });",
			"  res.json(updated);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointMissingTenantFilter(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("does NOT fire when the DB call has no extractable WHERE clause", () => {
		const content = [
			"app.get('/api/projects', async (req, res) => {",
			"  const projects = await prisma.project.findMany();",
			"  res.json(projects);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointMissingTenantFilter(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("defaults the finding line to 1 when the endpoint has no line number", () => {
		const content =
			"const rows = await prisma.report.findMany({ where: { status: 'open' } });";
		const literalEndpoints: Endpoint[] = [
			{
				framework: "express",
				method: "GET",
				path: "/api/reports",
				file: FILE,
				line: undefined,
				auth_chain: [],
				declared_params: [],
			},
		];
		const findings = checkEndpointMissingTenantFilter(FILE, content, literalEndpoints, CONFIG);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(1);
	});
});

// ---------- B4: endpoint_ssrf_shape ----------

describe("checkEndpointSsrfShape (B4)", () => {
	it("fires when req.body.url flows into fetch() unfiltered", () => {
		const content = [
			"app.post('/api/proxy', async (req, res) => {",
			"  const url = req.body.url;",
			"  const r = await fetch(url);",
			"  res.json(await r.json());",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointSsrfShape(FILE, content, endpoints, CONFIG, SANITIZERS);
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check_id).toBe("endpoint_ssrf_shape");
	});

	it("fires when redirect param flows into axios.get()", () => {
		const content = [
			"app.get('/api/redirect', async (req, res) => {",
			"  const redirect = req.query.redirect;",
			"  const r = await axios.get(redirect);",
			"  res.send(r.data);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointSsrfShape(FILE, content, endpoints, CONFIG, SANITIZERS);
		expect(findings.length).toBeGreaterThan(0);
	});

	it("fires on FastAPI handler with `url` param flowing into httpx.get()", () => {
		const content = [
			"@app.post('/webhook')",
			"def call_webhook(url: str):",
			"    r = httpx.get(url)",
			"    return r.json()",
		].join("\n");
		const endpoints = extractFastapiEndpoints(PY_FILE, content);
		const findings = checkEndpointSsrfShape(PY_FILE, content, endpoints, CONFIG, SANITIZERS);
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does NOT fire when url passes through isAllowedUrl() first", () => {
		const content = [
			"app.post('/api/proxy', async (req, res) => {",
			"  const url = req.body.url;",
			"  if (!isAllowedUrl(url)) return res.status(400).end();",
			"  const r = await fetch(url);",
			"  res.json(await r.json());",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointSsrfShape(FILE, content, endpoints, CONFIG, SANITIZERS);
		expect(findings).toEqual([]);
	});

	it("does NOT fire when url passes through new URL(...).host allowlist check", () => {
		const content = [
			"app.post('/api/proxy', async (req, res) => {",
			"  const url = req.body.url;",
			"  const host = new URL(url).host;",
			"  if (!ALLOWLIST.includes(host)) return res.status(400).end();",
			"  const r = await fetch(url);",
			"  res.json(await r.json());",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointSsrfShape(FILE, content, endpoints, CONFIG, SANITIZERS);
		expect(findings).toEqual([]);
	});

	it("does NOT fire on endpoint with no URL-shaped param", () => {
		const content = [
			"app.post('/api/echo', async (req, res) => {",
			"  const name = req.body.name;",
			"  res.json({ echoed: name });",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointSsrfShape(FILE, content, endpoints, CONFIG, SANITIZERS);
		expect(findings).toEqual([]);
	});

	it("does NOT fire when the endpoint path is on the ssrf exempt_paths list", () => {
		const content = [
			"app.post('/api/proxy', async (req, res) => {",
			"  const url = req.body.url;",
			"  const r = await fetch(url);",
			"  res.json(await r.json());",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const exemptConfig = {
			...CONFIG,
			endpoint_ssrf_shape: { ...CONFIG.endpoint_ssrf_shape, exempt_paths: ["/api/proxy"] },
		};
		const findings = checkEndpointSsrfShape(FILE, content, endpoints, exemptConfig, SANITIZERS);
		expect(findings).toEqual([]);
	});

	it("does NOT fire when a URL-shaped value is read but never passed to an HTTP client", () => {
		const content = [
			"app.post('/api/proxy', async (req, res) => {",
			"  const url = req.body.url;",
			"  res.json({ received: url });",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointSsrfShape(FILE, content, endpoints, CONFIG, SANITIZERS);
		expect(findings).toEqual([]);
	});

	it("collects URL-shaped names from declared params (name match, schema match, non-matches) and defaults the line", () => {
		const content = [
			"app.post('/api/proxy', async (req, res) => {",
			"  const r = await fetch(req.body.target);",
			"  res.json(await r.json());",
			"});",
		].join("\n");
		const literalEndpoints: Endpoint[] = [
			{
				framework: "express",
				method: "POST",
				path: "/api/proxy",
				file: FILE,
				line: undefined,
				auth_chain: [],
				declared_params: [
					{ name: "notes", source: "body" },
					{ name: "webhook", source: "body" },
					{ name: "link", source: "body", schema_name: "HttpUrl" },
					{ name: "count", source: "body", schema_name: "IntSchema" },
				],
			},
		];
		const findings = checkEndpointSsrfShape(FILE, content, literalEndpoints, CONFIG, SANITIZERS);
		expect(findings).toEqual([
			{
				check_id: "endpoint_ssrf_shape",
				file: FILE,
				line: 1,
				message:
					"Endpoint POST /api/proxy reads a URL-shaped value (webhook, link, target) and passes it to an HTTP client without an allow-list check. Validate the URL host against an allow-list before issuing the request.",
				endpoint_path: "/api/proxy",
				endpoint_method: "POST",
			},
		]);
	});

	it("collects URL-shaped names from a Python signature, skipping non-matching and empty arg names", () => {
		const content = [
			"@app.post('/webhook')",
			"def call_hook(webhook_url: str, unrelated: int, : str):",
			"    r = httpx.get(webhook_url)",
			"    return r.json()",
		].join("\n");
		const literalEndpoints: Endpoint[] = [
			{
				framework: "fastapi",
				method: "POST",
				path: "/webhook",
				file: PY_FILE,
				line: 2,
				auth_chain: [],
				declared_params: [],
			},
		];
		const findings = checkEndpointSsrfShape(PY_FILE, content, literalEndpoints, CONFIG, SANITIZERS);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).message).toContain("webhook_url");
		expect(nonNull(findings[0]).message).not.toContain("unrelated");
	});
});

// ---------- B5: endpoint_mass_assignment ----------

describe("checkEndpointMassAssignment (B5)", () => {
	it("fires on Express prisma.user.create({ data: req.body })", () => {
		const content = [
			"app.post('/api/users', async (req, res) => {",
			"  const user = await prisma.user.create({ data: req.body });",
			"  res.json(user);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointMassAssignment(FILE, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check_id).toBe("endpoint_mass_assignment");
	});

	it("fires on Express { ...req.body } as data of update()", () => {
		const content = [
			"app.put('/api/users/:id', async (req, res) => {",
			"  const u = await prisma.user.update({ where: { id: req.params.id }, data: { ...req.body } });",
			"  res.json(u);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointMassAssignment(FILE, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
	});

	it("fires on FastAPI Model(**request.json())", () => {
		const content = [
			"@app.post('/users')",
			"def create_user(payload: dict = Body(...)):",
			"    user = User(**payload)",
			"    db.add(user)",
			"    return user",
		].join("\n");
		const endpoints = extractFastapiEndpoints(PY_FILE, content);
		const findings = checkEndpointMassAssignment(PY_FILE, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does NOT fire when body is run through z.parse() first", () => {
		const content = [
			"app.post('/api/users', async (req, res) => {",
			"  const parsed = userSchema.parse(req.body);",
			"  const user = await prisma.user.create({ data: parsed });",
			"  res.json(user);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointMassAssignment(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("does NOT fire on explicit destructure-then-rebuild", () => {
		const content = [
			"app.post('/api/users', async (req, res) => {",
			"  const { name, email } = req.body;",
			"  const user = await prisma.user.create({ data: { name, email } });",
			"  res.json(user);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointMassAssignment(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("does NOT fire when pick() filters the body fields", () => {
		const content = [
			"app.post('/api/users', async (req, res) => {",
			"  const fields = pick(req.body, ['name', 'email']);",
			"  const user = await prisma.user.create({ data: fields });",
			"  res.json(user);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointMassAssignment(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("still fires when the sanitizer pattern appears AFTER the mass-assignment call", () => {
		const content = [
			"app.post('/api/users', async (req, res) => {",
			"  const user = await prisma.user.create({ data: req.body });",
			"  const parsed = userSchema.parse(req.body);",
			"  res.json(user);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointMassAssignment(FILE, content, endpoints, CONFIG);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).check_id).toBe("endpoint_mass_assignment");
	});

	it("does NOT fire when the sanitizer pattern precedes an actual spread-body shape", () => {
		// Distinct from the z.parse() negative case above (which never matches
		// SPREAD_BODY_RE at all, so it short-circuits earlier at `!hit`): here
		// the body genuinely spreads req.body AND a sanitizer call precedes it.
		const content = [
			"app.post('/api/users', async (req, res) => {",
			"  const parsed = userSchema.parse(req.body);",
			"  const user = await prisma.user.create({ data: req.body });",
			"  res.json(user);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = checkEndpointMassAssignment(FILE, content, endpoints, CONFIG);
		expect(findings).toEqual([]);
	});

	it("defaults the finding line to 1 when the endpoint has no line number", () => {
		const content = "const user = await prisma.user.create({ data: req.body });";
		const literalEndpoints: Endpoint[] = [
			{
				framework: "express",
				method: "POST",
				path: "/api/users",
				file: FILE,
				line: undefined,
				auth_chain: [],
				declared_params: [],
			},
		];
		const findings = checkEndpointMassAssignment(FILE, content, literalEndpoints, CONFIG);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(1);
	});
});

// ---------- Batch helper ----------

describe("runAllEndpointSecurityChecks()", () => {
	it("returns an empty array when handed empty endpoints", () => {
		const findings = runAllEndpointSecurityChecks(FILE, "", [], CONFIG, SANITIZERS);
		expect(findings).toEqual([]);
	});

	it("aggregates findings from multiple detectors on a single fixture", () => {
		const content = [
			"app.post('/api/admin/users/:id', async (req, res) => {",
			"  const found = await prisma.user.findUnique({ where: { id: req.params.id } });",
			"  const updated = await prisma.user.update({",
			"    where: { id: req.params.id },",
			"    data: req.body,",
			"  });",
			"  res.json(updated);",
			"});",
		].join("\n");
		const endpoints = extractExpressEndpoints(FILE, content);
		const findings = runAllEndpointSecurityChecks(FILE, content, endpoints, CONFIG, SANITIZERS);
		// Expect at least auth_missing + idor_shape + mass_assignment to fire.
		const checkIds = new Set(findings.map((f) => f.check_id));
		expect(checkIds.has("endpoint_auth_missing")).toBe(true);
		expect(checkIds.has("endpoint_idor_shape")).toBe(true);
		expect(checkIds.has("endpoint_mass_assignment")).toBe(true);
	});
});

// ---------- Handler-scope boundary (shared getHandlerScope helper) ----------

describe("handler-scope boundary — next-endpoint-line detection", () => {
	it("bounds a handler's scope at the next endpoint in the SAME file, skipping self, same-line siblings, undefined-line entries, and other files", () => {
		const content = [
			"app.post('/a', async (req, res) => {", // line 1
			"  res.send('a');", // line 2
			"});", // line 3
			"", // line 4
			"app.post('/b', async (req, res) => {", // line 5
			"  res.send('b');", // line 6
			"});", // line 7
			"", // line 8
			"", // line 9
			"app.post('/c', async (req, res) => {", // line 10
			"  const user = await prisma.user.create({ data: req.body });", // line 11
			"  res.json(user);", // line 12
			"});", // line 13
		].join("\n");
		const literalEndpoints: Endpoint[] = [
			{
				framework: "express",
				method: "POST",
				path: "/a",
				file: FILE,
				line: 1,
				auth_chain: [],
				declared_params: [],
			},
			{
				// Same line as /a — exercises the "other.line > start" false arm.
				framework: "express",
				method: "POST",
				path: "/a-dup",
				file: FILE,
				line: 1,
				auth_chain: [],
				declared_params: [],
			},
			{
				framework: "express",
				method: "POST",
				path: "/c",
				file: FILE,
				line: 10,
				auth_chain: [],
				declared_params: [],
			},
			{
				// Undefined line — exercises the "other.line === undefined" arm.
				framework: "express",
				method: "POST",
				path: "/no-line",
				file: FILE,
				line: undefined,
				auth_chain: [],
				declared_params: [],
			},
			{
				// Different file — exercises the "other.file !== endpoint.file" arm.
				framework: "express",
				method: "POST",
				path: "/elsewhere",
				file: "/tmp/other-handler.ts",
				line: 5,
				auth_chain: [],
				declared_params: [],
			},
		];
		const findings = checkEndpointMassAssignment(FILE, content, literalEndpoints, CONFIG);
		const paths = findings.map((f) => f.endpoint_path);
		// /a's scope is bounded at line 10 (the next same-file endpoint) so it
		// never sees the mass-assignment shape on line 11.
		expect(paths).not.toContain("/a");
		expect(paths).not.toContain("/a-dup");
		// /c has no later same-file endpoint, so its scope runs to EOF and DOES
		// see the mass-assignment shape.
		expect(paths).toContain("/c");
	});
});

// ---------- Family gate: test/fixture exemption (2026-07 noise review) ----------
//
// The family fired ~57 findings on this repo's own test files and
// route-extraction fixtures — route-shaped code deliberately embedded as
// detector test cases. Test files, fixture trees, and vendored code are not
// deployable endpoints; the shared `isEndpointSecurityExemptFile` gate must
// silence ALL five detectors there while real source stays fully in scope.

describe("endpoint-security family gate — test/fixture exemption", () => {
	// A fixture that trips auth_missing + idor_shape + mass_assignment when
	// it lives in deployable source.
	const VULNERABLE = [
		"app.post('/api/admin/users/:id', async (req, res) => {",
		"  const found = await prisma.user.findUnique({ where: { id: req.params.id } });",
		"  const updated = await prisma.user.update({",
		"    where: { id: req.params.id },",
		"    data: req.body,",
		"  });",
		"  res.json(updated);",
		"});",
	].join("\n");

	function findingsAt(path: string): DetectorFinding[] {
		const endpoints = extractExpressEndpoints(path, VULNERABLE);
		return runAllEndpointSecurityChecks(path, VULNERABLE, endpoints, CONFIG, SANITIZERS);
	}

	// --- must NOT fire (exempt surfaces) ---
	it("does NOT fire on a *.test.ts file embedding a vulnerable route", () => {
		expect(findingsAt("src/routes/users.test.ts")).toEqual([]);
	});

	it("does NOT fire on a route-extraction fixture under __tests__/", () => {
		expect(findingsAt("src/harness/__tests__/fixtures/route-extraction/mcp/server.ts")).toEqual(
			[],
		);
	});

	it("does NOT fire on a __fixtures__/ tree", () => {
		expect(findingsAt("src/routes/__fixtures__/vulnerable-server.ts")).toEqual([]);
	});

	it("does NOT fire on vendored / example trees", () => {
		expect(findingsAt("vendor/express-app/routes.js")).toEqual([]);
		expect(findingsAt("examples/api/users.ts")).toEqual([]);
	});

	// --- must STILL fire (real deployable source) ---
	it("still fires all three findings on ordinary route source", () => {
		const checkIds = new Set(findingsAt("src/routes/users.ts").map((f) => f.check_id));
		expect(checkIds.has("endpoint_auth_missing")).toBe(true);
		expect(checkIds.has("endpoint_idor_shape")).toBe(true);
		expect(checkIds.has("endpoint_mass_assignment")).toBe(true);
	});

	it("still fires on a top-level server file (test-ish substrings don't exempt)", () => {
		expect(findingsAt("src/latest/server.ts").length).toBeGreaterThan(0);
	});

	it("still fires on a FastAPI source module (Python path)", () => {
		const content = [
			"from fastapi import FastAPI",
			"app = FastAPI()",
			"",
			"@app.get('/api/items/{item_id}')",
			"def get_item(item_id: int):",
			"    return {'id': item_id}",
		].join("\n");
		const path = "app/main.py";
		const endpoints = extractFastapiEndpoints(path, content);
		const findings = checkEndpointAuthMissing(path, content, endpoints, CONFIG);
		expect(findings.length).toBeGreaterThan(0);
	});
});
