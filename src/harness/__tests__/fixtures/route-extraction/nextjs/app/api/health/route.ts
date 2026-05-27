// Public health endpoint — no auth, no path params.
// interlinked-tdd: exempt — fixture.

export async function GET() {
	return new Response("ok");
}
