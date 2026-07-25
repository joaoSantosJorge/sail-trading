import NextAuth from "next-auth";
import { NextResponse } from "next/server";
// Edge-safe config only — the full auth config (DB adapter, pg driver) cannot
// load in the edge runtime.
import { authConfig } from "@/server/auth/config";

const { auth } = NextAuth(authConfig);

const publicPaths = ["/login", "/register", "/api/auth"];
// Streaming routes bypass middleware entirely so the response is never
// wrapped/buffered; they authenticate themselves inside the handler.
const streamingPaths = ["/api/v1/chat/stream"];

export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (streamingPaths.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  if (publicPaths.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // API routes self-authenticate via requireUserApi so unauthenticated calls
  // get a JSON 401 instead of an HTML redirect.
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  if (!req.auth?.user) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const response = NextResponse.next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return response;
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
