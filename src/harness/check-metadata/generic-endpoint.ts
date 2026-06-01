// Metadata fragment: Phase B endpoint-security pack (2026-05). All five fire as
// PostToolUse warnings (heuristic shape match against the route-extracted
// Endpoint + handler scope). Externality is `local_write` — they fire on
// per-file edits via the standard registry adapter path. Composed into
// GENERIC_CHECK_META in ./generic.ts.

import type { CheckMeta } from "./types.js";

export const GENERIC_ENDPOINT_META: Record<string, CheckMeta> = {
	// === Phase B endpoint-security pack (2026-05) ===
	// All five fire as PostToolUse warnings (heuristic shape match against the
	// route-extracted Endpoint + handler scope). Externality is `local_write`
	// — they fire on per-file edits via the standard registry adapter path.
	endpoint_auth_missing: {
		name: "Endpoint Auth Missing",
		description:
			"Detects HTTP endpoints whose route-extracted auth_chain is empty AND no recognized auth middleware appears at the router-mount level. Covers Express, Hono, Next.js, FastAPI.",
		tier: 1,
		determinism: "heuristic",
		externality: "local_write",
	},
	endpoint_idor_shape: {
		name: "Endpoint IDOR Shape",
		description:
			"Detects handlers that read a path param and feed it to a DB call without an auth-context predicate — the canonical Insecure Direct Object Reference shape.",
		tier: 1,
		determinism: "heuristic",
		externality: "local_write",
	},
	endpoint_missing_tenant_filter: {
		name: "Endpoint Missing Tenant Filter",
		description:
			"Detects DB queries inside a handler scope whose WHERE clause omits all configured tenant columns (org_id, workspace_id, business_id, tenant_id). Conservative — dynamic WHEREs are skipped.",
		tier: 1,
		determinism: "heuristic",
		externality: "local_write",
	},
	endpoint_ssrf_shape: {
		name: "Endpoint SSRF Shape",
		description:
			"Detects handlers that read a URL-shaped value and pass it to an HTTP client without an allow-list sanitizer registered in `.interlinked/sanitizers.json#url`.",
		tier: 1,
		determinism: "heuristic",
		externality: "local_write",
	},
	endpoint_mass_assignment: {
		name: "Endpoint Mass Assignment",
		description:
			"Detects handlers that spread request body into a model create/update without an explicit field allowlist or schema validator (zod / Pydantic / pick).",
		tier: 1,
		determinism: "heuristic",
		externality: "local_write",
	},
};
