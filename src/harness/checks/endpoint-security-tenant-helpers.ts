// interlinked-tdd: exempt
// ===========================================
// B3 tenant-filter helpers (extracted from endpoint-security.ts)
// ===========================================
//
// WHERE-clause collection, exempt-table matching, and dynamic-query
// detection for `checkEndpointMissingTenantFilter`. Pure functions over a
// handler-body string; no I/O, no daemon state. Extracted verbatim to
// keep the main detector module under the per-file line cap.

const PRISMA_WHERE_RE = /where\s*:\s*\{([^}]*)\}/g;
const ORM_FILTER_RE = /\.(filter|where)\s*\(\s*([^)]*)\)/g;
const SQL_WHERE_TEXT_RE = /WHERE\s+([^;]+?)(?:;|$|"|'|`|\)|ORDER|GROUP|LIMIT)/i;
const TABLE_REF_RE =
	/(?:prisma|db|sequelize)\.([A-Za-z_][\w]*)\s*\.\s*(?:findMany|findFirst|findUnique|findAll|update|updateMany|delete|deleteMany|create|count)/g;
// SQLAlchemy-ish: db.query(Model).filter(...)
const SQLA_QUERY_RE = /\.\s*query\s*\(\s*([A-Za-z_][\w]*)\s*\)/g;

/** Collect WHERE-style clauses from a handler body. Returns the raw
 * text of each clause; caller checks for tenant-column references. */
export function collectWhereClauses(body: string): string[] {
	const clauses: string[] = [];
	PRISMA_WHERE_RE.lastIndex = 0;
	for (let m = PRISMA_WHERE_RE.exec(body); m !== null; m = PRISMA_WHERE_RE.exec(body)) {
		clauses.push(m[1]);
	}
	ORM_FILTER_RE.lastIndex = 0;
	for (let m = ORM_FILTER_RE.exec(body); m !== null; m = ORM_FILTER_RE.exec(body)) {
		clauses.push(m[2]);
	}
	const sqlMatch = SQL_WHERE_TEXT_RE.exec(body);
	if (sqlMatch) clauses.push(sqlMatch[1]);
	return clauses;
}

/** True if any model reference in the body names an exempt table.
 * Heuristic — checks `prisma.<table>` etc. */
export function referencesExemptTable(body: string, exemptTables: Set<string>): boolean {
	TABLE_REF_RE.lastIndex = 0;
	for (let m = TABLE_REF_RE.exec(body); m !== null; m = TABLE_REF_RE.exec(body)) {
		const table = m[1].toLowerCase();
		// Strip Prisma-style trailing 's' so `prisma.session` matches `sessions`.
		const singular = table.replace(/s$/, "");
		if (exemptTables.has(table) || exemptTables.has(singular) || exemptTables.has(`${table}s`)) {
			return true;
		}
	}
	SQLA_QUERY_RE.lastIndex = 0;
	for (let m = SQLA_QUERY_RE.exec(body); m !== null; m = SQLA_QUERY_RE.exec(body)) {
		const t = m[1].toLowerCase();
		if (exemptTables.has(t) || exemptTables.has(t.replace(/s$/, ""))) return true;
	}
	return false;
}

/** True if the WHERE clause is built dynamically (spread, variable WHERE
 * object, etc.) — conservative bias toward NOT firing. */
export function queryIsDynamic(body: string): boolean {
	return /where\s*:\s*\.\.\./.test(body) || /\bbuildWhere\b/.test(body);
}
