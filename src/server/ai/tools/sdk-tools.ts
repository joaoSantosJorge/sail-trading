import { tool, type ToolSet } from "ai";
import { READ_TOOLS, type ReadToolCtx } from "./read-tools";

/**
 * Bridge the read-tool registry into AI SDK v6 tools. The user is bound
 * server-side from the session, never from model input. Tool failures are
 * returned as { error } results (never thrown) so the model can recover, and
 * every call is audited to chat_tool_calls via the sink.
 */

export interface ToolAuditRecord {
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

export type ToolAuditSink = (record: ToolAuditRecord) => void;

export function buildReadTools(ctx: ReadToolCtx, audit: ToolAuditSink): ToolSet {
  const tools: ToolSet = {};
  for (const entry of READ_TOOLS) {
    tools[entry.name] = tool({
      description: entry.description,
      inputSchema: entry.schema,
      execute: async (input) => {
        try {
          const output = await entry.run(ctx, input as never);
          audit({ name: entry.name, input, output });
          return output;
        } catch (err) {
          const message = err instanceof Error ? err.message : "Tool failed";
          audit({ name: entry.name, input, error: message });
          return { error: message };
        }
      },
    });
  }
  return tools;
}
