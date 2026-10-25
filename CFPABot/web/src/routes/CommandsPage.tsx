import { COMMANDS, COMMAND_NOTES } from "@cfpa/contracts/commands";
import { Markdown } from "@/components/Markdown.tsx";
import { PageHeader } from "@/components/PageHeader.tsx";
import { Card, CardBody, CardHeader } from "@/ui/Card.tsx";

export function CommandsPage() {
  return (
    <>
      <PageHeader
        title="评论命令"
        description="在 PR 评论中以独立整行发送下列命令，Bot 会在同一 PR 中回复执行结果。"
      />

      <Card className="mb-4">
        <CardHeader title="通用规则" />
        <CardBody>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            {COMMAND_NOTES.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        {COMMANDS.map((command) => (
          <Card key={command.syntax}>
            <CardHeader
              title={<code className="font-mono text-[13px] text-accent">{command.syntax}</code>}
              description={command.args}
            />
            <CardBody className="flex flex-col gap-2">
              <p className="text-sm">{command.summary}</p>
              {command.detail !== undefined && <Markdown className="text-muted">{command.detail}</Markdown>}
              <div className="rounded-md border border-line bg-elevated px-2.5 py-2 font-mono text-xs">
                <span className="text-muted">示例：</span> {command.example}
              </div>
              <p className="text-xs text-muted">权限：{command.permission}</p>
            </CardBody>
          </Card>
        ))}
      </div>
    </>
  );
}
