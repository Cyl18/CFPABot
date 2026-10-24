#!/usr/bin/env python3
"""按 key 前缀或正则生成范围目录，术语候选只在范围上跑。

用法：
  python3 scope.py <lang 目录> <输出目录> --prefix item. --pattern '^(block|gui)\\.'
"""
import argparse
import json
import re
import sys
from pathlib import Path

LANGS = ("en_us", "zh_cn")


def wanted(key, prefixes, pattern):
    if prefixes and any(key.startswith(prefix) for prefix in prefixes):
        return True
    return pattern is not None and pattern.search(key) is not None


def scope_json(path, prefixes, pattern):
    data = json.loads(path.read_text(encoding="utf-8"))
    return {key: value for key, value in data.items() if wanted(key, prefixes, pattern)}


def scope_lang(path, prefixes, pattern):
    kept = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key = stripped.split("=", 1)[0].strip()
        if wanted(key, prefixes, pattern):
            kept.append(line)
    return "\n".join(kept) + ("\n" if kept else "")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="scope.py", description="按 key 前缀/正则生成范围目录")
    parser.add_argument("lang_dir", type=Path)
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--prefix", action="append", default=[], help="key 前缀，可重复")
    parser.add_argument("--pattern", help="key 正则，re.search 语义")
    args = parser.parse_args(argv)

    if not args.prefix and not args.pattern:
        print("必须先定范围：给 --prefix 或 --pattern。", file=sys.stderr)
        return 2
    try:
        pattern = re.compile(args.pattern) if args.pattern else None
    except re.error as error:
        print(f"正则无效：{error}", file=sys.stderr)
        return 2

    sources = []
    for lang in LANGS:
        for name in (f"{lang}.json", f"{lang}.lang"):
            path = args.lang_dir / name
            if path.is_file():
                sources.append(path)
    if not sources:
        print(f"{args.lang_dir} 下没有 en_us/zh_cn 语言文件。", file=sys.stderr)
        return 2

    args.out_dir.mkdir(parents=True, exist_ok=True)
    summary = {}
    for path in sources:
        try:
            if path.suffix == ".json":
                data = scope_json(path, args.prefix, pattern)
                total = len(json.loads(path.read_text(encoding="utf-8")))
                (args.out_dir / path.name).write_text(
                    json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
                )
                kept = len(data)
            else:
                total = sum(1 for line in path.read_text(encoding="utf-8").splitlines() if "=" in line and not line.strip().startswith("#"))
                text = scope_lang(path, args.prefix, pattern)
                (args.out_dir / path.name).write_text(text, encoding="utf-8")
                kept = sum(1 for line in text.splitlines() if line.strip())
        except (OSError, ValueError) as error:
            print(f"{path} 读取失败：{error}", file=sys.stderr)
            return 1
        summary[path.name] = {"kept": kept, "total": total}

    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
