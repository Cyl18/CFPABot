import { isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/CodeBlock.tsx";
import { cn } from "@/lib/cn.ts";

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function CodeFrame({ children }: { children?: ReactNode }) {
  const element = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
  const lang = /language-([\w+-]+)/.exec(element?.props.className ?? "")?.[1];
  return <CodeBlock code={nodeText(element?.props.children ?? children).replace(/\n$/, "")} lang={lang} />;
}

export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("md", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: content }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {content}
            </a>
          ),
          pre: ({ children: content }) => <CodeFrame>{content}</CodeFrame>,
        }}
      >
        {children.replaceAll("\u200b", "")}
      </ReactMarkdown>
    </div>
  );
});

export function MarkdownHtml({ html, className }: { html: string; className?: string }) {
  return (
    <div
      className={cn("md", className)}
      dangerouslySetInnerHTML={{ __html: html.replaceAll("\u200b", "").replaceAll("<a ", '<a target="_blank" rel="noreferrer noopener" ') }}
    />
  );
}
