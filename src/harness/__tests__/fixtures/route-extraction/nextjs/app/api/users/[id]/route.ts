// Fixture for Next.js App Router file-convention route extraction.
// Path: app/api/users/[id]/route.ts — exposes GET, PATCH, DELETE on /api/users/:id.
// interlinked-tdd: exempt — fixture file consumed verbatim as a string.

declare const NextResponse: any;

async function loadUser(_id: string) {
	return { id: _id };
}

export async function GET(_req: Request, ctx: { params: { id: string } }) {
	const user = await loadUser(ctx.params.id);
	return NextResponse.json(user);
}

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
	const body = await req.json();
	return NextResponse.json({ id: ctx.params.id, ...body });
}

export async function DELETE(_req: Request, _ctx: { params: { id: string } }) {
	return new Response(null, { status: 204 });
}
