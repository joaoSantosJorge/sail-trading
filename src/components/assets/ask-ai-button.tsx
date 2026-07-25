"use client";

import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAssistantDockOptional } from "@/components/assistant/dock/dock-context";

export function AskAiButton({ prompt, label = "Ask AI" }: { prompt: string; label?: string }) {
  const dock = useAssistantDockOptional();
  if (!dock) return null;
  return (
    <Button size="sm" variant="outline" onClick={() => dock.sendPrompt(prompt)}>
      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
      {label}
    </Button>
  );
}
