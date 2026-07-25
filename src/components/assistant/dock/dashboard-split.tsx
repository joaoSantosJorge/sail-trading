"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessagesSquare, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ContentMinWidthGuard } from "@/components/dashboard/content-min-width-guard";
import { AssistantDockPanel } from "./assistant-dock-panel";
import {
  DOCK_CONTENT_MIN_WIDTH,
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  DOCK_WIDTH_COOKIE,
} from "./dock-constants";
import { useAssistantDock, writeDockCookie } from "./dock-context";

const KEYBOARD_RESIZE_STEP = 16;
/** The w-1 draggable separator, reserved alongside the content floor. */
const DIVIDER_WIDTH = 4;

/**
 * Two-pane split inside the dashboard chrome: page content on the left
 * (its own scroll container), the docked assistant on the right, separated
 * by a draggable divider. The chat pane is a single mounted instance across
 * desktop/collapsed/mobile states — only CSS changes — so in-flight streams
 * survive collapse and breakpoint crossings. Below lg the chat hides behind
 * a floating button that opens it as a full-screen overlay.
 */
export function DashboardSplit({
  initialWidth,
  children,
}: {
  initialWidth: number;
  children: React.ReactNode;
}) {
  const dock = useAssistantDock();
  const { collapsed, mobileOpen, setMobileOpen } = dock;

  const containerRef = useRef<HTMLDivElement>(null);
  // `width` is the user's preferred width — only drags/keyboard write it (and
  // the cookie). The rendered width is re-clamped against the live container
  // so shrinking the window yields space back and re-growing restores it.
  const [width, setWidth] = useState(initialWidth);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    currentWidth: number;
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The dock stays in the flex row up to inFlowMaxWidth (content at its floor);
  // beyond that it overlays the content and can grow to the full container
  // width (a 4px divider sliver is kept on screen as a grab target).
  const inFlowMaxWidth =
    containerWidth != null
      ? Math.max(
          DOCK_MIN_WIDTH,
          containerWidth - DOCK_CONTENT_MIN_WIDTH - DIVIDER_WIDTH
        )
      : DOCK_MAX_WIDTH;
  const maxDockWidth =
    containerWidth != null
      ? Math.max(DOCK_MIN_WIDTH, containerWidth - DIVIDER_WIDTH)
      : DOCK_MAX_WIDTH;
  const effectiveWidth = Math.min(width, maxDockWidth);
  // Past the in-flow limit the dock floats over the content pane.
  const isOverlay = containerWidth != null && effectiveWidth > inFlowMaxWidth;

  const clampWidth = useCallback(
    (value: number) =>
      Math.min(Math.max(value, DOCK_MIN_WIDTH), maxDockWidth),
    [maxDockWidth]
  );

  const commitWidth = useCallback((value: number) => {
    setWidth(value);
    writeDockCookie(DOCK_WIDTH_COOKIE, String(Math.round(value)));
  }, []);

  // Escape closes the mobile overlay (no Sheet here — the pane is CSS-
  // repositioned rather than portaled so the runtime stays mounted).
  useEffect(() => {
    if (!mobileOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen, setMobileOpen]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      startX: event.clientX,
      startWidth: effectiveWidth,
      currentWidth: effectiveWidth,
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    // Chat sits on the right: dragging the divider left widens it.
    const next = clampWidth(drag.startWidth + drag.startX - event.clientX);
    drag.currentWidth = next;
    setWidth(next);
  }

  function handlePointerEnd() {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    commitWidth(drag.currentWidth);
  }

  function handleSeparatorKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      commitWidth(clampWidth(effectiveWidth + KEYBOARD_RESIZE_STEP));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      commitWidth(clampWidth(effectiveWidth - KEYBOARD_RESIZE_STEP));
    }
  }

  return (
    <div
      ref={containerRef}
      className="relative flex min-h-0 flex-1"
      style={{ "--dock-width": `${effectiveWidth}px` } as React.CSSProperties}
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col overflow-y-auto @container/content",
          // In overlay mode the dock leaves the flow; pin the content at the
          // floor (DOCK_CONTENT_MIN_WIDTH) so it freezes instead of reflowing
          // under the overlay — well above the 360px guard, so no placeholder.
          isOverlay && "lg:w-[480px] lg:max-w-[480px] lg:flex-none"
        )}
      >
        <ContentMinWidthGuard>{children}</ContentMinWidthGuard>
      </div>

      {!collapsed ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat panel"
          aria-valuenow={Math.round(effectiveWidth)}
          aria-valuemin={DOCK_MIN_WIDTH}
          aria-valuemax={Math.round(maxDockWidth)}
          tabIndex={0}
          className={cn(
            "hidden w-1 shrink-0 cursor-col-resize touch-none bg-border/50 outline-none transition-colors hover:bg-border focus-visible:bg-ring lg:block",
            // Overlay: ride the dock's left edge instead of sitting in the row.
            isOverlay &&
              "lg:absolute lg:inset-y-0 lg:right-[var(--dock-width)] lg:z-40"
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onDoubleClick={() => commitWidth(DOCK_DEFAULT_WIDTH)}
          onKeyDown={handleSeparatorKeyDown}
        />
      ) : null}

      {/* Single mounted chat instance; classes reposition it per state. */}
      <div
        className={cn(
          "bg-background",
          mobileOpen ? "fixed inset-0 z-50 flex flex-col" : "hidden",
          collapsed
            ? "lg:hidden"
            : isOverlay
              ? "lg:absolute lg:inset-y-0 lg:right-0 lg:z-30 lg:flex lg:w-[var(--dock-width)] lg:flex-col lg:border-l"
              : "lg:static lg:z-auto lg:flex lg:w-[var(--dock-width)] lg:shrink-0 lg:flex-col lg:border-l"
        )}
      >
        <AssistantDockPanel />
      </div>

      {collapsed ? (
        <div className="hidden w-12 shrink-0 flex-col items-center border-l bg-background py-3 lg:flex">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Expand chat panel"
            onClick={() => dock.setCollapsed(false)}
          >
            <PanelRightOpen className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      {!mobileOpen ? (
        <Button
          size="icon"
          aria-label="Open chat"
          className="fixed bottom-4 right-4 z-40 size-12 rounded-full shadow-lg lg:hidden"
          onClick={() => setMobileOpen(true)}
        >
          <MessagesSquare className="h-5 w-5" />
        </Button>
      ) : null}
    </div>
  );
}
