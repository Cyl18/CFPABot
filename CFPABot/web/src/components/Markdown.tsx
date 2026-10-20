import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn.ts";

export function Markdown({ children, className }: { children: string; className?: string }) {
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
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function MarkdownHtml({ html, className }: { html: string; className?: string }) {
  return (
    <div
      className={cn("md", className)}
      dangerouslySetInnerHTML={{ __html: html.replaceAll("<a ", '<a target="_blank" rel="noreferrer noopener" ') }}
    />
  );
}
