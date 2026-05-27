// Admin route — under middleware matcher.
// interlinked-tdd: exempt — fixture.

export async function GET() {
	return new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } });
}

export async function POST(req: Request) {
	const body = await req.json();
	return new Response(JSON.stringify(body), { status: 201 });
}
