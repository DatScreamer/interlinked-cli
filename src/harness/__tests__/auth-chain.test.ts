// Phase A3 — auth-chain.ts unit tests.
// Per-framework positive + negative cases. The auth-chain module is the
// only place where middleware/Depends/matcher resolution lives, so this
// suite is the source of truth for what counts as "an auth marker".

import { describe, expect, it } from "vitest";

import { detectAuthChain } from "../auth-chain.js";

describe("detectAuthChain — express", () => {
	it("picks up app.use(requireAuth) above the route", () => {
		const content = [
			"const app = express();",
			"app.use(requireAuth);", // line 2
			"app.get('/x', getX);", // line 3
		].join("\n");
		const chain = detectAuthChain("express", "/abs/app.ts", content, 3);
		expect(chain.map((c) => c.name)).toEqual(["requireAuth"]);
		expect(chain[0].kind).toBe("middleware");
		expect(chain[0].line).toBe(2);
	});

	it("recognizes router.use(authn) where the name matches the auth regex", () => {
		const content = ["const router = Router();", "router.use(authn);", "router.get('/y', getY);"].join(
			"\n",
		);
		expect(detectAuthChain("express", "/abs/r.ts", content, 3).map((c) => c.name)).toEqual([
			"authn",
		]);
	});

	it("recognizes requireUser / verifyToken / sessionUser / currentUser", () => {
		const samples = ["requireUser", "verifyToken", "sessionUser", "currentUser", "authorize"];
		for (const ident of samples) {
			const content = `app.use(${ident});\napp.get('/x', getX);`;
			const chain = detectAuthChain("express", "/abs/app.ts", content, 2);
			expect(chain.map((c) => c.name)).toEqual([ident]);
		}
	});

	it("ignores non-auth middleware like logger / cors / json", () => {
		const content = ["app.use(cors());", "app.use(logger);", "app.get('/x', getX);"].join("\n");
		expect(detectAuthChain("express", "/abs/app.ts", content, 3)).toEqual([]);
	});

	it("ignores .use calls AFTER the route line", () => {
		const content = ["app.get('/x', getX);", "app.use(requireAuth);"].join("\n");
		expect(detectAuthChain("express", "/abs/app.ts", content, 1)).toEqual([]);
	});

	it("returns [] when no middleware sits above the route", () => {
		const content = "app.get('/x', getX);";
		expect(detectAuthChain("express", "/abs/app.ts", content, 1)).toEqual([]);
	});
});

describe("detectAuthChain — hono", () => {
	it("recognizes chained .use(authMiddleware) before the route", () => {
		const content = ["const app = new Hono();", "app.use(authMiddleware);", "app.get('/x', h);"].join(
			"\n",
		);
		const chain = detectAuthChain("hono", "/abs/h.ts", content, 3);
		expect(chain.map((c) => c.name)).toEqual(["authMiddleware"]);
	});

	it("recognizes inline app.use('/admin', requireAuth) before a route", () => {
		const content = ["app.use('/admin', requireAuth);", "app.get('/admin/x', h);"].join("\n");
		const chain = detectAuthChain("hono", "/abs/h.ts", content, 2);
		expect(chain.map((c) => c.name)).toEqual(["requireAuth"]);
	});

	it("ignores non-auth middleware in the chain", () => {
		const content = ["app.use(logger);", "app.get('/x', h);"].join("\n");
		expect(detectAuthChain("hono", "/abs/h.ts", content, 2)).toEqual([]);
	});
});

describe("detectAuthChain — fastapi", () => {
	it("picks up Depends(get_current_user) in the handler signature", () => {
		const content = [
			"@app.get('/items/{id}')",
			"async def read_item(id: int, user: User = Depends(get_current_user)):",
			"    return {}",
		].join("\n");
		const chain = detectAuthChain("fastapi", "/abs/main.py", content, 1);
		expect(chain.map((c) => c.name)).toEqual(["get_current_user"]);
		expect(chain[0].kind).toBe("depends");
	});

	it("picks up route-level dependencies=[Depends(requireAuth)]", () => {
		const content = [
			"@app.get('/items', dependencies=[Depends(requireAuth)])",
			"def list_items():",
			"    return []",
		].join("\n");
		expect(detectAuthChain("fastapi", "/abs/m.py", content, 1).map((c) => c.name)).toEqual([
			"requireAuth",
		]);
	});

	it("ignores Depends(get_db) — non-auth dependency", () => {
		const content = [
			"@app.get('/items')",
			"def list_items(db: Session = Depends(get_db)):",
			"    return []",
		].join("\n");
		expect(detectAuthChain("fastapi", "/abs/m.py", content, 1)).toEqual([]);
	});

	it("returns [] when no Depends() appears in the handler", () => {
		const content = "@app.get('/items')\ndef list_items():\n    return []";
		expect(detectAuthChain("fastapi", "/abs/m.py", content, 1)).toEqual([]);
	});
});

describe("detectAuthChain — nextjs", () => {
	it("returns [] when no middleware.ts file is given via the matcher hook", () => {
		expect(detectAuthChain("nextjs", "/abs/route.ts", "export async function GET() {}", 1)).toEqual(
			[],
		);
	});
});
