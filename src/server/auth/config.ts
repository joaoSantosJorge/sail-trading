import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe NextAuth config: everything the middleware needs to verify the
 * JWT session cookie — and nothing that touches the database. The full config
 * (DrizzleAdapter + providers) lives in ./index.ts and must never be imported
 * from middleware (the pg driver cannot load in the edge runtime).
 */
export const authConfig = {
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.id = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
