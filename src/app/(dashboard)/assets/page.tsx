import { AssetsTabs, type AssetsTab } from "@/components/assets/assets-tabs";
import { MacroGrid } from "@/components/assets/macro-grid";
import { MyChartsList } from "@/components/assets/my-charts-list";
import { TokensTable } from "@/components/assets/tokens-table";
import { requireUserPage } from "@/server/auth/guards";

export const dynamic = "force-dynamic";

const DESCRIPTIONS: Record<AssetsTab, string> = {
  tokens:
    "Most-traded tokens by 24h volume — open one for the full chart with drawing tools, or ask the AI in the chat panel.",
  macro:
    "US macro backdrop: inflation, rates, Fed balance sheet, money supply. FRED data with a keyless DBnomics fallback, 6h cache.",
  "my-charts": "Your saved chart layouts — drawings and indicators restore on open.",
};

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { userId } = await requireUserPage();
  const params = await searchParams;
  const tab: AssetsTab =
    params.tab === "macro" || params.tab === "my-charts" ? params.tab : "tokens";

  return (
    <main className="flex w-full flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Analyse Assets</h1>
        <p className="text-sm text-muted-foreground">{DESCRIPTIONS[tab]}</p>
      </div>
      <AssetsTabs active={tab} />
      {tab === "tokens" && <TokensTable />}
      {tab === "macro" && <MacroGrid />}
      {tab === "my-charts" && <MyChartsList userId={userId} />}
    </main>
  );
}
