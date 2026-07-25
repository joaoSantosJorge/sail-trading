// Shared between the server layout (cookie reads) and the client dock
// components (cookie writes, clamping). Keep this module free of "use
// client" so the constants stay readable from server components.

export const DOCK_THREAD_COOKIE = "assistant_dock_thread";
export const DOCK_COLLAPSED_COOKIE = "assistant_dock_collapsed";
export const DOCK_WIDTH_COOKIE = "assistant_dock_width";
export const DOCK_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const DOCK_MIN_WIDTH = 320;
/**
 * Sanity ceiling for the cookie/server clamp only, set above any realistic
 * viewport — at runtime the real limit is the live container width: past the
 * content floor the chat overlays the content pane and can be dragged to full
 * width. A stored value wider than the current screen is harmless — it
 * re-clamps to full width on whatever screen the user reloads on.
 */
export const DOCK_MAX_WIDTH = 8192;
export const DOCK_DEFAULT_WIDTH = 384;
/**
 * Content pane floor. The dock stays in the flex row until it would push the
 * content below this width; past that the content pins here (well above the
 * 22.5rem ContentMinWidthGuard threshold, so the placeholder never shows) and
 * the dock slides over it as an overlay.
 */
export const DOCK_CONTENT_MIN_WIDTH = 480;
