import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@/server/db";
import { strategies } from "@/server/db/schema";
import type { StrategyDSL } from "@/server/engine/types";

export const dynamic = "force-dynamic";

export default async function StrategiesPage() {
  const rows = await db.select().from(strategies).orderBy(desc(strategies.createdAt));

  return (
    <main className="flex w-full flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Strategies</h1>
        <Link
          href="/strategies/new"
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        >
          New strategy
        </Link>
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((s) => {
          const dsl = s.dsl as StrategyDSL;
          return (
            <li key={s.id} className="rounded-lg border p-4">
              <Link href={`/strategies/${s.id}`} className="font-medium hover:underline">
                {s.name}
              </Link>
              <p className="text-sm text-muted-foreground">
                {dsl.interval} · {s.source} · {s.createdAt.toISOString().slice(0, 10)}
              </p>
              <p className="mt-1 text-sm">{dsl.description}</p>
            </li>
          );
        })}
        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No strategies yet — create one to backtest it.
          </p>
        )}
      </ul>
    </main>
  );
}
