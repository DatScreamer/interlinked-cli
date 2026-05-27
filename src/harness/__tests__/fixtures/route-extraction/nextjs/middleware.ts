// Next.js middleware — protects everything under /api/admin/*.
// interlinked-tdd: exempt — fixture.

// biome-ignore lint: fixture stubs
declare const NextResponse: any;
// biome-ignore lint: fixture stubs
declare interface NextRequest {
	nextUrl: { pathname: string };
	headers: Headers;
}

export async function middleware(req: NextRequest) {
	if (!req.headers.get("authorization")) {
		return new Response("Unauthorized", { status: 401 });
	}
	return NextResponse.next();
}

export const config = {
	matcher: ["/api/admin/:path*"],
};
