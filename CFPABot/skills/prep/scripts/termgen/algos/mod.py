#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""termgen-v8 —— 从单语文本挖术语，并能产出组合文件。单文件，四个入口。

核心是边界熵 + 最小互信息（新词发现），不依赖中英对照，不假设键的形态。
语言是位置参数，支持 en / zh / ja / ko。

    python <termgen>/final.py mod prep <lang 目录> -o <输出前缀>
    python <termgen>/final.py mod review <lang 目录> -o <输出前缀>
    python <termgen>/final.py mod mine <lang 目录> <语言> [--ref <语言>] --termhood <策略> -o <输出前缀>
    python <termgen>/final.py mod assemble <骨架.json> --terms <填好的.tsv> -o <组合文件.json>

prep（只有 en_us.json，翻译时）出三样：
  1. <前缀>-skeleton.json + <前缀>-terms.tsv   组合骨架 + 待译术语表（给 LLM 填最后一列）
  2. <前缀>-glossary.txt                       一致性词表（词槽 + 固定词/短语）
  3. <前缀>-coverage.md                        覆盖报告（人话：条目数/术语数/组合能盖多少/术语表能碰多少）

review（en_us.json + zh_cn.json，校对时）出一份 <前缀>-divergence.md：
  同一英文的多种译法（精确），以及同一名字骨架下变动词的多种译法（候选，需人核对切分）。

mine（术语挖掘，语言由位置参数给：en / zh / ko / ja）出两样：<前缀>-mine.tsv（术语表）+
<前缀>-mine.md（人看的表）。文件按语言码找（zh -> zh_cn.json），`--ref` 指同一目录里的另一种语言，
用来给中文术语找英文对应。

assemble：读回填好的术语表，把骨架组装成最终组合文件。

术语只从名字型显示名取（判据：不含 . ! ? ; : ,、词数 1~6、过半词首字母大写），键只当对齐提示，
键的分段不约束译文。词槽 = 名字型显示名里同一位置互相替代的词。

mine 反过来，对全部显示名（含长段落）切子句取 n-gram（en 1~5 词、zh/ja 1~8 字、ko 1~5 语节），
凝聚度用最小互信息、边界熵用左右邻接熵，两者的阈值都取候选自身分布的分位数。
`--termhood` 换术语度：self 用候选自身分布的分位数，specificity 用通用英语频率参照（wordfreq，只支持 en），auto 按中位条目长度选。

组合文件语义见 Packer CompositionHelper.cs：entries 里每个 entry 的 parameters 是多个参数对象
的笛卡尔积，第 i 个对象的键/值分别填入键模板/值模板的 {i}，最后按格式化后的键 DistinctBy 去重
（先者优先）。
"""

import argparse
import collections
import itertools
import json
import math
import os
import re
import sys
import time
import unicodedata
from collections import defaultdict

try:
    from wordfreq import zipf_frequency
except Exception:
    zipf_frequency = None


# ---------------------------------------------------------------- Packer 语义


def escape_literal(text):
    """把字面量里的花括号转义，使 string.Format 原样输出。"""
    return text.replace("{", "{{").replace("}", "}}")


def cs_format(template, args):
    """模拟 C# string.Format：{{ }} 为字面花括号，{N} 取第 N 个参数。"""
    out = []
    i = 0
    n = len(template)
    while i < n:
        ch = template[i]
        if ch == "{":
            if i + 1 < n and template[i + 1] == "{":
                out.append("{")
                i += 2
                continue
            j = template.index("}", i)
            idx = int(template[i + 1:j])
            out.append(str(args[idx]))
            i = j + 1
        elif ch == "}":
            if i + 1 < n and template[i + 1] == "}":
                out.append("}")
                i += 2
                continue
            raise ValueError("模板中出现了未转义的 '}'：%r" % template)
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def cross_map(param_objects):
    """复刻 CompositionHelper.CrossMap：多个参数对象做笛卡尔积。"""
    acc = [([], [])]
    for obj in param_objects:
        acc = [(ks + [k], vs + [v]) for ks, vs in acc for k, v in obj.items()]
    return acc


def expand_composition(data, strict=True):
    """展开组合文件为 {键: 值}，键冲突时保留先出现的（与 DistinctBy 一致）。"""
    out = {}
    conflicts = []
    for ei, entry in enumerate(data.get("entries", [])):
        templates = entry.get("templates", {})
        params = entry.get("parameters", [])
        for keys, vals in cross_map(params):
            for tk, tv in templates.items():
                fk = cs_format(tk, keys)
                fv = cs_format(tv, vals)
                if fk in out and out[fk] != fv:
                    conflicts.append((fk, out[fk], fv, ei))
                    if strict:
                        continue
                out.setdefault(fk, fv)
    return out, conflicts


# ------------------------------------------------------------ 语言文件读取


def load_json(path):
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def parse_lang(path):
    """解析 1.12 时代的 key=value 语言文件。"""
    out = {}
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.rstrip("\r\n")
            if not line or line.lstrip().startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out.setdefault(k.strip(), v)
    return out


def load_lang_file(path):
    if path.endswith(".json"):
        return load_json(path)
    return parse_lang(path)


def find_lang_file(lang_dir, lang):
    for ext in (".json", ".lang"):
        p = os.path.join(lang_dir, lang + ext)
        if os.path.exists(p):
            return p
    return None


def read_zh_from_policy(ns_dir):
    """zh_cn.json 缺席时，按 packer-policy.json 合并 base + composition。"""
    policy_path = os.path.join(ns_dir, "packer-policy.json")
    if not os.path.exists(policy_path):
        return None
    repo = ns_dir
    while repo and not os.path.isdir(os.path.join(repo, "projects")):
        parent = os.path.dirname(repo)
        if parent == repo:
            repo = None
            break
        repo = parent
    merged = {}
    for item in load_json(policy_path):
        src = item.get("source", "").replace("/", os.sep)
        for cand in (src, os.path.join(repo, src) if repo else None):
            if cand and os.path.exists(cand):
                src = cand
                break
        else:
            continue
        if item.get("type") == "singleton":
            for k, v in load_json(src).items():
                merged.setdefault(k, v)
        elif item.get("type") == "composition":
            expanded, _ = expand_composition(load_json(src), strict=False)
            for k, v in expanded.items():
                merged.setdefault(k, v)
    return merged or None


def load_lang_dir(lang_dir, zh_file=None):
    en_path = find_lang_file(lang_dir, "en_us")
    if not en_path:
        raise SystemExit("缺少 en_us.json / en_us.lang：%s" % lang_dir)
    en = load_lang_file(en_path)
    if zh_file:
        return en, load_lang_file(zh_file), os.path.abspath(zh_file)
    zh_path = find_lang_file(lang_dir, "zh_cn")
    if zh_path:
        return en, load_lang_file(zh_path), os.path.abspath(zh_path)
    merged = read_zh_from_policy(os.path.dirname(os.path.abspath(lang_dir)))
    if merged:
        return en, merged, "packer-policy 合并（base + composition）"
    return en, {}, None


# ---------------------------------------------------------------- 分组算法


def longest_common_suffix(vals):
    s = vals[0]
    for t in vals[1:]:
        while s and not t.endswith(s):
            s = s[1:]
        if not s:
            break
    return s


SEPARATORS = "._"


def lcp_len(strings):
    if not strings:
        return 0
    n = min(len(s) for s in strings)
    i = 0
    first = strings[0]
    while i < n and all(s[i] == first[i] for s in strings):
        i += 1
    return i


def choose_prefix(prefs):
    """取参数前缀：尽量长，但要落在分隔符后，且严格短于每个前缀。"""
    if not prefs:
        return 0
    limit = min(len(p) for p in prefs)
    cut = lcp_len(prefs)
    while cut >= limit:
        cut -= 1
    while cut > 0 and prefs[0][cut - 1] not in SEPARATORS:
        cut -= 1
    return cut


def candidate_groups(en, zh, max_tail):
    """按 (分隔符, 尾部词) 归组；尾部词取最后 1 段、2 段；zh 传 None 表示不筛译文。"""
    groups = defaultdict(list)
    for key in en:
        if zh is not None and not zh.get(key):
            continue
        cuts = [i for i, ch in enumerate(key) if ch in SEPARATORS][-max_tail:]
        for cut in cuts:
            head = key[cut + 1:]
            if head and cut > 0:
                groups[(key[cut], head)].append(key)
    return groups


def cluster_by_prefix(keys, suffix, min_group):
    """同尾部词但命名空间不同的行分开成组。

    前缀有公共头即视为同组；否则按首段分桶，只拆够大的桶，碎桶合并保留，
    避免为了好看的参数表丢掉覆盖率。
    """
    out = []
    pending = [keys]
    while pending:
        cur = pending.pop()
        if len(cur) < min_group:
            continue
        prefs = [k[:len(k) - len(suffix)] for k in cur]
        if lcp_len(prefs) > 0:
            out.append(cur)
            continue
        buckets = defaultdict(list)
        for k in cur:
            buckets[k.split(".", 1)[0]].append(k)
        if len(buckets) < 2:
            out.append(cur)
            continue
        small = []
        for idx in buckets.values():
            if len(idx) >= min_group:
                pending.append(idx)
            else:
                small.extend(idx)
        if len(small) >= min_group:
            out.append(small)
    return out


def select_entries(raw, min_group=2):
    """贪心：大条目优先，一个键只归一个条目，避免互相吃。"""
    used = set()
    picked = []
    for e in sorted(raw, key=lambda x: (-len(x["keys"]), -len(x["prefix"]))):
        keep = [i for i, k in enumerate(e["keys"]) if k not in used]
        if len(keep) < min_group:
            continue
        used.update(e["keys"][i] for i in keep)
        p = dict(e)
        p["keys"] = [e["keys"][i] for i in keep]
        p["mods"] = [e["mods"][i] for i in keep]
        p["mids"] = [e["mids"][i] for i in keep]
        picked.append(p)
    return picked


# ---------------------------------------------------------------- EN-only 模式
# 只有 en_us.json 时：键负责「谁跟谁成组、组里怎么对齐」，英文显示名负责「哪一段在变」。
# 参数表的键仍取自键（键模板必须按键渲染），术语本身取自显示名，键 token 只是对齐把手。

TERMS_HEADER = ["display", "role", "tokens", "impact", "example", "zh"]
TERM_SPLIT = re.compile(r"[|,;]")
MAX_HEAD_WORDS = 4
MAX_MOD_WORDS = 6


def common_word_prefix(vals):
    ws = [v.split(" ") for v in vals]
    n = min(len(w) for w in ws)
    i = 0
    while i < n and all(w[i] == ws[0][i] for w in ws):
        i += 1
    return i


def common_word_suffix(vals):
    ws = [v.split(" ") for v in vals]
    n = min(len(w) for w in ws)
    i = 0
    while i < n and all(w[-1 - i] == ws[0][-1 - i] for w in ws):
        i += 1
    return i


def split_group_disp(keys, en, min_group):
    """按显示名的公共前缀/后缀切条目：固定段是头部，变化段是修饰词。"""
    entries = []
    pending = [keys]
    while pending:
        cur = pending.pop()
        if len(cur) < min_group:
            continue
        vals = [en[k] for k in cur]
        p = common_word_prefix(vals)
        s = common_word_suffix(vals)
        nmin = min(len(v.split(" ")) for v in vals)
        if p + s >= nmin:
            s = max(0, nmin - p - 1)
        if p + s > 0:
            ws = [v.split(" ") for v in vals]
            mids = [" ".join(w[p:len(w) - s] if s else w[p:]) for w in ws]
            suf = " ".join(ws[0][len(ws[0]) - s:]) if s else ""
            head = suf or " ".join(ws[0][:p])
            keep = [i for i, m in enumerate(mids)
                    if m and len(m.split(" ")) <= MAX_MOD_WORDS]
            if len(head.split(" ")) <= MAX_HEAD_WORDS and len(keep) >= min_group:
                entries.append({"keys": [cur[i] for i in keep],
                                "mids": [mids[i] for i in keep],
                                "pre": " ".join(ws[0][:p]), "suf": suf})
                continue
        buckets = defaultdict(list)
        for i, v in enumerate(vals):
            buckets[v.split(" ")[-1]].append(i)
        for idx in buckets.values():
            if min_group <= len(idx) < len(cur):
                pending.append([cur[i] for i in idx])
    return entries


def collect_entries_en(en, min_group=2, max_tail=2):
    raw = []
    for (sep, head), keys in candidate_groups(en, None, max_tail).items():
        if len(keys) < min_group:
            continue
        suffix = sep + head
        for cluster in cluster_by_prefix(keys, suffix, min_group):
            for e in split_group_disp(cluster, en, min_group):
                prefs = [k[:len(k) - len(suffix)] for k in e["keys"]]
                cut = choose_prefix(prefs)
                e["prefix"] = prefs[0][:cut] if cut else ""
                e["mods"] = [p[cut:] for p in prefs]
                e["head_key"] = head
                e["sep"] = sep
                e["key_tpl"] = (escape_literal(e["prefix"]) + "{0}"
                                + escape_literal(sep) + escape_literal(head))
                raw.append(e)
    return raw


# ---------------------------------------------------------------- 多轴拆分


def _join(tokens):
    return "_".join(tokens)


def _match_len(values, item):
    """item 在 values（前缀反链：任意两个元素互不为前缀）里的最长前缀长度。"""
    for k in range(len(item), 0, -1):
        if item[:k] in values:
            return k
    return 0


def _cost(values, rest, obs):
    """拆一轴的代价 = 本轴取值数 + 剩余取值数 + 笛卡尔积多出来的键数。"""
    return len(values) + len(rest) + len(values) * len(rest) - obs


def _prefix_axis(items):
    """贪心找一个前缀反链当轴（反复把取值换成它的孩子），不划算返回 None。"""
    obs = len(items)
    values = sorted({t[:1] for t in items})
    if len(values) < 2:
        return None
    best = _cost(values, {t[_match_len(values, t):] for t in items}, obs)
    while True:
        cand = None
        for i, v in enumerate(values):
            kids = sorted({t[:len(v) + 1] for t in items
                           if len(t) > len(v) and t[:len(v)] == v})
            if len(kids) < 2:
                continue
            trial = values[:i] + kids + values[i + 1:]
            c = _cost(trial, {t[_match_len(trial, t):] for t in items}, obs)
            if c < (cand[1] if cand else best):
                cand = (trial, c)
        if cand is None:
            break
        values, best = cand
    if best >= obs:
        return None
    return values, {t: t[_match_len(values, t):] for t in items}


def _suffix_axis(items, k):
    """从右边固定切 k 个 token 当轴。"""
    values = sorted({t[-k:] for t in items})
    rest = {t: t[:-k] for t in items}
    return values, rest


def _split(items):
    """一刀二分：返回 (轴在左还是在右, 轴取值, {item: 剩余})；拆不动返回 None。"""
    obs = len(items)
    best = None
    left = _prefix_axis(items)
    if left:
        values, rest = left
        best = (0, values, rest, _cost(values, set(rest.values()), obs))
    for k in range(1, min(len(t) for t in items)):
        values, rest = _suffix_axis(items, k)
        if len(values) < 2:
            continue
        c = _cost(values, set(rest.values()), obs)
        if best is None or c < best[3]:
            best = (1, values, rest, c)
    if best is None or best[3] >= obs:
        return None
    return best[0], best[1], best[2]


def _decompose(items):
    """递归拆轴：返回 (axes, assign)，axes 按字符串顺序排，assign[item] 是各轴取值。"""
    items = sorted(set(items))
    one = ([[_join(t) for t in items]], {_join(t): [_join(t)] for t in items})
    if len(items) < 2:
        return one
    r = _split(items)
    if not r:
        return one
    side, values, rest = r
    vals = [_join(v) for v in values]
    if side == 0:
        sub_axes, sub_assign = _decompose(sorted(set(rest.values())))
        return ([vals] + sub_axes,
                {_join(t): [_join(t[:len(t) - len(rest[t])])] + sub_assign[_join(rest[t])]
                 for t in items})
    k = len(values[0])
    sub_axes, sub_assign = _decompose(sorted({t[:-k] for t in items}))
    return (sub_axes + [vals],
            {_join(t): sub_assign[_join(t[:-k])] + [_join(t[-k:])] for t in items})


def _foldable(items, mids):
    """可有可无的 token：去掉它落回别的取值里，且它的显示名词紧挨着头部词。"""
    out = []
    for x in sorted({t for item in items for t in item}):
        mx = [t for t in items if x in t]
        if not mx or len(mx) == len(items):
            continue
        rest = {t for t in items if x not in t}
        for t in mx:
            t2 = tuple(u for u in t if u != x)
            if t2 not in rest or not mids.get(t, "").startswith(mids.get(t2, "")):
                break
        else:
            out.append(x)
    return out


def decompose(mods, mids=None):
    """拆轴：返回 (axes, assign)；assign[mod] 是各轴取值，可选 token 那一支取值是空串。"""
    items = sorted({tuple(m.split("_")) for m in mods})
    opt = _foldable(items, mids) if mids else []
    if not opt:
        return _decompose(items)
    canon = sorted({tuple(u for u in t if u not in opt) for t in items})
    axes, assign = _decompose(canon)
    out = {}
    for t in items:
        c = tuple(u for u in t if u not in opt)
        out[_join(t)] = list(assign[_join(c)]) + [(x if x in t else "") for x in opt]
    return axes + [[x, ""] for x in opt], out


def align_terms(keys, mids, assign, keep):
    """把显示名的变化段（词串）对齐到各轴，返回 {(轴, 取值): 术语} 和每行剩下的词。"""
    words = {k: (mids[k].split(" ") if mids.get(k) else []) for k in keys}
    out = {}
    for i in keep:
        groups = defaultdict(list)
        for key in keys:
            groups[assign[key][i]].append(key)
        for v, ks in groups.items():
            n = min(len(words[k]) for k in ks)
            j = 0
            while j < n and all(words[k][j] == words[ks[0]][j] for k in ks):
                j += 1
            out[(i, v)] = " ".join(words[ks[0]][:j])
            for k in ks:
                words[k] = words[k][j:]
    return out, words


def find_span(mod, v, pos):
    """在 mod 里 pos 之后找 token 对齐的 v，找不到返回 -1。"""
    i = pos
    while True:
        i = mod.find(v, i)
        if i < 0:
            return -1
        if (i == 0 or mod[i - 1] == "_") and \
                (i + len(v) == len(mod) or mod[i + len(v)] == "_"):
            return i
        i += 1


def mod_template(mod, vals):
    """把 mod 里各轴取值的位置换成槽位，返回 (模板, 最后一个槽位之后的字面量)。"""
    out, pos = [], 0
    for i, v in enumerate(vals):
        j = find_span(mod, v, pos)
        if j < 0:
            return None, None
        out.append(mod[pos:j])
        out.append("{%d}" % i)
        pos = j + len(v)
    return "".join(out), mod[pos:]


def entry_shapes(e, en, zh=None):
    """一条原始条目 → 若干条多槽位条目：形状（可有可无的那段）不同就分开成条目。"""
    keys, mods = e["keys"], e["mods"]
    k2m = dict(zip(keys, mods))
    mids = dict(zip(keys, e["mids"]))
    mof = {tuple(m.split("_")): mids[k] for k, m in zip(keys, mods)}
    axes, assign = decompose(mods, mof)
    assign = {k: assign[m] for k, m in zip(keys, mods)}
    opt = [i for i, vals in enumerate(axes) if "" in vals]
    keep = [i for i in range(len(axes)) if i not in opt]
    terms, left = align_terms(keys, mids, assign, keep)
    shapes = defaultdict(list)
    for key in keys:
        shapes[tuple(assign[key][i] for i in opt)].append(key)
    if any(len({tuple(left[k]) for k in rows}) != 1 for rows in shapes.values()):
        axes = [sorted(set(mods))]
        assign = {k: [m] for k, m in zip(keys, mods)}
        keep, opt = [0], []
        terms, left = align_terms(keys, mids, assign, keep)
        shapes = {(): list(keys)}
    order = value_order(keys, assign, keep, zh, opt) if zh else None
    out = []
    for _, rows in shapes.items():
        body = tail = None
        for key in rows:
            body, tail = mod_template(k2m[key], [assign[key][i] for i in keep])
            if body is not None:
                break
        if body is None:
            return []
        ws = [tuple(left[key]) for key in rows]
        extra = max(set(ws), key=ws.count)
        head = e["suf"] or e["pre"]
        if extra and e["suf"]:
            head = " ".join(extra) + " " + head
        out.append({
            "rows": rows, "terms": terms, "keep": keep, "order": order,
            "prefix": e["prefix"], "sep": e["sep"], "suf": e["suf"],
            "tail": e["head_key"], "assign": assign,
            "body": body, "body_tail": tail,
            "head_disp": head,
            "head_key": (tail + e["sep"] + e["head_key"]).lstrip("._"),
            "axes": [sorted({assign[key][i] for key in rows}) for i in keep],
        })
    return out


def value_order(keys, assign, keep, zh, opt=()):
    """用参考中文定值模板槽位顺序：中文按轴依次剥，能剥干净的那个顺序就是中文语序。"""
    if len(keep) < 2 or not zh or any(not zh.get(k) for k in keys):
        return None
    zs = [zh[k] for k in keys]
    head = longest_common_suffix(zs)
    head = head[:min(len(z) for z in zs) - 1] if head else ""
    rem = {k: zh[k][:-len(head)] if head else zh[k] for k in keys}
    perms = [list(keep)]
    perms += [list(p) for p in itertools.permutations(keep) if list(p) != list(keep)]
    for perm in perms:
        cur = dict(rem)
        for i in perm:
            groups = defaultdict(list)
            for key in keys:
                groups[assign[key][i]].append(key)
            for ks in groups.values():
                n = min(len(cur[k]) for k in ks)
                c = 0
                while c < n and all(cur[k][c] == cur[ks[0]][c] for k in ks):
                    c += 1
                for k in ks:
                    cur[k] = cur[k][c:]
        if not opt:
            if not any(cur.values()):
                return perm
        else:
            tail = defaultdict(set)
            for key in keys:
                tail[tuple(assign[key][i] for i in opt)].add(cur[key])
            if all(len(s) == 1 for s in tail.values()):
                return perm
    return None


def add_term(terms, disp, role, tok, n, example):
    t = terms.setdefault(disp, {"impact": 0, "role": role, "tokens": {},
                                "example": example})
    t["impact"] += n
    t["tokens"][tok] = t["tokens"].get(tok, 0) + n
    if role == "head":
        t["role"] = "head"
    if not t["example"] or len(example) < len(t["example"]):
        t["example"] = example


def shape_entry(s):
    """一条形状 → (键模板, 值模板, 参数表)：参数按轴顺序排，最后一个参数是头部词。"""
    k = len(s["keep"])
    order = s["order"] or list(range(k))
    slots = "".join("{%d}" % i for i in order)
    if s["suf"]:
        val_tpl = slots + escape_literal(" " + s["head_disp"])
    else:
        val_tpl = escape_literal(s["head_disp"] + " ") + slots
    key_tpl = (escape_literal(s["prefix"]) + s["body"]
               + escape_literal(s["body_tail"] + s["sep"] + s["tail"]))
    params = [dict.fromkeys(vals, "") for vals in s["axes"]]
    params.append({s["head_key"]: ""})
    return key_tpl, val_tpl, params


def build_composition_en(en, target, min_group=2, max_tail=2, zh=None):
    raw = collect_entries_en(en, min_group, max_tail)
    picked = select_entries(raw, min_group)
    entries = []
    terms = {}
    for e in picked:
        for s in entry_shapes(e, en, zh):
            key_tpl, val_tpl, params = shape_entry(s)
            entries.append({"templates": {key_tpl: val_tpl},
                            "parameters": params})
            for i, vals in zip(s["keep"], s["axes"]):
                for v in vals:
                    ks = [key for key in s["rows"] if s["assign"][key][i] == v]
                    add_term(terms, s["terms"].get((i, v), v), "mod", v,
                             len(ks), min((en[k] for k in ks), key=len))
            add_term(terms, s["head_disp"], "head", s["head_key"], len(s["rows"]),
                     min((en[k] for k in s["rows"]), key=len))
    data = {"target": target, "entries": entries}
    got, _ = expand_composition(data)
    hit = sum(1 for k in got if k in en)
    stats = {
        "groups": len(raw),
        "selected": len(picked),
        "entries": len(entries),
        "templates": len(entries),
        "params": sum(sum(len(p) for p in e["parameters"]) for e in entries),
        "slots": max((len(e["parameters"]) - 1) for e in entries) if entries else 0,
        "terms": len(terms),
        "generated": len(got),
        "hit_en": hit,
        "extra_key": len(got) - hit,
        "en": len(en),
        "coverage": hit / len(en) * 100 if en else 0.0,
    }
    return data, stats, terms


def write_terms_tsv(path, target, terms, stats, modid):
    lines = ["# EN-only 待译术语表：%s" % modid,
             "# 目标：%s" % target,
             "# 术语 %d 个，覆盖 %d / %d 条键（%.1f%%）"
             % (stats["terms"], stats["hit_en"], stats["en"], stats["coverage"]),
             "# display 是要翻译的重复段（取自英文显示名），tokens 是对齐用键 token。",
             "# 只填最后一列 zh，其余列不要改；填完执行：",
             "#   python <termgen>/final.py mod assemble <骨架.json> --terms 本文件 -o <组合文件.json>",
             "\t".join(TERMS_HEADER)]
    order = sorted(terms.items(), key=lambda kv: (-kv[1]["impact"], kv[0]))
    for disp, t in order:
        toks = "|".join(sorted(t["tokens"], key=lambda k: (-t["tokens"][k], k)))
        ex = t["example"].replace("\t", " ").replace("\n", " ")
        lines.append("\t".join([disp, t["role"], toks, str(t["impact"]), ex, ""]))
    ensure_parent(path)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return len(order)


def read_terms_tsv(path):
    """读回填好的术语表，返回 (token→中文, 显示名→中文, token→显示名)。"""
    rows = []
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.rstrip("\r\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            rows.append(line.split("\t"))
    idx = None
    body = []
    for cells in rows:
        if idx is None and "zh" in [c.strip().lower() for c in cells]:
            idx = {c.strip().lower(): i for i, c in enumerate(cells)}
            continue
        body.append(cells)
    token2zh, disp2zh, tok2disp = {}, {}, {}
    if idx:
        wide = max(idx.values())
        for cells in body:
            if len(cells) <= wide:
                continue
            zh = cells[idx["zh"]].strip()
            disp = cells[idx.get("display", 0)].strip()
            toks = [t.strip() for t in TERM_SPLIT.split(cells[idx["tokens"]])] \
                if "tokens" in idx else []
            toks = [t for t in toks if t]
            for t in toks:
                tok2disp.setdefault(t, disp)
            if not zh:
                continue
            if disp:
                disp2zh[disp] = zh
            for t in toks:
                token2zh.setdefault(t, zh)
            if not toks and disp:
                token2zh[disp] = zh
    else:
        for cells in body:
            if len(cells) < 2:
                continue
            tok, zh = cells[0].strip(), cells[-1].strip()
            if tok and zh:
                token2zh[tok] = zh
                disp2zh[tok] = zh
    return token2zh, disp2zh, tok2disp


def parse_value_slots(tpl):
    """读值模板的槽位顺序，并判断头部词在前还是在后。"""
    order = []
    head_pre = False
    i = 0
    while i < len(tpl):
        if tpl.startswith("{{", i):
            i += 2
            continue
        if tpl[i] == "{":
            j = tpl.index("}", i)
            if not order and tpl[:i].strip():
                head_pre = True
            order.append(int(tpl[i + 1:j]))
            i = j + 1
            continue
        i += 1
    return order, head_pre


def assemble(skeleton, table, drop_missing=True):
    """按术语表把骨架填成最终组合文件：各轴译文按值模板的槽位顺序拼，头部译文接上。"""
    token2zh, _, _ = table
    entries = []
    stats = {"dropped_head": 0, "dropped_mod": 0, "dropped_entry": 0}
    for e in skeleton.get("entries", []):
        params = e.get("parameters", [])
        if not params:
            continue
        head_tok = next(iter(params[-1]), None)
        zh_head = token2zh.get(head_tok, "") if head_tok else ""
        if not zh_head and drop_missing:
            stats["dropped_head"] += 1
            continue
        filled = []
        for obj in params[:-1]:
            m = {}
            for tok in obj:
                zh = token2zh.get(tok, "")
                if zh or not drop_missing:
                    m[tok] = zh
                else:
                    stats["dropped_mod"] += 1
            filled.append(m)
        if drop_missing and any(not m for m in filled):
            stats["dropped_entry"] += 1
            continue
        key_tpl = next(iter(e["templates"]))
        order, head_pre = parse_value_slots(next(iter(e["templates"].values())))
        body = "".join("{%d}" % i for i in order)
        if head_pre:
            val_tpl = escape_literal(zh_head) + body
        else:
            val_tpl = body + escape_literal(zh_head)
        entries.append({"templates": {key_tpl: val_tpl}, "parameters": filled})
    return {"target": skeleton.get("target", ""), "entries": entries}, stats


# ---------------------------------------------------------------- 输出与验证


def default_target(lang_dir):
    ns = os.path.basename(os.path.dirname(os.path.abspath(lang_dir)))
    return "assets/%s/lang/zh_cn.json" % ns


# ---------------------------------------------------------------- 基础工具

FMT = re.compile(r'%(\d+\$)?[sdf]|%%|\{[^}]*\}|§.|\\n|\\t|\\r')
CJK = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')
LAT = re.compile(r'[A-Za-z]')
WORD = re.compile(r'[a-z0-9]+')

NAME_PUNCT = '.!?;:,'        # 名字型显示名里不出现的标点
NAME_WORDS = (1, 6)          # 名字型显示名的词数范围
PHRASE_N = (2, 3)            # 固定短语取的 n-gram 长度
WRAP = 100                   # 槽行折行宽度（显示列）

# 英语虚词表：句子型标题漏进名字型的 the/a/of/acquire 之类，按语言级声明剔除
STOPWORDS = {
    'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'without',
    'and', 'or', 'nor', 'but', 'as', 'into', 'onto', 'over', 'under', 'out', 'up', 'down',
    'off', 'about', 'above', 'below', 'between', 'through', 'than', 'then', 'so', 'if',
    'when', 'while', 'during', 'after', 'before', 'until', 'because', 'via', 'per',
    'it', 'its', 'this', 'that', 'these', 'those', 'your', 'you', 'we', 'our', 'us',
    'their', 'they', 'them', 'he', 'she', 'his', 'her', 'i', 'me', 'my', 'all', 'any',
    'some', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'only', 'own', 'same',
    'such', 'here', 'there', 'what', 'which', 'who', 'whom', 'whose', 'how', 'why', 'where',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done',
    'have', 'has', 'had', 'can', 'could', 'will', 'would', 'shall', 'should', 'may',
    'might', 'must', 'not', 'no', 's', 't',
    'unlock', 'unlocks', 'unlocked', 'acquire', 'acquires', 'obtain', 'obtains',
    'get', 'gets', 'use', 'used', 'uses', 'using',
}


def norm_en(s):
    return WORD.findall(FMT.sub(' ', s.lower()))


def name_like(s):
    """名字型显示名：无句读、词数 1~6、过半词首字母大写。"""
    if not isinstance(s, str) or any(c in NAME_PUNCT for c in s):
        return False
    raw = s.split()
    if not NAME_WORDS[0] <= len(raw) <= NAME_WORDS[1]:
        return False
    return sum(1 for w in raw if w[:1].isupper()) * 2 > len(raw)


def norm_zh(s):
    return ' '.join(FMT.sub(' ', s).split()).strip()


def lcp(a, b):
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return a[:i]


def lcs(a, b):
    n = min(len(a), len(b))
    i = 0
    while i < n and a[len(a) - 1 - i] == b[len(b) - 1 - i]:
        i += 1
    return a[len(a) - i:]


def disp_width(s):
    return sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in s)


def wpad(s, width):
    return s + ' ' * max(0, width - disp_width(s))


def json_load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def wrap_line(items, prefix='', cont='    ', width=WRAP):
    """把 items 拼成不超过 width 显示列的多行，续行用 cont 缩进。"""
    lines, cur = [], prefix
    for it in items:
        if cur.strip() and disp_width(cur) + disp_width(it) + 1 > width:
            lines.append(cur)
            cur = cont + it
        else:
            cur += it if not cur.strip() else ' ' + it
    if cur.strip():
        lines.append(cur)
    return lines


# ---------------------------------------------------------------- 骨架对齐

def harvest(group, votes, stats, seen):
    """group: [(token, zh, modid)]；把 token->中文片段 的票投进 votes。

    组内所有 zh 的公共前后缀 = 上下文，挖掉后剩下的片段就是变动 token 的译法。
    要求：变动片段数 <= 词数、同一个词在组内只有一种译法，否则整组丢弃。
    投票按模组去重，一个模组对一个 (词, 译法) 只算一票。
    """
    toks = set(g[0] for g in group)
    if len(group) < 2 or len(toks) < 2:
        stats['small'] += 1
        return
    pre = suf = None
    for g in group:
        z = g[1]
        pre = z if pre is None else lcp(pre, z)
        suf = z if suf is None else lcs(suf, z)
        if not pre and not suf:
            break
    if not pre and not suf:
        stats['noctx'] += 1
        return
    pairs = []
    for t, z, m in group:
        if len(z) < len(pre) + len(suf):
            continue
        mid = z[len(pre):len(z) - len(suf)]
        if mid and CJK.search(mid) and len(mid) <= 12 and not LAT.search(mid):
            pairs.append((t, mid, m))
    if len(set(p[1] for p in pairs)) > len(toks):    # 变动片段比词还多 => 没对齐
        stats['ambig'] += 1
        return
    t2m = {}
    for t, m, mm in pairs:
        if t2m.get(t, m) != m:                        # 同词两种译法 => 没对齐
            stats['notfun'] += 1
            return
        t2m[t] = m
    if len(t2m) < 2:
        stats['small2'] += 1
        return
    stats['ok'] += 1
    for t, m, mm in pairs:
        k = hash((mm, t, m))
        if k in seen:
            continue
        seen.add(k)
        votes[t][m] += 1


def mine_pairs(rows, stats=None):
    """rows: [(modid, tokens, zh)]；按掩码骨架分组对齐 -> votes[token][zh片段]。"""
    groups = collections.defaultdict(list)
    for modid, toks, z in rows:
        if len(toks) < 2 or len(toks) > 9:
            continue
        for i in range(len(toks)):
            sk = (tuple(toks[:i]), tuple(toks[i + 1:]))
            groups[sk].append((toks[i], z, modid))
    votes = collections.defaultdict(collections.Counter)
    st = stats if stats is not None else collections.Counter()
    seen = set()
    for g in groups.values():
        if len(g) >= 2:
            harvest(g, votes, st, seen)
    return votes, st


# ---------------------------------------------------------------- 模组分析

def load_mod(lang_dir):
    en_p = os.path.join(lang_dir, 'en_us.json')
    zh_p = os.path.join(lang_dir, 'zh_cn.json')
    if not os.path.exists(en_p):
        sys.exit('找不到 %s' % en_p)
    return json_load(en_p), (json_load(zh_p) if os.path.exists(zh_p) else {}), zh_p


def name_seqs(en):
    """名字型显示名 -> [(key, [词])]（去掉英语虚词），术语只从显示名取，键不参与。"""
    seqs = []
    for key, val in en.items():
        if not name_like(val):
            continue
        ws = [w for w in norm_en(val) if w not in STOPWORDS]
        if ws:
            seqs.append((key, ws))
    return seqs


def merge_compounds(seqs):
    """固定搭配并成一个复合词（witch hazel / rainbow eucalyptus / seat back）。

    判据: bigram 的条目数 == 尾词条目数（尾词不会单独出现）且 > 首词条目数的一半
    （首词基本只在这个搭配里出现）。这样 white mangrove 不会并（white 另有大量用法）。
    """
    cnt = collections.Counter()
    for _, ws in seqs:
        cnt.update(set(ws))
    gram = collections.Counter()
    for _, ws in seqs:
        for i in range(len(ws) - 1):
            gram[' '.join(ws[i:i + 2])] += 1
    comp, used = {}, set()
    for g, n in sorted(gram.items(), key=lambda x: -x[1]):
        a, b = g.split(' ')
        if n < 2 or n != cnt[b] or n * 2 <= cnt[a] or a in used or b in used:
            continue
        comp[(a, b)] = g
        used.update((a, b))
    if not comp:
        return seqs
    out = []
    for key, ws in seqs:
        nw, i = [], 0
        while i < len(ws):
            g = comp.get((ws[i], ws[i + 1])) if i + 1 < len(ws) else None
            if g:
                nw.append(g)
                i += 2
            else:
                nw.append(ws[i])
                i += 1
        out.append((key, nw))
    return out


def build_slots(seqs):
    """同位置互替的词并成一组 -> (词->条目数, [(成员集, 覆盖条目数)])。

    掩码骨架 = 名字里挖掉该词后剩下的词，两边完全相同即视为互替（颜色槽 blue/gray/red…、
    木材槽 maple/palm/fir… 这样成组）。每个词只进一个组：掩码桶按成员数从大到小处理，
    桶里还没成组的词并成一组；出现在两种结构位置上的词（belt 既是产物又在修饰位）
    因此不会把两个槽串成一个巨型槽。单词名没有上下文，不参与分组。
    """
    cnt = collections.Counter()
    for _, ws in seqs:
        cnt.update(set(ws))
    par = {w: w for w in cnt}

    def find(x):
        while par.get(x, x) != x:
            par[x] = par[par[x]]
            x = par[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            par[ra] = rb

    buckets = collections.defaultdict(set)
    for _, ws in seqs:
        if len(ws) < 2:
            continue
        seen = set()
        for i, w in enumerate(ws):
            if w in seen:
                continue
            seen.add(w)
            buckets[(tuple(ws[:i]), tuple(ws[i + 1:]))].add(w)
    grouped = set()
    for _, st in sorted(buckets.items(), key=lambda x: -len(x[1])):
        free = sorted(w for w in st if w not in grouped)
        if len(free) < 2:
            continue
        for w in free[1:]:
            union(free[0], w)
        grouped.update(free)
    groups = collections.defaultdict(set)
    for w in cnt:
        groups[find(w)].add(w)
    cover = collections.Counter()
    for _, ws in seqs:
        for r in set(find(w) for w in ws):
            cover[r] += 1
    slots = [(st, cover[r]) for r, st in groups.items()]
    slots.sort(key=lambda x: (-x[1], -len(x[0]), sorted(x[0])[0]))
    return cnt, slots


def fixed_items(seqs, single, cnt, min_impact):
    """槽外固定词 + 全由固定词构成的固定短语，按条目数排序；只出现在短语里的词不单列。"""
    gram = collections.Counter()
    for _, ws in seqs:
        for n in PHRASE_N:
            for i in range(len(ws) - n + 1):
                span = ws[i:i + n]
                if all(w in single for w in span):
                    gram[' '.join(span)] += 1
    keep = {g for g, n in gram.items() if n >= min_impact}
    inside = collections.Counter()
    for _, ws in seqs:
        for n in PHRASE_N:
            for i in range(len(ws) - n + 1):
                g = ' '.join(ws[i:i + n])
                if g in keep:
                    inside.update(ws[i:i + n])
    items = [(g, gram[g]) for g in keep]
    items += [(w, cnt[w]) for w in single if cnt[w] > inside[w] and cnt[w] >= min_impact]
    items.sort(key=lambda x: (-x[1], x[0]))
    return items


def report_glossary(seqs, cnt, slots, top, min_impact):
    """译前词表：词槽（同位置互替，成员 ≥2）+ 槽外固定词/短语。"""
    lines = []
    multi = [(st, cov) for st, cov in slots if len(st) >= 2]
    single = {w for st, _ in slots if len(st) == 1 for w in st}
    lines.append('')
    lines.append('── 词槽（名字型显示名里同位置互替，成员 ≥2）：%d 组（列出 %d 组）'
                 % (len(multi), min(top, len(multi)) if top else len(multi)))
    for st, cov in (multi[:top] if top else multi):
        items = sorted(st, key=lambda w: (-cnt[w], w))
        lines += wrap_line(items, '  [%d] %d条 | ' % (len(st), cov), ' ' * 10)
    if top and len(multi) > top:
        lines.append('   … 其余 %d 组略' % (len(multi) - top))

    items = fixed_items(seqs, single, cnt, min_impact)
    sel = items[:top] if top else items
    lines.append('')
    lines.append('── 固定词 / 短语（槽外，按条目数）：%d 条（列出 %d 条）' % (len(items), len(sel)))
    for g, n in sel:
        lines.append('%5d条 | %s' % (n, g))
    if len(items) > len(sel):
        lines.append('   … 其余 %d 条（共 %d 条）略' % (len(items) - len(sel),
                                                    sum(n for _, n in items[len(sel):])))
    shown = set(single)
    for st, _ in multi:
        shown |= st
    cov = sum(1 for _, ws in seqs if set(ws) & shown)
    lines.append('')
    lines.append('词表覆盖：%d/%d 名字型条目 = %d%%'
                 % (cov, len(seqs), round(100 * cov / max(1, len(seqs)))))
    return lines


def report_review(lang_dir, en, zh, zh_src, ns, top, min_impact):
    """校对模式：同一英文的多种译法；骨架对齐候选。"""
    lines = ['# %s' % lang_dir,
             '# 条目 %d 条 / 中文 %d 条 / 中文来源：%s' % (len(en), len(zh), zh_src),
             '']

    by_en = collections.defaultdict(collections.Counter)
    ex = collections.defaultdict(list)
    for key, e in en.items():
        z = norm_zh(zh.get(key, ''))
        if not isinstance(e, str) or not e.strip() or not CJK.search(z):
            continue
        by_en[e][z] += 1
        if len(ex[(e, z)]) < 2:
            ex[(e, z)].append(key)
    a_div = [(e, c) for e, c in by_en.items()
             if len(c) >= 2 and sum(c.values()) >= min_impact]
    a_div.sort(key=lambda x: -sum(x[1].values()))
    lines.append('── 同一英文，多种译法：%d 组' % len(a_div))
    for e, c in (a_div[:top] if top else a_div):
        lines.append('%5d条 | %s 本模组: %s' % (
            sum(c.values()), wpad(e, 26),
            ' / '.join('%s(%d)' % (v, n) for v, n in c.most_common(3))))
        for v, _ in c.most_common(2):
            lines.append('        └ %s = %s' % (ex[(e, v)][0], v))
    if top and len(a_div) > top:
        lines.append('   … 其余 %d 组略' % (len(a_div) - top))

    # 骨架对齐：同一 mask 下的变动词，片段是候选，需人核对切分
    rows = [(ns, norm_en(e), norm_zh(zh.get(key, '')))
            for key, e in en.items()
            if isinstance(e, str) and zh.get(key)
            and CJK.search(norm_zh(zh.get(key, '')))]
    votes, _ = mine_pairs(rows)
    b_div = [(t, c) for t, c in votes.items()
             if len(c) >= 2 and sum(c.values()) >= min_impact]
    b_div.sort(key=lambda x: -sum(x[1].values()))
    lines.append('')
    lines.append('── 同一名字骨架，变动词多种译法（候选，需核对）：%d 个' % len(b_div))
    for t, c in (b_div[:top] if top else b_div):
        lines.append('%5d种 | %s 本模组: %s' % (
            len(c), wpad(t, 18),
            ' / '.join('%s(%d)' % (v, n) for v, n in c.most_common(3))))
        shown = 0
        for v, _ in c.most_common(2):
            for key, e in en.items():
                z = norm_zh(zh.get(key, ''))
                if t in norm_en(e) and v in z:
                    lines.append('        └ %s = %s' % (key, z))
                    shown += 1
                    break
            if shown >= 2:
                break
    if top and len(b_div) > top:
        lines.append('   … 其余 %d 个略' % (len(b_div) - top))
    return lines


# ---------------------------------------------------------------- 输出与覆盖报告


def ensure_parent(path):
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)


def write_json(path, data):
    ensure_parent(path)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def write_text(path, text):
    ensure_parent(path)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def terms_reach(en, terms):
    """术语表能碰到多少条：显示名里出现术语表任一词/短语（子串匹配）即算碰到。"""
    pat = re.compile("|".join(re.escape(t) for t in terms)) if terms else None
    if not pat:
        return 0
    return sum(1 for v in en.values() if isinstance(v, str) and pat.search(v.lower()))


def lang_stats(en, seqs, slots):
    """(多成员词槽数, 槽外单词数)；槽外单词数 = 只落进单成员槽的词。"""
    n_multi = sum(1 for st, _ in slots if len(st) >= 2)
    n_single = sum(1 for st, _ in slots if len(st) == 1)
    return n_multi, n_single


def mod_header(lang_dir, en, seqs, slots, mode):
    n_multi, n_single = lang_stats(en, seqs, slots)
    return ["# %s" % lang_dir,
            "# 条目 %d 条 / 名字型显示名 %d 条 (%d%%) / 词槽 %d 组 + 槽外词 %d 个"
            % (len(en), len(seqs), round(100 * len(seqs) / max(1, len(en))),
               n_multi, n_single),
            "# 模式=%s" % mode]


def coverage_lines(ns, lang_dir, en, seqs, slots, items, terms, stats):
    """覆盖报告（人话）：条目数 / 术语数 / 组合模板能盖多少条 / 术语表能碰到多少条。"""
    n_multi, n_single = lang_stats(en, seqs, slots)
    single = {w for st, _ in slots if len(st) == 1 for w in st}
    shown = set(single)
    for st, _ in slots:
        if len(st) >= 2:
            shown |= st
    gcov = sum(1 for _, ws in seqs if set(ws) & shown)
    reach = terms_reach(en, [t.lower() for t in terms])
    lines = [
        "# %s 覆盖报告（EN-only）" % ns,
        "",
        "- 条目数：%d 条（%s）" % (len(en), lang_dir),
        "- 名字型显示名：%d 条（%.1f%%）——术语只从这类显示名取"
        % (len(seqs), 100 * len(seqs) / max(1, len(en))),
        "- 待译术语数：%d 个（组合骨架摊出来的重复段）" % len(terms),
        "- 组合模板能盖：%d / %d 条 = %.1f%%（条目 %d 条，展开 %d 键，多余键 %d）"
        % (stats["hit_en"], stats["en"], stats["coverage"], stats["entries"],
           stats["generated"], stats["extra_key"]),
        "- 术语表能碰到：%d / %d 条 = %.1f%%"
        % (reach, len(en), 100 * reach / max(1, len(en))),
        "- 一致性词表：词槽 %d 组 + 固定词/短语 %d 条，覆盖 %d / %d 名字型条目 = %.0f%%"
        % (n_multi, len(items), gcov, len(seqs), 100 * gcov / max(1, len(seqs))),
        "",
        "口径：",
        "- 「组合模板能盖」= 骨架展开出的键里命中 en_us 的条数；多余键 = 展开出来但 en_us 里没有的键。",
        "- 「术语表能碰到」= 待译术语表里的词/短语在显示名里作为子串出现即算碰到"
        "（与 accept_check.py 同口径）。",
        "- 「一致性词表」覆盖 = 名字型条目里出现任一槽成员/固定词的条数。",
    ]
    return lines


def glossary_inputs(en, min_impact):
    """prep 词表输入 -> (seqs, cnt, slots, items)。"""
    seqs = merge_compounds(name_seqs(en))
    cnt, slots = build_slots(seqs)
    single = {w for st, _ in slots if len(st) == 1 for w in st}
    items = fixed_items(seqs, single, cnt, min_impact)
    return seqs, cnt, slots, items


# ---------------------------------------------------------------- 全文本 n-gram 挖术语

MINE_N_MAX = 5               # 候选 n-gram 的最大单元数（en 默认；zh/ja 8）
MINE_SPLIT = re.compile(r"[^A-Za-z0-9'’\-\s_]+")   # 子句边界：句读与其它符号（URL/括号/斜杠）
MINE_WORD = re.compile(r"[A-Za-z][A-Za-z0-9'’\-]*")
MINE_EX_LEN = 60             # 例句截断长度
MINE_EX_SRC = 200            # 例句原句最长保留多少字
MINE_PCT_COH = 30            # 凝聚度（最小互信息）阈值 = 候选自身分布的第几百分位
MINE_PCT_ENT = 40            # 边界熵阈值 = 候选自身分布的第几百分位
MINE_HEAD = ['term', 'n', 'impact', 'long', 'name', 'mi', 'hmin', 'example']
MINE_HEAD_CJK = ['term', 'n', 'impact', 'long', 'name', 'mi', 'hmin', 'ref', 'ref_votes',
                 'ref_total', 'ref_src', 'example']

TERMHOODS = ('auto', 'self', 'specificity')   # 术语度策略
PROSE_MED_LEN = 60        # auto：中位条目长度达到它就按散文语料处理
COMMON_ZIPF = 4.5         # 通用英语里到这个频率算常见词，不单独当术语
INVENTED_ZIPF = 1.5       # 低于这个频率算生造词（通用英语里几乎没有）
CAP_RATIO = 0.10          # 生造词的旁证：句中大写占比或限定词占比达到它
NOUN_DET_RATIO = 0.10     # 多词末词的限定词占比下限（名词的廉价探针）
MINE_MI_ABS = 3.0         # specificity 的凝聚度绝对下限
MINE_ENT_ABS = 1.5        # specificity 的边界熵绝对下限

DET_WORDS = {'the', 'a', 'an', 'your', 'her', 'his', 'their', 'its', 'this', 'that',
             'these', 'those', 'my', 'our', 'some', 'each', 'every', 'another', 'any'}
PRONOUNS = {'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'he', 'him', 'his', 'she',
            'her', 'hers', 'it', 'its', 'we', 'us', 'our', 'ours', 'they', 'them',
            'their', 'theirs', 'myself', 'yourself', 'himself', 'herself', 'itself',
            'ourselves', 'themselves', 'who', 'whom', 'whose'}

MINE_LATIN = r"[A-Za-z][A-Za-z0-9'’\-]*"     # 混合文本里的拉丁词：自己算一个单元
MINE_NUMBER = r"\d+"                          # 混合文本里的数字：自己算一个单元
MINE_SCRIPT = {                               # 每种语言的文字块（单元与子句边界都从它推）
    'zh': r"\u4e00-\u9fff\u3400-\u4dbf",
    'ja': r"\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff",
    'ko': r"\uac00-\ud7af\u1100-\u11ff",
}
MINE_JA_SEP = r"|[\u30fb\u30a0]"              # 日语的・和゠是分隔符，不是词的成分
MINE_JA_UNIT = r"[\u4e00-\u9fff\u3400-\u4dbf]|[\u30a0-\u30ff]+|[\u3040-\u309f]|[A-Za-z0-9]+"
MINE_JA_EDGE = re.compile(r"[\u3040-\u309f]")  # 平假名是助词与活用形，不能当 gram 的首尾

STOP_CJK = set('的了在是和平与为以及或也都就而其之等被把对从向由让使能会要可不没很更最'
               '个些这那有我你他它们上下中里外前后时地得着过来去到于并但且则若如即才再又还'
               '只各每某该此本一二三四五六七八九十')
STOP_KO = set('이 가 은 는 을 를 의 에 와 과 도 만 까지 부터 로 으로 그리고 하지만 그러나 또한 '
              '및 등 것 수 있다 없다 하다 되다 이 그 저 어떤 이렇게 그렇게 저렇게'.split())


def _mine_units(chars, run=False, extra=''):
    """(单元正则, 子句边界正则)：文字块里每个字一个单元（run 时整段算一个）；拉丁词、数字各算一个单元。"""
    body = "[%s]%s" % (chars, "+" if run else "")
    return (re.compile(r"%s|%s|%s" % (body, MINE_LATIN, MINE_NUMBER)),
            re.compile(r"[^%sA-Za-z0-9'’\-\s_]+%s" % (chars, extra)))


def _mine_lang_table():
    """语言 -> 语言码 / 单元 / 子句边界 / 虚词表 / 首尾禁用单元 / 最大 n / 表面写法（汉字连写还是空格分开）。"""
    table = {'en': {'file': 'en_us', 'max_n': MINE_N_MAX, 'min_n': 1, 'split': MINE_SPLIT,
                    'unit': MINE_WORD, 'stop': STOPWORDS, 'edge': None, 'cjk': False,
                    'join': ' ', 'label': 'en'}}
    for lang, code, stop, max_n, join in (('zh', 'zh_cn', STOP_CJK, 8, ''),
                                          ('ja', 'ja_jp', STOP_CJK, 8, ''),
                                          ('ko', 'ko_kr', STOP_KO, 5, ' ')):
        unit, split = _mine_units(MINE_SCRIPT[lang],
                                  extra=MINE_JA_SEP if lang == 'ja' else '')
        table[lang] = {'file': code, 'max_n': max_n, 'min_n': 2, 'unit': unit,
                       'split': split, 'stop': stop, 'edge': None, 'cjk': True,
                       'join': join, 'label': lang}
    table['ja']['unit'] = re.compile(MINE_JA_UNIT)     # 片假名整串一个单元（外来语不切开）
    table['ja']['edge'] = MINE_JA_EDGE
    table['ko']['unit'] = MINE_KO_EOJEOL               # 韩语默认按空格切语节
    table['ko-syllable'] = dict(table['ko'], unit=MINE_KO_SYLLABLE, max_n=8, label='ko 音节')
    return table


MINE_LANGS = ('en', 'zh', 'ja', 'ko')         # 命令行能给的四种语言
MINE_KO_SYLLABLE = _mine_units(MINE_SCRIPT['ko'])[0]                   # 韩语按音节切
MINE_KO_EOJEOL = _mine_units(MINE_SCRIPT['ko'], run=True)[0]           # 韩语按空格切语节
MINE_LANG = _mine_lang_table()


def mine_lang_key(lang, ko_unit='eojeol'):
    """韩语两种单元各占一个内部语言键：ko（按空格切语节）、ko-syllable（按音节切）。"""
    return 'ko-syllable' if lang == 'ko' and ko_unit == 'syllable' else lang


CJK_NAME_PUNCT = '.!?;:，。！？；：、…～'    # 名字型显示名里不出现的标点（中英混排都算）
CJK_NAME_UNITS = (1, 12)                    # 名字型显示名的单元数范围


def name_like_cjk(s, lang):
    """名字型显示名：无句读、单元数 1~12（长过它就是整句）。"""
    if not isinstance(s, str) or any(c in CJK_NAME_PUNCT for c in s):
        return False
    n = len(MINE_LANG[lang]['unit'].findall(s))
    return CJK_NAME_UNITS[0] <= n <= CJK_NAME_UNITS[1]


def mine_clauses(text, lang='en'):
    """显示名 -> [(子句原文, [单元])]；子句按标点切（下划线当空格），n-gram 不跨子句。"""
    spec = MINE_LANG[lang]
    out = []
    for cl in spec['split'].split(FMT.sub(' ', text).replace('_', ' ')):
        cl = cl.strip()
        ws = spec['unit'].findall(cl)
        if ws:
            out.append((cl, ws))
    return out


def mine_candidate(gram, lang='en'):
    """候选单元过滤：整串虚词、或以虚词起止的片段（the/of、的铜 这类半截短语）不要。"""
    spec = MINE_LANG[lang]
    stop = spec['stop']
    edge = spec['edge']
    return not (gram[0] in stop or gram[-1] in stop
                or all(w in stop for w in gram)
                or (edge is not None and (edge.match(gram[0]) or edge.match(gram[-1]))))


def shannon(counter):
    """邻接分布的香农熵（bit）。"""
    tot = sum(counter.values())
    if tot <= 1:
        return 0.0
    return max(0.0, -sum((n / tot) * math.log2(n / tot) for n in counter.values()))


def percentile(vals, pct):
    """分位数（最近秩，不插值）：阈值从候选自身分布取，不写死。"""
    if not vals:
        return 0.0
    v = sorted(vals)
    return v[min(len(v) - 1, int(len(v) * pct / 100.0))]


def mine_entries(data, max_n=MINE_N_MAX, lang='en'):
    """语言文件 -> [(key, 是否名字型, [(子句, [单元])])]。"""
    out = []
    for key, val in data.items():
        if not isinstance(val, str):
            continue
        cl = mine_clauses(val, lang)
        if cl:
            out.append((key, name_like(val) if lang == 'en' else name_like_cjk(val, lang), cl))
    return out


def mine_freqs(parsed, max_n):
    """第一遍：每个 n-gram 落在多少个不同条目里（名字型/长文本分开计）。"""
    docs = collections.Counter()
    namec = collections.Counter()
    for _, is_name, clauses in parsed:
        seen = set()
        for _, ws in clauses:
            low = [w.lower() for w in ws]
            for n in range(1, min(max_n, len(low)) + 1):
                for i in range(len(low) - n + 1):
                    seen.add(tuple(low[i:i + n]))
        for g in seen:
            docs[g] += 1
            if is_name:
                namec[g] += 1
    return docs, namec


def mine_context(parsed, keep, max_n, lang='en'):
    """第二遍：只给留存的 n-gram 收左右邻接分布（只数真单元）、出现次数、常见原形、例句。"""
    left = collections.defaultdict(collections.Counter)
    right = collections.defaultdict(collections.Counter)
    whole = collections.Counter()
    init_name = collections.Counter()
    surf = collections.defaultdict(collections.Counter)
    occ = collections.Counter()
    ex_long, ex_name = {}, {}
    join = MINE_LANG[lang]['join']
    for _, is_name, clauses in parsed:
        for cl, ws in clauses:
            low = [w.lower() for w in ws]
            for n in range(1, min(max_n, len(low)) + 1):
                for i in range(len(low) - n + 1):
                    g = tuple(low[i:i + n])
                    if g not in keep:
                        continue
                    occ[g] += 1
                    if i:
                        left[g][low[i - 1]] += 1
                    else:
                        whole[g] += i + n == len(low)
                        init_name[g] += is_name
                    if i + n < len(low):
                        right[g][low[i + n]] += 1
                    surf[g][join.join(ws[i:i + n])] += 1
                    ex = ex_name if is_name else ex_long
                    cur = ex.get(g)
                    if cur is None or (len(cur) < len(cl) <= MINE_EX_SRC):
                        ex[g] = cl
    return left, right, whole, init_name, surf, occ, ex_long, ex_name


def mine_hmin(left, right, whole, init_name):
    """最小边界熵：只数真单元邻接，一侧样本不足 2 个当没证据（不设限），长文本句首片段按钉死算 0。"""
    free = math.inf if (whole or init_name) else 0.0
    hl = shannon(left) if sum(left.values()) >= 2 else free
    hr = shannon(right) if sum(right.values()) >= 2 else math.inf
    return min(hl, hr)


def mine_mi(gram, docs, n_docs):
    """最小互信息：所有切分点里最弱的那一刀（bit）；单词没有切分点，不设限。"""
    if len(gram) < 2:
        return math.inf
    return min(math.log2(docs[gram] * n_docs / (docs[gram[:s]] * docs[gram[s:]]))
               for s in range(1, len(gram)))


def mine_surface(counter, fallback=''):
    """原形取最常见写法；句首会大写，所以只看非句首出现（没有就用整体）。"""
    return (counter or collections.Counter()).most_common(1)[0][0] if counter else fallback


def mine_scores(parsed, max_n, min_impact, lang='en'):
    """候选 -> (行, 邻接与次数表)：行里是影响条目数/最小互信息/边界熵/例句/原形。"""
    docs, namec = mine_freqs(parsed, max_n)
    ok = {g for g, c in docs.items() if c >= min_impact}
    keep = {g for g in ok if mine_candidate(g, lang)}
    ctx = mine_context(parsed, keep, max_n, lang)
    left, right, whole, init_name, surf, occ, ex_long, ex_name = ctx
    rows = []
    for g in keep:
        n = len(g)
        f = docs[g]
        rows.append({'gram': g, 'n': n, 'freq': f, 'long': f - namec[g], 'name': namec[g],
                     'mi': mine_mi(g, docs, len(parsed)),
                     'hmin': mine_hmin(left[g], right[g], whole[g], init_name[g]),
                     'example': (ex_long.get(g) or ex_name.get(g) or '')[:MINE_EX_LEN],
                     'surface': mine_surface(surf.get(g), MINE_LANG[lang]['join'].join(g))})
    return rows, {'left': left, 'right': right, 'occ': occ, 'stopped': len(ok) - len(keep)}


def drop_substrings(rows):
    """短 gram 的频率和某个长超串完全相等 -> 它只是长术语的一部分，丢掉。"""
    sup = collections.defaultdict(lambda: collections.defaultdict(set))
    for r in rows:
        g = r['gram']
        for m in range(1, len(g)):
            for i in range(len(g) - m + 1):
                sup[r['freq']][g[i:i + m]].add(g)
    return [r for r in rows if not sup[r['freq']].get(r['gram'])]


def mine_window(rows, ent_thr, left, right, occ):
    """窗口偏移还原 -> (片段 -> {前缀: 次数}, 疑似片段, 补进表的形式)：片段从不独立出现，且 ≥2 个前缀+片段是候选、前缀+片段首单元过了熵门。"""
    cand = {r['gram']: r for r in rows}
    ends = {g: occ[g] - sum((right.get(g) or {}).values()) for g in occ}

    def whole(g):
        return cand[g]['hmin'] > ent_thr and ends[g] > 0

    merged, suspect, promote = {}, [], {}
    for r in rows:
        g = r['gram']
        if len(g) < 2 or r['hmin'] <= ent_thr:
            continue
        ext = {x: n for x, n in left[g].items() if (x,) + g in cand}
        conf = {x: n for x, n in ext.items()
                if (x,) + g[:1] in cand and cand[(x,) + g[:1]]['hmin'] > ent_thr}
        free = occ[g] - sum(ext.values())
        if len(conf) >= 2 and free == 0:
            merged[g] = conf
            promote.update({(x,) + g: cand[(x,) + g] for x in conf
                            if whole((x,) + g)})
        elif len(ext) >= 2:
            suspect.append(g)
    return merged, suspect, {g: r for g, r in promote.items() if g not in merged}


class SpecLexicon:
    """领域特异度：语料频率对通用英语频率的倍率，散文语料的术语度来源。"""

    def __init__(self, parsed):
        self.tot = collections.Counter()
        self.med = collections.Counter()
        self.det = collections.Counter()
        for _, _, clauses in parsed:
            for _, ws in clauses:
                low = [w.lower() for w in ws]
                for i, w in enumerate(low):
                    self.tot[w] += 1
                    if i and ws[i][:1].isupper():
                        self.med[w] += 1
                    if low[i - 1] in DET_WORDS:
                        self.det[w] += 1
        total = sum(self.tot.values()) or 1
        self.delta = {w: math.log2(c / total) - (zipf_frequency(w, 'en') - 9) * math.log2(10)
                      for w, c in self.tot.items()}

    def cap_ratio(self, w):
        """句中大写占比：专名的旁证（句首词不算）。"""
        return self.med[w] / self.tot[w] if self.tot[w] else 0.0

    def det_ratio(self, w):
        """限定词占比：紧跟 the/a/your 出现的比例，名词的廉价探针。"""
        return self.det[w] / self.tot[w] if self.tot[w] else 0.0

    def termish(self, w):
        """术语词：通用英语里罕见（生造词），或句中大写居多（专名）。"""
        if len(w) < 3 or self.tot[w] < 3:
            return False
        z = zipf_frequency(w, 'en')
        if z <= INVENTED_ZIPF:
            return not w.endswith('ly') and max(self.cap_ratio(w), self.det_ratio(w)) >= CAP_RATIO
        return self.cap_ratio(w) >= 0.5 and z <= COMMON_ZIPF


def mine_terms_specificity(rows, lexicon, min_n):
    """特异度策略：术语度取通用英语对比，凝聚度与边界熵取绝对阈值。"""
    bad_mi = {r['gram'] for r in rows if r['n'] >= 2 and r['mi'] < MINE_MI_ABS}
    bad_ent = {r['gram'] for r in rows if r['hmin'] < MINE_ENT_ABS}
    kept = []
    for r in rows:
        g = r['gram']
        if not any(lexicon.termish(w) for w in g):
            continue
        if len(g) > 1 and any(w in PRONOUNS for w in g):
            continue
        if len(g) > 1 and lexicon.det_ratio(g[-1]) < NOUN_DET_RATIO:
            continue
        if g in bad_mi or g in bad_ent:
            continue
        kept.append(r)
    pre_sub = len(kept)
    kept = [r for r in kept if len(r['surface']) >= min_n]
    kept.sort(key=lambda r: (-r['freq'], -r['n'], -r['mi'], r['gram']))
    stats = {'cand': len(rows), 'kept': len(kept), 'pre_sub': pre_sub,
             'mi_thr': MINE_MI_ABS, 'ent_thr': MINE_ENT_ABS,
             'unconstrained': sum(1 for r in rows if r['hmin'] == math.inf),
             'bad_mi': len(bad_mi), 'bad_ent': len(bad_ent), 'both': len(bad_mi & bad_ent),
             'stopped': 0, 'merged': {}, 'suspect': [], 'promote': [],
             'min_n': min_n, 'thin': 0, 'termhood': 'specificity'}
    return kept, stats


def mine_terms(parsed, max_n=MINE_N_MAX, min_impact=2, pct_coh=MINE_PCT_COH,
               pct_ent=MINE_PCT_ENT, use_entropy=True, lang='en', min_n=1,
               termhood='self', lexicon=None):
    """全文本挖术语 -> (按影响条目数降序的行, 统计)；min_n 只筛输出，单单元照样参与统计。"""
    rows, ctx = mine_scores(parsed, max_n, min_impact, lang)
    if termhood == 'specificity':
        return mine_terms_specificity(rows, lexicon, min_n)
    mi_thr = percentile([r['mi'] for r in rows if r['n'] >= 2], pct_coh)
    finite = [r['hmin'] for r in rows if r['hmin'] != math.inf]
    ent_thr = percentile(finite, pct_ent) if use_entropy else 0.0
    bad_mi = {r['gram'] for r in rows if r['n'] >= 2 and r['mi'] <= mi_thr}
    bad_ent = {r['gram'] for r in rows if use_entropy and r['hmin'] <= ent_thr}
    merged, suspect, promote = ({}, [], {})
    if MINE_LANG[lang]['cjk']:
        merged, suspect, promote = mine_window(rows, ent_thr, ctx['left'], ctx['right'],
                                               ctx['occ'])
    kept = [r for r in rows if r['gram'] not in merged and r['gram'] not in bad_mi
            and r['gram'] not in bad_ent]
    pre_sub = len(kept)
    kept = drop_substrings(kept)
    have = {r['gram'] for r in kept}
    kept += [r for g, r in promote.items() if g not in have]
    thin = len(kept)
    kept = [r for r in kept if len(r['surface']) >= min_n]
    kept.sort(key=lambda r: (-r['freq'], -r['n'], -r['mi'], r['gram']))
    stats = {'cand': len(rows), 'kept': len(kept), 'pre_sub': pre_sub,
             'mi_thr': mi_thr, 'ent_thr': ent_thr,
             'unconstrained': len(rows) - len(finite),
             'bad_mi': len(bad_mi), 'bad_ent': len(bad_ent),
             'both': len(bad_mi & bad_ent), 'stopped': ctx['stopped'],
             'merged': merged, 'suspect': suspect, 'min_n': min_n,
             'thin': thin - len(kept), 'promote': [g for g in promote if g not in have]}
    return kept, stats


def ref_pairs(primary, ref):
    """同目录两份语言文件 -> [(本条语言的值, 对照语言的值)]，按 key 对齐。"""
    return [(v, ref[k]) for k, v in primary.items()
            if isinstance(v, str) and isinstance(ref.get(k), str)]


def ref_words(pairs, term):
    """对照语言里含该术语的条目 -> (英文词投票, 条目数)，只数非虚词、非纯数字的词。"""
    cnt, total = collections.Counter(), 0
    for val, other in pairs:
        if term in val:
            total += 1
            cnt.update(w for w in norm_en(other) if w not in STOPWORDS and not w.isdigit())
    return cnt, total


def mine_anchor_cjk(gram, pairs):
    """中文术语的锚点 -> (英文对应, 票数, 总票数, 来源, 其它)；按 key 对齐对照语言。"""
    term = ''.join(gram)
    if pairs:
        ref, total = ref_words(pairs, term)
        if ref:
            top = ref.most_common(3)
            return top[0][0], top[0][1], total, '对照', top[1:]
    return '', 0, 0, '', []


def memo_anchor(fn):
    """锚点按术语缓存：TSV 和报告都要查一遍，别查两次。"""
    cache = {}

    def anchor(gram):
        if gram not in cache:
            cache[gram] = fn(gram)
        return cache[gram]
    return anchor


def mine_coverage(parsed, rows, max_n):
    """术语表能碰到多少条：显示名里出现任一术语（连续单元序列）即算碰到。"""
    terms = {r['gram'] for r in rows}
    multi = {g for g in terms if len(g) > 1}
    n_all = n_multi = l_all = l_multi = nm_all = nm_multi = 0
    for _, is_name, clauses in parsed:
        hit = hitm = False
        for _, ws in clauses:
            low = [w.lower() for w in ws]
            for n in range(1, min(max_n, len(low)) + 1):
                for i in range(len(low) - n + 1):
                    g = tuple(low[i:i + n])
                    if g in terms:
                        hit = True
                        hitm = hitm or g in multi
        if is_name:
            nm_all += hit
            nm_multi += hitm
        else:
            l_all += hit
            l_multi += hitm
        n_all += hit
        n_multi += hitm
    return {'all': n_all, 'multi': n_multi, 'long': l_all, 'long_multi': l_multi,
            'name': nm_all, 'name_multi': nm_multi}


def fmt_h(v):
    """边界熵/互信息：不设限（两侧都没有真单元邻接）写成 ∞。"""
    return '%.2f' % v if v != math.inf else '∞'


def write_mine_tsv(path, rows, anchor, ns, lang='en'):
    cjk = MINE_LANG[lang]['cjk']
    head = MINE_HEAD_CJK if cjk else MINE_HEAD
    lines = ['# 全文本 n-gram 术语表：%s（语言 %s）' % (ns, MINE_LANG[lang]['label']),
             '\t'.join(head)]
    for r in rows:
        vals = [r['surface'], r['n'], r['freq'], r['long'], r['name'], fmt_h(r['mi']),
                fmt_h(r['hmin'])]
        if cjk:
            vals += list(anchor(r['gram'])[:4])
        vals.append(' '.join(r['example'].split()))
        lines.append('\t'.join(str(x) for x in vals))
    write_text(path, '\n'.join(lines) + '\n')
    return len(rows)


def mine_report(ns, lang_dir, parsed, rows, stats, cov, anchor, top, sec, chars, lang='en'):
    """人看的表：术语 / 影响条目数 / 长文本还是名字 / 例句；CJK 另附对照语言对应名。"""
    cjk = MINE_LANG[lang]['cjk']
    n_name = sum(1 for _, k, _ in parsed if k)
    long_only = sum(1 for r in rows if r['long'] and not r['name'])
    if stats.get('termhood') == 'specificity':
        gate = ('- 候选 n-gram %d 个（≥%d 条目）：术语度用领域特异度（语料频率 ÷ 通用英语频率），'
                '凝聚度 <%.2f 砍 %d、边界熵 <%s 砍 %d（重合 %d）后留 %d 个'
                % (stats['cand'], stats['min_impact'], stats['mi_thr'], stats['bad_mi'],
                   fmt_h(stats['ent_thr']), stats['bad_ent'], stats['both'], stats['pre_sub']))
    else:
        gate = ('- 候选 n-gram %d 个（≥%d 条目）：虚词砍 %d、最小互信息 ≤%.2f（第 %g 百分位）砍 %d、'
                '边界熵 ≤%s（第 %g 百分位）砍 %d（其中 %d 个两侧都没真单元邻接不设限）后留 %d 个'
                % (stats['cand'], stats['min_impact'], stats['stopped'], stats['mi_thr'],
                   stats['pct_coh'], stats['bad_mi'], fmt_h(stats['ent_thr']), stats['pct_ent'],
                   stats['bad_ent'], stats['unconstrained'], stats['pre_sub']))
    lines = ['# 全文本术语挖掘：%s（语言 %s）' % (ns, MINE_LANG[lang]['label']),
             '',
             '- 目录：`%s`' % lang_dir,
             '- 条目 %d 条：名字型 %d / 长文本 %d（长文本 %d 字）'
             % (len(parsed), n_name, len(parsed) - n_name, chars),
             gate,
             '- 只在长文本里出现的术语 %d 个' % long_only,
             '- 术语表能碰到 %d/%d 条（%.1f%%），其中多术语碰到 %d 条（%.1f%%）'
             % (cov['all'], len(parsed), 100.0 * cov['all'] / max(1, len(parsed)),
                cov['multi'], 100.0 * cov['multi'] / max(1, len(parsed))),
             '- 用时：%s' % sec]
    if cjk:
        lines.append('- 窗口偏移还原：并掉 %d 个片段、补进 %d 个带前缀的形式（另有 %d 个疑似片段'
                     '自己也独立出现过，没并）；去掉长超串同频的子串后 %d 个术语'
                     % (len(stats['merged']), len(stats['promote']), len(stats['suspect']),
                        len(rows) + stats['thin']))
        lines.append('- 输出下限：表面长度 ≥ %d 字（`--min-n`），%d 个单字构件不出表；它们仍在 n-gram、'
                     '互信息与边界熵的统计里参与计算' % (stats['min_n'], stats['thin']))
    elif stats.get('termhood') != 'specificity':
        lines.append('- 去掉长超串同频的子串后 %d 个术语' % len(rows))
    head = '| 术语 | 影响条目 | 长文本 | 名字 | 最小互信息 | 最小边界熵 |'
    rule = '|---|---:|---:|---:|---:|---:|'
    if cjk:
        head += ' 英文对应 | 来源 |'
        rule += '---|---|'
    head += ' 例句 |'
    rule += '---|'
    lines += ['', head, rule]
    for r in rows[:top or len(rows)]:
        cells = [r['surface'], r['freq'], r['long'], r['name'],
                 fmt_h(r['mi']), fmt_h(r['hmin'])]
        if cjk:
            ref, v, tot, src, alt = anchor(r['gram'])
            hit = ('%s(%d/%d)' % (ref, v, tot)) if ref else '—'
            if alt:
                hit += ' 其它：' + ' '.join('%s(%d)' % x for x in alt)
            cells += [hit, src or '—']
        cells.append(r['example'].replace('|', '/') or '—')
        lines.append('| ' + ' | '.join(str(c) for c in cells) + ' |')
    return lines


def median_value_len(data):
    """条目值的中位长度：散文语料明显长于名字型列表。"""
    lens = sorted(len(v) for v in data.values() if isinstance(v, str) and v)
    return lens[len(lens) // 2] if lens else 0


def resolve_termhood(termhood, data, lang):
    """auto 按中位条目长度选策略；specificity 只支持 en 且需要 wordfreq。"""
    if termhood == 'auto':
        termhood = 'specificity' if median_value_len(data) >= PROSE_MED_LEN else 'self'
    if termhood == 'specificity':
        if lang != 'en':
            raise SystemExit('术语度 specificity 只支持 en（wordfreq 只有英语频率）')
        if zipf_frequency is None:
            raise SystemExit('术语度 specificity 需要 wordfreq：pip install wordfreq')
    return termhood


def cmd_mine(args):
    t0 = time.time()
    lang = mine_lang_key(args.lang, args.ko_unit)
    spec = MINE_LANG[lang]
    lang_dir = os.path.abspath(args.lang_dir)
    src_path = find_lang_file(lang_dir, spec['file'])
    if not src_path:
        raise SystemExit("缺少 %s.json / %s.lang：%s" % (spec['file'], spec['file'], lang_dir))
    data = load_lang_file(src_path)
    max_n = spec['max_n'] if args.max_n is None else args.max_n
    min_n = spec['min_n'] if args.min_n is None else args.min_n
    ns = os.path.basename(os.path.dirname(lang_dir))
    prefix = args.out or os.path.join(os.getcwd(), ns)
    pairs = []
    if spec['cjk'] and args.ref:
        ref_path = find_lang_file(lang_dir, MINE_LANG[args.ref]['file'])
        if not ref_path:
            raise SystemExit("缺少 %s.json / %s.lang：%s"
                             % (MINE_LANG[args.ref]['file'], MINE_LANG[args.ref]['file'],
                                lang_dir))
        pairs = ref_pairs(data, load_lang_file(ref_path))
    anchor = memo_anchor(lambda g: mine_anchor_cjk(g, pairs)) if spec['cjk'] else None
    parsed = mine_entries(data, max_n, lang)
    termhood = resolve_termhood(args.termhood, data, lang)
    lexicon = SpecLexicon(parsed) if termhood == 'specificity' else None
    rows, stats = mine_terms(parsed, max_n, args.min_impact, args.pct_coh,
                             args.pct_ent, not args.no_entropy, lang, min_n,
                             termhood, lexicon)
    cov = mine_coverage(parsed, rows, max_n)
    t2 = time.time()
    stats.update({'min_impact': args.min_impact, 'pct_coh': args.pct_coh,
                  'pct_ent': args.pct_ent})
    sec = '%.1fs' % (t2 - t0)
    chars = sum(len(spec['join'].join(c for c, _ in cl)) for _, k, cl in parsed if not k)
    tsv_path = prefix + "-mine.tsv"
    md_path = prefix + "-mine.md"
    write_mine_tsv(tsv_path, rows, anchor, ns, lang)
    write_text(md_path, '\n'.join(
        mine_report(ns, lang_dir, parsed, rows, stats, cov, anchor, args.top, sec, chars,
                    lang)) + '\n')
    n_name = sum(1 for _, k, _ in parsed if k)
    summary = {'ns': ns, 'lang_dir': lang_dir, 'lang': args.lang, 'ref': args.ref,
               'ko_unit': args.ko_unit if args.lang == 'ko' else None, 'max_n': max_n,
               'min_n': min_n, 'termhood': termhood,
               'entries': len(parsed), 'name_entries': n_name,
               'long_entries': len(parsed) - n_name, 'long_chars': chars,
               'terms': len(rows), 'terms_multi': sum(1 for r in rows if r['n'] > 1),
               'long_only': sum(1 for r in rows if r['long'] and not r['name']),
               'cand': stats['cand'], 'mi_thr': stats['mi_thr'],
               'ent_thr': None if stats['ent_thr'] == math.inf else stats['ent_thr'],
               'unconstrained': stats['unconstrained'], 'pre_sub': stats['pre_sub'],
               'bad_mi': stats['bad_mi'], 'bad_ent': stats['bad_ent'], 'bad_both': stats['both'],
               'stopped': stats['stopped'], 'thin': stats['thin'],
               'window_merged': len(stats['merged']),
               'window_suspect': len(stats['suspect']),
               'cov': cov, 'sec': round(t2 - t0, 3),
               'tsv': tsv_path, 'md': md_path}
    print(json.dumps(summary, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------- 单语入口 prep


def cmd_prep(args):
    lang_dir = os.path.abspath(args.lang_dir)
    en_path = find_lang_file(lang_dir, "en_us")
    if not en_path:
        raise SystemExit("缺少 en_us.json / en_us.lang：%s" % lang_dir)
    en = load_lang_file(en_path)
    ns = os.path.basename(os.path.dirname(lang_dir))
    prefix = args.out or os.path.join(os.getcwd(), ns)
    target = args.target or default_target(lang_dir)

    # 出口 1：组合骨架 + 待译术语表
    ref = load_lang_file(args.zh) if args.zh else None
    data, stats, terms = build_composition_en(en, target, args.min_group,
                                              args.max_tail, ref)
    skel_path = prefix + "-skeleton.json"
    write_json(skel_path, data)
    terms_path = prefix + "-terms.tsv"
    write_terms_tsv(terms_path, target, terms, stats, ns)

    # 出口 2：一致性词表
    seqs, cnt, slots, items = glossary_inputs(en, args.min_impact)
    gl = mod_header(lang_dir, en, seqs, slots, "译前（无 zh_cn.json）")
    gl += report_glossary(seqs, cnt, slots, args.top, args.min_impact)
    glossary_path = prefix + "-glossary.txt"
    write_text(glossary_path, "\n".join(gl) + "\n")

    # 出口 3：覆盖报告
    coverage_path = prefix + "-coverage.md"
    write_text(coverage_path, "\n".join(
        coverage_lines(ns, lang_dir, en, seqs, slots, items, terms, stats)) + "\n")

    summary = {"lang_dir": lang_dir, "skeleton": skel_path, "terms": terms_path,
               "glossary": glossary_path, "coverage": coverage_path, **stats}
    print(json.dumps(summary, ensure_ascii=False))
    print("填完术语表后组装：python %s mod assemble %s --terms %s -o %s"
          % (sys.argv[0], skel_path, terms_path, ns + "-composition.json"), file=sys.stderr)
    return 0


# ---------------------------------------------------------------- 双语入口 review


def cmd_review(args):
    lang_dir = os.path.abspath(args.lang_dir)
    en, zh, zh_src = load_lang_dir(lang_dir, args.zh)
    if not zh:
        raise SystemExit("review 需要中文：%s 里没有 zh_cn.json，也没有可合并的 packer-policy；"
                         "只有 en_us.json 时用 prep" % lang_dir)
    ns = os.path.basename(os.path.dirname(lang_dir))
    prefix = args.out or os.path.join(os.getcwd(), ns)
    lines = report_review(lang_dir, en, zh, zh_src, ns, args.top, args.min_impact)
    div_path = prefix + "-divergence.md"
    write_text(div_path, "\n".join(lines) + "\n")
    print(json.dumps({"lang_dir": lang_dir, "divergence": div_path,
                      "en": len(en), "zh": len(zh), "zh_source": zh_src},
                     ensure_ascii=False))
    return 0


def cmd_assemble(args):
    skeleton = load_json(args.skeleton)
    table = read_terms_tsv(args.terms)
    data, ast = assemble(skeleton, table, not args.keep_empty)
    out = args.out or os.path.join(
        os.getcwd(), os.path.basename(args.skeleton).replace(
            "-skeleton.json", "-composition.json"))
    write_json(out, data)
    got, conflicts = expand_composition(data)
    print(json.dumps({"out": out, "target": data["target"],
                      "entries": len(data["entries"]), "generated": len(got),
                      "terms_filled": len(table[0]), **ast}, ensure_ascii=False))
    if conflicts:
        print("键冲突 %d 例，例如：%s"
              % (len(conflicts), conflicts[:3]), file=sys.stderr)
    return 0


# ---------------------------------------------------------------- 命令行


def add_common_args(ap):
    ap.add_argument("--top", type=int, default=25, help="每张表最多几行 (0=不限)")
    ap.add_argument("--min-impact", type=int, default=2)


def build_parser():
    ap = argparse.ArgumentParser(
        prog="final.py mod",
        description="模组术语工具：prep 出骨架+术语表+词表+覆盖，"
                    "review 出译法分歧，mine 挖术语")
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("prep", help="只有 en_us.json：组合骨架 + 待译术语表 + 一致性词表 + 覆盖报告")
    p.add_argument("lang_dir", help="含 en_us.json 的 lang 目录")
    p.add_argument("-o", "--out", help="输出前缀（默认 ./<模组名>）")
    p.add_argument("--zh", help="参考中文：定值模板槽位顺序（中文语序）")
    p.add_argument("--target", help="组合文件的 target 字段")
    p.add_argument("--min-group", type=int, default=2, help="一个条目至少几行")
    p.add_argument("--max-tail", type=int, default=2, help="尾部 token 串最大长度")
    add_common_args(p)
    p.set_defaults(func=cmd_prep)

    r = sub.add_parser("review", help="en_us.json + zh_cn.json：本模组译法分歧")
    r.add_argument("lang_dir", help="含 en_us.json（可选 zh_cn.json）的 lang 目录")
    r.add_argument("-o", "--out", help="输出前缀（默认 ./<模组名>）")
    r.add_argument("--zh", help="中文语言文件（覆盖目录里的 zh_cn.json）")
    add_common_args(r)
    r.set_defaults(func=cmd_review)

    a = sub.add_parser("assemble", help="读回填好的术语表，把骨架组装成最终组合文件")
    a.add_argument("skeleton", help="prep 出的 <前缀>-skeleton.json")
    a.add_argument("--terms", required=True, help="填好的 <前缀>-terms.tsv")
    a.add_argument("-o", "--out", help="组合文件输出路径")
    a.add_argument("--keep-empty", action="store_true",
                   help="组装时保留没填中文的参数，不丢弃")
    a.set_defaults(func=cmd_assemble)

    m = sub.add_parser("mine", help="全文本 n-gram 挖术语（含长段落，按影响条目数排序）")
    m.add_argument("lang_dir", help="语言文件所在目录（文件按语言码找：zh -> zh_cn.json）")
    m.add_argument("lang", choices=MINE_LANGS, help="要挖的语言")
    m.add_argument("--ref", choices=MINE_LANGS,
                   help="同一目录里的对照语言，给术语找另一种语言的对应名")
    m.add_argument("-o", "--out", help="输出前缀（默认 ./<模组名>）")
    m.add_argument("--max-n", type=int, default=None,
                   help="候选 n-gram 最大单元数（默认按语言：en/ko 5、zh/ja 8）")
    m.add_argument("--min-n", type=int, default=None,
                   help="输出的最小表面字符数（默认按语言：en 1、zh/ja/ko 2；单字仍参与统计）")
    m.add_argument("--ko-unit", choices=("eojeol", "syllable"), default="eojeol",
                   help="韩语单元：eojeol=按空格切语节（默认）、syllable=按音节")
    m.add_argument("--pct-coh", type=float, default=MINE_PCT_COH,
                   help="凝聚度（最小互信息）阈值取候选分布的第几百分位")
    m.add_argument("--pct-ent", type=float, default=MINE_PCT_ENT,
                   help="边界熵阈值取候选分布的第几百分位")
    m.add_argument("--no-entropy", action="store_true", help="关掉边界熵过滤（对照组）")
    m.add_argument("--termhood", choices=TERMHOODS, default="auto",
                   help="术语度策略：auto 按中位条目长度选（默认），self 取候选分布的分位数，"
                        "specificity 用通用英语频率参照（只支持 en，需 wordfreq）")
    add_common_args(m)
    m.set_defaults(func=cmd_mine, top=300)
    return ap


def main(argv=None):
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "cmd", None):
        ap.print_help()
        return 2
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
