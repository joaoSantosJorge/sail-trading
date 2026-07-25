import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { requireUserPage } from "@/server/auth/guards";
import { db } from "@/server/db";
import { assets } from "@/server/db/schema";
import { getNews } from "@/server/news/newsCache";

export const dynamic = "force-dynamic";

function timeAgo(iso: Date): string {
  const s = Math.floor((Date.now() - iso.getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function NewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireUserPage();
  const params = await searchParams;
  const currency = params.currency?.toUpperCase();

  const [assetRows, news] = await Promise.all([
    db.select({ symbol: assets.symbol }).from(assets).orderBy(assets.id),
    getNews(db, { currencies: currency ? [currency] : undefined, limit: 40 }),
  ]);

  return (
    <main className="flex w-full flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Market News</h1>
        <p className="text-sm text-muted-foreground">
          Aggregated crypto headlines via CryptoPanic, served from a 10-minute cache.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Link href="/news">
          <Badge variant={currency ? "outline" : "default"}>All</Badge>
        </Link>
        {assetRows.slice(0, 12).map((a) => (
          <Link key={a.symbol} href={`/news?currency=${a.symbol}`}>
            <Badge variant={currency === a.symbol ? "default" : "outline"}>{a.symbol}</Badge>
          </Link>
        ))}
      </div>

      {!news.configured ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          News is not configured yet. Add <code>CRYPTOPANIC_API_KEY</code> to{" "}
          <code>.env.local</code> (free key at cryptopanic.com/developers) and reload.
        </div>
      ) : news.items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No headlines yet{currency ? ` for ${currency}` : ""}.
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {news.items.map((n) => (
            <li key={n.id} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <a
                  href={n.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium hover:underline"
                >
                  {n.title}
                </a>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {n.sourceDomain ?? "unknown source"} · {timeAgo(n.publishedAt)}
                  {n.currencies.length > 0 && ` · ${n.currencies.slice(0, 4).join(", ")}`}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {news.stale && news.configured && (
        <p className="text-xs text-warning-foreground">
          Upstream refresh failed — showing cached headlines.
        </p>
      )}
    </main>
  );
}
