import type { CSSProperties } from "react";

/**
 * Map GFM table alignment (`---:` delimiter rows) to Tailwind classes.
 * Depending on the unified toolchain version the alignment reaches custom
 * components as a legacy `align` prop or as `style.textAlign`, so accept both.
 */
export function markdownAlignClass(
  align?: unknown,
  style?: CSSProperties
): string | undefined {
  const value = align ?? style?.textAlign;
  if (value === "right") return "text-right tabular-nums";
  if (value === "center") return "text-center";
  return undefined;
}
