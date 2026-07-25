"use client";

import { Plus, Tag, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Inline tag editor for one history item. Every change PUTs the full tag set
 * (replace semantics) optimistically; on failure the previous set is restored.
 */
export function TagEditor({
  address,
  txKey,
  tags,
  suggestions,
  onChange,
}: {
  address: string;
  txKey: string;
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  async function save(next: string[]) {
    const previous = tags;
    onChange(next); // optimistic
    try {
      const res = await fetch(`/api/v1/wallets/${address}/history/tags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txKey, tags: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { data?: { tags: string[] } };
      if (!res.ok || !body.data) throw new Error("failed to save tags");
      onChange(body.data.tags); // server-normalized
    } catch (err) {
      onChange(previous);
      toast.error(err instanceof Error ? err.message : "failed to save tags");
    }
  }

  function add(tag: string) {
    const trimmed = tag.trim();
    if (!trimmed) return;
    if (tags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) return;
    setDraft("");
    void save([...tags, trimmed]);
  }

  const unusedSuggestions = suggestions
    .filter((s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()))
    .filter((s) => s.toLowerCase().includes(draft.toLowerCase()))
    .slice(0, 6);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Edit tags"
            className="text-muted-foreground hover:text-foreground"
          >
            {tags.length > 0 ? <Tag className="size-3.5" /> : <Plus className="size-3.5" />}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-60 p-2">
        <div className="flex flex-col gap-2">
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                  {tag}
                  <button
                    aria-label={`Remove tag ${tag}`}
                    className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                    onClick={() => void save(tags.filter((t) => t !== tag))}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add(draft);
            }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a tag…"
              maxLength={32}
              className="h-7 text-sm"
            />
          </form>
          {unusedSuggestions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {unusedSuggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => add(s)}
                  className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
