// Shared between the server layout (cookie read) and the client sidebar
// (cookie write). Keep this module free of "use client" so the constants
// stay readable from server components — same pattern as
// components/assistant/dock/dock-constants.ts.

export const NAV_OPEN_GROUPS_COOKIE = "nav_open_groups";
export const NAV_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const NAV_GROUP_KEYS = ["documents"] as const;
export type NavGroupKey = (typeof NAV_GROUP_KEYS)[number];

/**
 * Parse the open-groups cookie. Returns null only when the cookie is ABSENT
 * (default behavior: open the group containing the current page); an empty
 * string round-trips to [] — the user deliberately closed every group.
 */
export function parseNavOpenGroups(
  raw: string | undefined
): NavGroupKey[] | null {
  if (raw === undefined) return null;
  return raw
    .split(",")
    .filter((k): k is NavGroupKey =>
      (NAV_GROUP_KEYS as readonly string[]).includes(k)
    );
}
