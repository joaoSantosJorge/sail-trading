import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "./index";

export type UserContext = { userId: string };

/** Session lookup, deduped per request. */
export const getUserContext = cache(async (): Promise<UserContext | null> => {
  const session = await auth();
  const userId = session?.user?.id;
  return userId ? { userId } : null;
});

/** Page guard: redirects to /login when signed out. */
export async function requireUserPage(): Promise<UserContext> {
  const ctx = await getUserContext();
  if (!ctx) redirect("/login");
  return ctx;
}

/**
 * API guard: returns a JSON 401 response when signed out. Callers do
 * `if (ctx instanceof NextResponse) return ctx;`
 */
export async function requireUserApi(): Promise<UserContext | NextResponse> {
  const ctx = await getUserContext();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return ctx;
}
