import { and, count, desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  CHART_INDICATOR_NAMES,
  DRAWING_OVERLAY_NAMES,
  type SavedDrawing,
  type SavedIndicator,
} from "@/lib/chart-state";
import { assets, savedCharts } from "@/server/db/schema";
import { isChartInterval } from "@/server/market/types";

// Loose db type so both the node-postgres app db and the PGlite test db fit.
export type ChartsDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const MAX_SAVED_CHARTS = 50;
export const MAX_DRAWINGS = 100;
export const MAX_POINTS_PER_DRAWING = 20;
export const MAX_NAME_LENGTH = 80;
// Generous ceiling on the serialized drawings blob; a real chart is ~1-2 KB.
export const MAX_DRAWINGS_BYTES = 64 * 1024;

const savedDrawingSchema = z.object({
  name: z.enum(DRAWING_OVERLAY_NAMES),
  points: z
    .array(
      z.object({
        timestamp: z.number().finite().optional(),
        value: z.number().finite().optional(),
      }),
    )
    .min(1)
    .max(MAX_POINTS_PER_DRAWING),
  lock: z.boolean().optional(),
  visible: z.boolean().optional(),
});

const savedIndicatorSchema = z.object({ name: z.enum(CHART_INDICATOR_NAMES) });

const drawingsSchema = z
  .array(savedDrawingSchema)
  .max(MAX_DRAWINGS)
  .refine((d) => JSON.stringify(d).length <= MAX_DRAWINGS_BYTES, {
    message: "drawings payload too large",
  });

export const savedChartCreateSchema = z.object({
  assetId: z.number().int().positive(),
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  interval: z.string().refine(isChartInterval, { message: "invalid interval" }),
  drawings: drawingsSchema.default([]),
  indicators: z.array(savedIndicatorSchema).max(CHART_INDICATOR_NAMES.length).default([]),
});

export const savedChartPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
    interval: z.string().refine(isChartInterval, { message: "invalid interval" }),
    drawings: drawingsSchema,
    indicators: z.array(savedIndicatorSchema).max(CHART_INDICATOR_NAMES.length),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

export type SavedChartCreate = z.infer<typeof savedChartCreateSchema>;
export type SavedChartPatch = z.infer<typeof savedChartPatchSchema>;

export type SavedChartListItem = {
  id: number;
  assetId: number;
  symbol: string;
  assetName: string;
  name: string;
  interval: string;
  drawingCount: number;
  indicatorCount: number;
  indicatorNames: string[];
  updatedAt: Date;
};

export async function listSavedCharts(db: ChartsDb, userId: string): Promise<SavedChartListItem[]> {
  const rows = await db
    .select({
      id: savedCharts.id,
      assetId: savedCharts.assetId,
      symbol: assets.symbol,
      assetName: assets.name,
      name: savedCharts.name,
      interval: savedCharts.interval,
      drawings: savedCharts.drawings,
      indicators: savedCharts.indicators,
      updatedAt: savedCharts.updatedAt,
    })
    .from(savedCharts)
    .innerJoin(assets, eq(savedCharts.assetId, assets.id))
    .where(eq(savedCharts.userId, userId))
    .orderBy(desc(savedCharts.updatedAt));
  return rows.map(({ drawings, indicators, ...rest }) => ({
    ...rest,
    drawingCount: drawings.length,
    indicatorCount: indicators.length,
    indicatorNames: indicators.map((i) => i.name),
  }));
}

export type SavedChartRow = typeof savedCharts.$inferSelect;

export async function getSavedChart(
  db: ChartsDb,
  userId: string,
  id: number,
): Promise<SavedChartRow | null> {
  const [row] = await db
    .select()
    .from(savedCharts)
    .where(and(eq(savedCharts.id, id), eq(savedCharts.userId, userId)));
  return row ?? null;
}

/** Creates a chart; returns null when the user is at MAX_SAVED_CHARTS. */
export async function createSavedChart(
  db: ChartsDb,
  userId: string,
  input: SavedChartCreate,
): Promise<SavedChartRow | null> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(savedCharts)
    .where(eq(savedCharts.userId, userId));
  if (n >= MAX_SAVED_CHARTS) return null;
  const [row] = await db
    .insert(savedCharts)
    .values({
      userId,
      assetId: input.assetId,
      name: input.name,
      interval: input.interval,
      drawings: input.drawings as SavedDrawing[],
      indicators: input.indicators as SavedIndicator[],
    })
    .returning();
  return row;
}

export async function updateSavedChart(
  db: ChartsDb,
  userId: string,
  id: number,
  patch: SavedChartPatch,
): Promise<SavedChartRow | null> {
  const [row] = await db
    .update(savedCharts)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.interval !== undefined ? { interval: patch.interval } : {}),
      ...(patch.drawings !== undefined ? { drawings: patch.drawings as SavedDrawing[] } : {}),
      ...(patch.indicators !== undefined
        ? { indicators: patch.indicators as SavedIndicator[] }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(savedCharts.id, id), eq(savedCharts.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteSavedChart(db: ChartsDb, userId: string, id: number): Promise<boolean> {
  const rows = await db
    .delete(savedCharts)
    .where(and(eq(savedCharts.id, id), eq(savedCharts.userId, userId)))
    .returning({ id: savedCharts.id });
  return rows.length > 0;
}
