import Link from "next/link";
import { cn } from "@/lib/utils";

export type AssetsTab = "tokens" | "macro" | "my-charts";

const TABS: { key: AssetsTab; label: string }[] = [
  { key: "tokens", label: "Tokens" },
  { key: "macro", label: "Macro" },
  { key: "my-charts", label: "My Charts" },
];

/**
 * Link-based tabs (deep-linkable, RSC-friendly): only the active tab's server
 * fetch runs. Class strings mirror the shadcn tabs list, inlined because
 * tabsListVariants lives in a "use client" module a server component can't call.
 */
export function AssetsTabs({ active }: { active: AssetsTab }) {
  return (
    <div className="inline-flex h-8 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={`/assets?tab=${t.key}`}
          className={cn(
            "inline-flex h-[calc(100%-1px)] items-center justify-center rounded-md border border-transparent px-2.5 py-0.5 text-sm font-medium whitespace-nowrap transition-all",
            t.key === active
              ? "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30"
              : "text-foreground/60 hover:text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
