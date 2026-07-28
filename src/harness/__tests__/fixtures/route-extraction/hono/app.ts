// Fixture file for src/harness/route-map/hono.test.ts.
// Realistic Hono app with chained middleware and inline handlers.
// interlinked-tdd: exempt — fixture file consumed verbatim as a string.

declare const Hono: any;
declare const cors: any;

const app = new Hono();

// Public routes
app.get("/health", (c) => c.json({ status: "ok" }));

function listPosts(c: any) {
	return c.json([]);
}
app.get("/posts", listPosts);

// Apply auth middleware to all routes below
app.use(requireAuth);

const getPost = async (c: any) => c.json({ id: c.req.param("id") });
app.get("/posts/:id", getPost);

async function createPost(c: any) {
	return c.json({}, 201);
}
app.post("/posts", createPost);

app.delete("/posts/:id", async (c) => {
	return c.body(null, 204);
});

// Nested admin sub-app
const admin = new Hono();
admin.use(requireAdmin);

function listUsers(c: any) {
	return c.json([]);
}
admin.get("/users", listUsers);

function updateUser(c: any) {
	return c.json({ ok: true });
}
admin.patch("/users/:userId", updateUser);

app.route("/admin", admin);

declare function requireAuth(c: any, next: any): any;
declare function requireAdmin(c: any, next: any): any;

export default app;
