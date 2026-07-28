// Fixture file for src/harness/route-map/express.test.ts.
// Mimics a realistic Express server with:
//   - public routes (no auth)
//   - protected routes guarded by .use(authMiddleware)
//   - mixed path params (:id, :userId)
//   - chained methods and a stand-alone error handler
//
// This file is intentionally not part of the runtime build; the
// extractor reads its TEXT, not its types, so node-types are stubbed.

// interlinked-tdd: exempt — fixture file consumed verbatim as a string.

declare const express: any;
declare const Router: any;

const app = express();
const adminRouter = Router();

// --- Auth middleware ---
function requireAuth(req: any, _res: any, next: any) {
	if (!req.headers.authorization) return next(new Error("unauthorized"));
	next();
}

function requireAdmin(req: any, _res: any, next: any) {
	if (req.user?.role !== "admin") return next(new Error("forbidden"));
	next();
}

// --- Public routes ---
function healthCheck(_req: any, res: any) {
	res.json({ status: "ok" });
}
app.get("/health", healthCheck);

function listProducts(_req: any, res: any) {
	res.json([]);
}
app.get("/products", listProducts);

// --- Protected user routes ---
app.use(requireAuth);

function getUser(req: any, res: any) {
	res.json({ id: req.params.id });
}
app.get("/users/:id", getUser);

const updateUser = (req: any, res: any) => {
	res.json({ id: req.params.id, updated: true });
};
app.patch("/users/:id", updateUser);

function deleteUser(req: any, res: any) {
	res.status(204).end();
}
app.delete("/users/:id", deleteUser);

// --- Admin router with two-level chain ---
adminRouter.use(requireAdmin);

function listOrgs(_req: any, res: any) {
	res.json([]);
}
adminRouter.get("/orgs", listOrgs);

function createOrg(req: any, res: any) {
	res.status(201).json({ name: req.body.name });
}
adminRouter.post("/orgs", createOrg);

app.use("/admin", adminRouter);

export { app };
