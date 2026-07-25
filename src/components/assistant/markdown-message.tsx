"use client";

import { memo } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { markdownAlignClass } from "./markdown-utils";

// Module-scope map: streamdown memoizes per markdown block, and a fresh map on
// every render would invalidate all blocks on each streaming frame.
// Only destructure known props — streamdown also passes a hast `node` prop
// that must not be spread onto DOM elements.
const components: StreamdownProps["components"] = {
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-lg font-bold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-2 border-b border-border/60 pb-1 text-base font-bold first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-sm font-bold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h4>
  ),
  p: ({ children }) => (
    <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="font-medium underline underline-offset-2 hover:text-primary"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-border/60" />,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  inlineCode: ({ children }) => (
    <code className="bg-muted px-1 py-0.5 text-[0.85em]">{children}</code>
  ),
  code: ({ children, className }) => (
    <code className={className}>{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto border bg-muted p-3 text-xs leading-relaxed">
      {children}
    </pre>
  ),
  // Tables reuse the shadcn primitives so chat tables look exactly like the
  // dashboard ones (the Table wrapper also provides overflow-x scrolling).
  table: ({ children }) => (
    <div className="my-3 border">
      <Table className="text-xs">{children}</Table>
    </div>
  ),
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children, align, style }) => (
    <TableHead className={cn("h-8 text-xs", markdownAlignClass(align, style))}>
      {children}
    </TableHead>
  ),
  td: ({ children, align, style }) => (
    <TableCell
      className={cn("py-1.5 text-xs", markdownAlignClass(align, style))}
    >
      {children}
    </TableCell>
  ),
};

interface MarkdownMessageProps {
  content: string;
  isStreaming?: boolean;
}

/**
 * Renders an assistant reply as a markdown document in the app's design
 * language. Built on streamdown: incomplete markdown from the char-by-char
 * stream reveal is repaired every frame, blocks are memoized, and raw HTML in
 * model output is sanitized.
 */
export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  isStreaming = false,
}: MarkdownMessageProps) {
  return (
    <Streamdown
      className="min-w-0 text-sm leading-relaxed break-words [overflow-wrap:anywhere]"
      components={components}
      controls={false}
      caret="block"
      isAnimating={isStreaming}
    >
      {content}
    </Streamdown>
  );
});
