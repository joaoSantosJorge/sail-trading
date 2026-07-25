import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { z } from "zod";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { authConfig } from "./config";
import { verifyCredentials } from "./verify-credentials";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

// Google is optional — only registered when env creds exist, so local installs
// work with credentials alone.
const googleEnabled = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: DrizzleAdapter(db) as ReturnType<typeof DrizzleAdapter>,
  providers: [
    ...(googleEnabled
      ? [
          Google({
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
          }),
        ]
      : []),
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;
        return verifyCredentials(parsed.data.email, parsed.data.password);
      },
    }),
  ],
  // callbacks come from authConfig (shared with the edge middleware).
  events: {
    async signIn({ user }) {
      if (user.id) {
        await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      }
    },
  },
});

export { googleEnabled };
