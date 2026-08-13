import { Bot, MessageSquare } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentMessage } from '@/lib/api'

export function SessionStatusBadge({ status }: { status: string }) {
  // 二进制状态:运行中 / 空闲 (archived 会话不会出现在列表中)
  if (status === 'running') {
    return (
      <span className="badge badge-amber">
        运行中
      </span>
    )
  }
  return (
    <span className="badge badge-blue">
      空闲
    </span>
  )
}

function ThinkingBlock({ thinking }: { thinking?: string }) {
  if (!thinking) return null
  return (
    <div className="mb-2">
      <details className="group">
        <summary className="cursor-pointer list-none text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300">
          <span className="inline-flex items-center gap-1">
            <svg className="h-3 w-3 transition-transform group-open:rotate-90" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
            </svg>
            思考过程
          </span>
        </summary>
        <div className="mt-2 rounded-md bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800/50 dark:text-slate-400">
          <pre className="whitespace-pre-wrap break-words font-mono leading-relaxed">{thinking}</pre>
        </div>
      </details>
    </div>
  )
}

function ToolResult({ toolName, content }: { toolName?: string; content: string }) {
  const header = `工具 · ${toolName || 'unknown'}`
  const isLong = content.length > 200

  if (!isLong) {
    return (
      <div className="border-l-2 border-amber-400 pl-3">
        <div className="mb-1 text-xs font-medium text-amber-700 dark:text-amber-400">
          {header}
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs text-slate-600 dark:text-slate-400">
          {content}
        </pre>
      </div>
    )
  }

  return (
    <div className="border-l-2 border-amber-400 pl-3">
      <details className="group">
        <summary className="cursor-pointer list-none">
          <div className="text-xs font-medium text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300">
            {header} <span className="ml-1 text-slate-400 group-open:hidden">(展开)</span>
          </div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-slate-600 dark:text-slate-400">
            {content.slice(0, 200)}…
          </pre>
        </summary>
        <div className="mt-2">
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-slate-600 dark:text-slate-400">
            {content}
          </pre>
        </div>
      </details>
    </div>
  )
}

export function MessageBubble({ message }: { message: AgentMessage }) {
  const { role, content, thinking, toolName } = message

  if (role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="text-xs text-slate-400 dark:text-slate-500">你</span>
        <div className="max-w-[70%] rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2.5 text-sm text-white shadow-sm">
          <p className="whitespace-pre-wrap break-words">{content}</p>
        </div>
      </div>
    )
  }

  if (role === 'tool') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%]">
          <ToolResult toolName={toolName} content={content} />
        </div>
      </div>
    )
  }

  if (role === 'system') {
    return (
      <div className="flex justify-center">
        <p className="max-w-[80%] text-center text-xs italic text-slate-400 dark:text-slate-500">
          {content}
        </p>
      </div>
    )
  }

  // assistant — flat, no bubble
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
        <span className="mb-1 block text-xs text-slate-400 dark:text-slate-500">Agent</span>
        <ThinkingBlock thinking={thinking} />
        <div className="prose prose-sm prose-slate max-w-none dark:prose-invert [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:rounded [&_code]:bg-slate-200/80 [&_code]:px-1 [&_code]:py-0.5 dark:[&_code]:bg-slate-700/80 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-slate-100 [&_pre]:p-3 dark:[&_pre]:bg-slate-700/60 [&_a]:text-indigo-600 [&_a]:underline dark:[&_a]:text-indigo-400 [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:italic dark:[&_blockquote]:border-slate-600 [&_table]:border-collapse [&_th]:border [&_th]:border-slate-300 [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-slate-300 [&_td]:px-2 [&_td]:py-1 dark:[&_th]:border-slate-600 dark:[&_td]:border-slate-600 [&_strong]:font-semibold [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold [&_h1]:mb-2 [&_h2]:mb-2 [&_h3]:mb-1 [&_h4]:mb-1 [&_li]:mb-0.5 [&_hr]:my-2 [&_table]:my-2 [&_blockquote]:my-2 [&_pre]:my-2 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_p]:mt-0 [&_h1]:mt-3 [&_h2]:mt-2 [&_h3]:mt-1.5 [&_h4]:mt-1.5 first:[&_h1]:mt-0 first:[&_h2]:mt-0 first:[&_p]:mt-0">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Override code blocks for Tailwind v3 compatibility
              code({ className, children, ...props }) {
                const isInline = !className
                if (isInline) {
                  return (
                    <code
                      className="rounded bg-slate-100 px-1.5 py-0.5 text-sm text-pink-600 dark:bg-slate-800 dark:text-pink-400"
                      {...props}
                    >
                      {children}
                    </code>
                  )
                }
                return (
                  <pre className="my-2 overflow-x-auto rounded-lg bg-slate-900 p-3 dark:bg-slate-950">
                    <code className="text-sm text-slate-100" {...props}>
                      {children}
                    </code>
                  </pre>
                )
              },
              // Style links
              a({ href, children }) {
                return (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline dark:text-indigo-400">
                    {children}
                  </a>
                )
              },
              // Style tables
              table({ children }) {
                return (
                  <div className="my-2 overflow-x-auto">
                    <table className="min-w-full border-collapse text-sm divide-y divide-slate-200 dark:divide-slate-700">
                      {children}
                    </table>
                  </div>
                )
              },
              th({ children }) {
                return (
                  <th className="bg-slate-50 px-2 py-1 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {children}
                  </th>
                )
              },
              td({ children }) {
                return (
                  <td className="px-2 py-1 text-sm text-slate-600 dark:text-slate-400">
                    {children}
                  </td>
                )
              },
              // Compact horizontal rule
              hr() {
                return <hr className="my-2 border-slate-200 dark:border-slate-700" />
              },
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  )
}

export function StreamingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-slate-400" />
        <div className="flex items-center gap-1">
          <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]" />
        </div>
        <span className="text-xs text-slate-500 dark:text-slate-400">Agent 思考中</span>
      </div>
    </div>
  )
}

export function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center">
        <Bot className="mx-auto h-12 w-12 text-slate-300 dark:text-slate-600" />
        <p className="mt-4 text-sm font-medium text-slate-500 dark:text-slate-400">
          选择左侧会话或创建新对话
        </p>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          在下方输入消息开始与 Agent 聊天
        </p>
      </div>
    </div>
  )
}

export function WelcomeState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center">
        <MessageSquare className="mx-auto h-10 w-10 text-slate-300 dark:text-slate-600" />
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          发送一条消息开始对话
        </p>
      </div>
    </div>
  )
}
