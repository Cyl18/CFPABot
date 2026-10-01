import { expect, test } from "bun:test";
import { CheckSink } from "./check-comment.ts";
import { Lines } from "./render.ts";

function render(fill: (sink: CheckSink) => void): string {
  const sink = new CheckSink();
  fill(sink);
  const sb = new Lines();
  sink.render(sb);
  return sb.text();
}

test("干净的一组整组进通过", () => {
  const text = render((sink) => {
    sink.startUnit("xaerolib-1.12.2");
    sink.line("✔ `xaerolib` Mod Domain 验证通过。");
    sink.line("ℹ xaerolib-1.12.2 中英文 Key 相互对应。");
    sink.line("ℹ xaerolib-1.12.2 模组内语言文件与 PR 相同。");
    sink.line();
    sink.endUnit();
  });
  expect(text).toBe(
    "<details><summary>✔ 通过 · 1 个模组：xaerolib-1.12.2</summary>\n" +
      "\n" +
      "✔ `xaerolib` Mod Domain 验证通过。\n" +
      "ℹ xaerolib-1.12.2 中英文 Key 相互对应。\n" +
      "ℹ xaerolib-1.12.2 模组内语言文件与 PR 相同。\n" +
      "\n" +
      "</details>\n" +
      "\n",
  );
});

test("有问题的一组整组进警告，内嵌详细报告原样保留", () => {
  const text = render((sink) => {
    sink.startUnit("xaeroworldmap-26.1");
    sink.line("✔ `xaeroworldmap` Mod Domain 验证通过。");
    sink.line("ℹ xaeroworldmap-26.1 中英文 Key 相互对应。");
    sink.line("⚠ PR 中 xaeroworldmap-26.1 英文文件与最新模组 `xaeroworldmap-fabric-26.1.2-1.40.14.jar` 文件不对应。");
    sink.raw("\n<details><summary>详细报告</summary>\n\n");
    sink.line("- 英文有 28 个 Key 多于模组内。");
    sink.raw("\n\n</details>\n");
    sink.line();
    sink.endUnit();
  });
  expect(text).toBe(
    "<details><summary>⚠ 警告 · 1 个模组：xaeroworldmap-26.1</summary>\n" +
      "\n" +
      "✔ `xaeroworldmap` Mod Domain 验证通过。\n" +
      "ℹ xaeroworldmap-26.1 中英文 Key 相互对应。\n" +
      "⚠ PR 中 xaeroworldmap-26.1 英文文件与最新模组 `xaeroworldmap-fabric-26.1.2-1.40.14.jar` 文件不对应。\n" +
      "\n" +
      "<details><summary>详细报告</summary>\n" +
      "\n" +
      "- 英文有 28 个 Key 多于模组内。\n" +
      "\n" +
      "\n" +
      "</details>\n" +
      "\n" +
      "</details>\n" +
      "\n",
  );
});

test("找不到模组的一组整组留在外面", () => {
  const text = render((sink) => {
    sink.startUnit("xaerolib-1.12.2");
    sink.line("⚠ 找不到模组: xaerolib-1.12.2。");
    sink.line("ℹ xaerolib-1.12.2 中英文 Key 相互对应。");
    sink.line();
    sink.endUnit();
  });
  expect(text).toBe("⚠ 找不到模组: xaerolib-1.12.2。\nℹ xaerolib-1.12.2 中英文 Key 相互对应。\n\n");
});

test("有错误的一组进错误", () => {
  const text = render((sink) => {
    sink.startUnit("x-1.16");
    sink.line("❌ 获取 PR 中 x-1.16 英文语言文件失败。");
    sink.endUnit();
  });
  expect(text).toBe("<details><summary>❌ 错误 · 1 个模组：x-1.16</summary>\n\n❌ 获取 PR 中 x-1.16 英文语言文件失败。\n\n</details>\n\n");
});

test("摘要按模组计数，超过三个只列前三个", () => {
  const text = render((sink) => {
    for (const name of ["a-1.16", "b-1.16", "c-1.16", "d-1.16"]) {
      sink.startUnit(name);
      sink.line(`⚠ PR 中 ${name} 中英文 Key 不对应。`);
      sink.line(`ℹ ${name} 模组内语言文件与 PR 相同。`);
      sink.endUnit();
    }
  });
  expect(text.split("\n")[0]).toBe("<details><summary>⚠ 警告 · 4 个模组：a-1.16、b-1.16、c-1.16 等</summary>");
});

test("多组按类分堆，找不到的整组留在外面，译名检测单独折叠在最后", () => {
  const text = render((sink) => {
    sink.startUnit("a-1.16");
    sink.line("✔ `a` Mod Domain 验证通过。");
    sink.line("ℹ a-1.16 中英文 Key 相互对应。");
    sink.line();
    sink.endUnit();
    sink.startUnit("b-1.16");
    sink.line("⚠ 找不到模组: b-1.16。");
    sink.line("ℹ b-1.16 中英文 Key 相互对应。");
    sink.line();
    sink.endUnit();
    sink.startUnit("c-1.16");
    sink.line("⚠ PR 中 c-1.16 英文文件与最新模组 `c.jar` 文件不对应。");
    sink.line();
    sink.endUnit();
    sink.typo("ℹ 可能争议译名：`速度`，提示。例如 `速度`。");
    sink.typo("❌ 可能错误译名：`末地`，提示。例如 `末地`。");
  });
  expect(text).toBe(
    "⚠ 找不到模组: b-1.16。\n" +
      "ℹ b-1.16 中英文 Key 相互对应。\n" +
      "\n" +
      "<details><summary>⚠ 警告 · 1 个模组：c-1.16</summary>\n" +
      "\n" +
      "⚠ PR 中 c-1.16 英文文件与最新模组 `c.jar` 文件不对应。\n" +
      "\n" +
      "</details>\n" +
      "\n" +
      "<details><summary>✔ 通过 · 1 个模组：a-1.16</summary>\n" +
      "\n" +
      "✔ `a` Mod Domain 验证通过。\n" +
      "ℹ a-1.16 中英文 Key 相互对应。\n" +
      "\n" +
      "</details>\n" +
      "\n" +
      "<details><summary>❌ 译名检测 · 2 条（错误 1）</summary>\n" +
      "\n" +
      "ℹ 可能争议译名：`速度`，提示。例如 `速度`。\n" +
      "❌ 可能错误译名：`末地`，提示。例如 `末地`。\n" +
      "\n" +
      "译名检测仅供参考，可能并没有错误。**请在修改前仔细斟酌！**\n" +
      "\n" +
      "</details>\n" +
      "\n",
  );
});

test("渲染只发生一次，出错兜底再渲染不会重复", () => {
  const sink = new CheckSink();
  sink.typo("ℹ 可能争议译名：`速度`。");
  const sb = new Lines();
  sink.render(sb);
  sink.render(sb);
  expect(sb.text().match(/<details>/g)?.length).toBe(1);
});
