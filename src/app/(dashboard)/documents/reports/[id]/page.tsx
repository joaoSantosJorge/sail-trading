import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarkdownMessage } from "@/components/assistant/markdown-message";
import { Badge } from "@/components/ui/badge";
import { requireUserPage } from "@/server/auth/guards";
import { db } from "@/server/db";
import { researchReports, tradeProposals } from "@/server/db/schema";
import type { ValidatedProposal } from "@/server/trade/proposals";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUserPage();
  const { id } = await params;
  const [report] = await db
    .select()
    .from(researchReports)
    .where(and(eq(researchReports.id, Number(id)), eq(researchReports.userId, ctx.userId)));
  if (!report) notFound();

  const linkedProposals = await db
    .select()
    .from(tradeProposals)
    .where(and(eq(tradeProposals.reportId, report.id), eq(tradeProposals.userId, ctx.userId)));

  const inputs = report.inputs as { toolCalls?: { name: string }[] } | null;
  const toolNames = [...new Set((inputs?.toolCalls ?? []).map((t) => t.name))];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <div>
        <Link href="/documents" className="text-sm text-muted-foreground hover:underline">
          ← documents
        </Link>
        <h1 className="text-2xl font-semibold">{report.title}</h1>
        <p className="text-sm text-muted-foreground">
          {report.model} · {report.createdAt.toISOString().slice(0, 10)}
          {toolNames.length > 0 && ` · grounded in: ${toolNames.join(", ")}`}
        </p>
      </div>
      <article className="rounded-lg border p-6 text-sm leading-relaxed">
        <MarkdownMessage content={report.reportMd} />
      </article>
      {linkedProposals.length > 0 && (
        <section className="rounded-lg border p-4">
          <h2 className="mb-2 text-sm font-medium">Proposals from this report</h2>
          <ul className="space-y-1">
            {linkedProposals.map((p) => {
              const v = p.proposal as ValidatedProposal;
              return (
                <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
                  <Link href={`/trade/${p.id}`} className="hover:underline">
                    #{p.id} · {v.amountIn} {v.tokenIn.symbol} → {v.tokenOut.symbol} on {v.chainName}
                  </Link>
                  <Badge variant={p.status === "executed" ? "default" : "outline"}>{p.status}</Badge>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
