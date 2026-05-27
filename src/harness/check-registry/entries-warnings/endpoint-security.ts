// Endpoint-security warning entries — Phase B detectors covering the
// high-severity bug classes Ramp's agent-swarm scan surfaced (IDOR,
// missing auth, tenant-isolation gaps, SSRF, mass assignment).
//
// All five fire as `warning` severity in PostToolUse only. Determinism is
// `heuristic` — pattern/shape matching against the handler scope, not
// behavior-verified. Reachability annotation (Phase C), recurrence
// aggregation (Phase D), and property-test scaffolds (Phase E) wrap the
// findings externally.
//
// Wired through `../endpoint-security-adapters.ts` (the registry call-site
// shim) — the detectors themselves live in `../../checks/endpoint-security.ts`
// and take a richer arg list (file, content, endpoints, config[, sanitizers])
// than the standard registry shape. The adapters do per-project memoized
// loading of RouteMap / SecurityConfig / SanitizerRegistry.

import {
	adaptEndpointAuthMissing,
	adaptEndpointIdorShape,
	adaptEndpointMassAssignment,
	adaptEndpointMissingTenantFilter,
	adaptEndpointSsrfShape,
} from "../endpoint-security-adapters.js";
import type { CheckRegistration } from "../types.js";

export const ENDPOINT_SECURITY_ENTRIES: CheckRegistration[] = [
	{
		id: "endpoint_auth_missing",
		phase: "post",
		name: "Endpoint Auth Missing",
		description:
			"Detects HTTP endpoints whose route-extracted auth_chain is empty AND no recognized auth middleware (auth/authn/authorize/requireUser/requireAuth) appears at the router-mount level in the same file. Per-framework predicate covers Express, Hono, Next.js, FastAPI.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			'Add an auth check to this endpoint. Express/Hono: chain a `requireAuth`/`currentUser` middleware before the handler (`app.get("/x", requireAuth, handler)`) or mount it at the router level (`router.use(requireAuth)`). Next.js: cover the path in `middleware.ts` `matcher`. FastAPI: declare `Depends(auth_dependency)` on the handler or route. If the endpoint is genuinely public (health check, OAuth callback, webhook), add its path to `.interlinked/security-config.json#endpoint_auth_missing.exempt_paths` so the check stops firing.',
		fn: adaptEndpointAuthMissing,
		resultsPropName: "endpointAuthMissing",
	},
	{
		id: "endpoint_idor_shape",
		phase: "post",
		name: "Endpoint IDOR Shape",
		description:
			"Detects handlers that read a path param (`:id` / `[id]` / `{id}`) and feed it to a DB-style call (Prisma findUnique/findOne/findById, raw SQL WHERE) without an auth-context identifier (`req.user`, `ctx.user`, `session.user`, `current_user`) on the predicate — the canonical Insecure Direct Object Reference shape.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Scope the query to the authenticated user. Instead of `prisma.user.findUnique({ where: { id: req.params.id } })`, write `prisma.user.findUnique({ where: { id: req.params.id, ownerId: req.user.id } })`. For raw SQL, add an AND predicate against the auth-context column. The current shape lets any authenticated agent read any record by guessing IDs.",
		fn: adaptEndpointIdorShape,
		resultsPropName: "endpointIdorShape",
	},
	{
		id: "endpoint_missing_tenant_filter",
		phase: "post",
		name: "Endpoint Missing Tenant Filter",
		description:
			"Detects DB queries inside a handler scope that filter on a WHERE clause but omit ALL configured tenant columns (defaults: `org_id`, `workspace_id`, `business_id`, `tenant_id`). Covers Prisma `where: {…}`, ORM `.filter()`/`.where()`, raw SQL. Conservative — dynamically built WHEREs are skipped (FP > FN).",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Add a tenant predicate to every query reachable from a multi-tenant endpoint: `where: { ..., org_id: req.user.org_id }` / `.filter(Model.workspace_id == ctx.workspace_id)` / `WHERE ... AND tenant_id = $tenantId`. Centralize the predicate in a query wrapper to make the filter unforgettable. If this table is genuinely global (sessions, platform-wide settings), mark it exempt via `.interlinked/security-config.json#endpoint_missing_tenant_filter.exempt_tables`.",
		fn: adaptEndpointMissingTenantFilter,
		resultsPropName: "endpointMissingTenantFilter",
	},
	{
		id: "endpoint_ssrf_shape",
		phase: "post",
		name: "Endpoint SSRF Shape",
		description:
			"Detects handlers that read a URL-shaped value (param name matches /url|redirect|webhook|callback|target|endpoint/i OR declared schema is `URL`/`HttpUrl`/`AnyUrl`) and pass it to an HTTP client (fetch/axios/request/urllib/httpx/http.client) without an allow-list sanitizer from the `url` bucket of the sanitizer registry — the canonical Server-Side Request Forgery shape.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Validate the URL against an allow-list before fetching. Parse with `new URL(input)`, check `url.host` against a whitelist of permitted hostnames, and reject `127.0.0.1` / `localhost` / RFC1918 / `169.254.169.254` (cloud metadata). Then register your allow-list helper in `.interlinked/sanitizers.json` under the `url` bucket so this check recognizes it. SSRF lets the agent's backend hit internal services it has no business reaching.",
		fn: adaptEndpointSsrfShape,
		resultsPropName: "endpointSsrfShape",
	},
	{
		id: "endpoint_mass_assignment",
		phase: "post",
		name: "Endpoint Mass Assignment",
		description:
			"Detects handlers that spread request body into a model create/update without an explicit allowlist. Hits: `prisma.X.create({ data: req.body })`, `{ ...req.body }`, `Object.assign(target, req.body)`, `db.X.insert(req.body)`, FastAPI `Model(**request.json())`. Negative-context filters: zod `.parse()`/`.safeParse()`, `pick()`, destructure-then-rebuild.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			'Pick allowed fields explicitly: `const { name, email } = req.body; await prisma.user.create({ data: { name, email } })`. Better, validate with a schema first — `const data = UserCreateSchema.parse(req.body)` (zod / valibot / Pydantic with `model_config = {"extra": "forbid"}`). Spreading the whole body lets a caller set `isAdmin: true` / `ownerId: …` / any field the model exposes that you didn\'t intend.',
		fn: adaptEndpointMassAssignment,
		resultsPropName: "endpointMassAssignment",
	},
];
