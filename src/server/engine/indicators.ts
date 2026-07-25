// Pure indicator math lives in src/lib/indicators so client components (chart
// overlays) can import it without pulling server code; the engine re-exports
// it here so all existing imports and golden tests keep working.
export * from "@/lib/indicators";
