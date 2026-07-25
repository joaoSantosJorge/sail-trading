import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";

export interface VerifiedUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

/**
 * Verifies an email/password pair against the user table. Returns the user on
 * success, or null on any failure (NextAuth's Credentials provider wants null).
 * OAuth-only accounts (no password) can't log in with credentials.
 */
export async function verifyCredentials(
  email: string,
  password: string,
): Promise<VerifiedUser | null> {
  const normalizedEmail = email.toLowerCase().trim();

  const user = await db.query.users.findFirst({
    where: eq(users.email, normalizedEmail),
  });
  if (!user) return null;
  if (!user.hashedPassword) return null;

  const valid = await bcrypt.compare(password, user.hashedPassword);
  if (!valid) return null;

  return { id: user.id, email: user.email, name: user.name, image: user.image };
}
