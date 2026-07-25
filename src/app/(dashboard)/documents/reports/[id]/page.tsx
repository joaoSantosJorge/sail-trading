import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarkdownMessage } from "@/components/assistant/markdown-message";
import { requireUserPage } from "@/server/auth/guards";
import { db } from "@/server/db";
import { researchReports } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUserPage();
  const { id } = await params;
  const [report] = await db
    .select()
    .from(researchReports)
    .where(and(eq(researchReports.id, Number(id)), eq(researchReports.userId, ctx.userId)));
  if (!report) notFound();

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
    </main>
  );
}
