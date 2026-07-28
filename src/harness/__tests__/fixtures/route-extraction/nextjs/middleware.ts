// Next.js middleware — protects everything under /api/admin/*.
// interlinked-tdd: exempt — fixture.

declare const NextResponse: any;
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
