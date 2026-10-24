import { isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn.ts";
import { CopyButton } from "@/ui/CopyButton.tsx";

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const text = nodeText(children).replace(/\n$/, "");
  return (
    <div className="group/code relative">
      <pre>{children}</pre>
      {text !== "" && (
        <CopyButton
          text={text}
          label="复制代码"
          className="absolute right-1.5 top-1.5 bg-surface/90 opacity-0 shadow-[var(--shadow-panel)] backdrop-blur group-hover/code:opacity-100 focus-visible:opacity-100"
        />
      )}
    </div>
  );
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
          pre: ({ children: content }) => <CodeBlock>{content}</CodeBlock>,
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
