interface Segment {
  type: 'equal' | 'insert' | 'delete'
  text: string
  /** Sentence-path non-whitespace change units get inline-block spacing. */
  block?: boolean
}

// Longest-common-subsequence diff over equal-comparable tokens. Returns a
// minimal equal / delete / insert segment list (no merging of runs).
function lcsDiff(a: string[], b: string[]): Segment[] {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const out: Segment[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      out.push({ type: 'equal', text: a[i - 1] })
      i--
      j--
    } else if (i > 0 && (j === 0 || dp[i - 1][j] >= dp[i][j - 1])) {
      out.push({ type: 'delete', text: a[i - 1] })
      i--
    } else {
      out.push({ type: 'insert', text: b[j - 1] })
      j--
    }
  }
  return out.reverse()
}

// Count maximal contiguous runs of non-equal segments that contain at least
// one non-whitespace character. Pure-whitespace change runs don't count.
function countChangeRuns(segs: Segment[]): number {
  let count = 0
  let inRun = false
  let runHasNonWs = false
  for (const seg of segs) {
    if (seg.type === 'equal') {
      if (inRun) {
        if (runHasNonWs) count++
        inRun = false
        runHasNonWs = false
      }
    } else {
      inRun = true
      if (/\S/.test(seg.text)) runHasNonWs = true
    }
  }
  if (inRun && runHasNonWs) count++
  return count
}

// 先红后绿: within each contiguous change run, emit all deletes (in order)
// then all inserts (in order). Equal segments pass through unchanged.
function reorderRedThenGreen(segs: Segment[]): Segment[] {
  const out: Segment[] = []
  let i = 0
  while (i < segs.length) {
    if (segs[i].type === 'equal') {
      out.push(segs[i])
      i++
      continue
    }
    const run: Segment[] = []
    while (i < segs.length && segs[i].type !== 'equal') {
      run.push(segs[i])
      i++
    }
    for (const s of run) if (s.type === 'delete') out.push(s)
    for (const s of run) if (s.type === 'insert') out.push(s)
  }
  return out
}

// Fine tokenizer: chars when the pair is short and whitespace-free (or short
// dense CJK), otherwise words via /(\s+|\S+)/g.
function tokenizeFine(a: string, b: string): { tokA: string[]; tokB: string[] } {
  const combined = a.length + b.length
  if (combined === 0) return { tokA: [], tokB: [] }
  const hasWhitespace = /\s/.test(a) || /\s/.test(b)
  const cjkChars = (a + b).match(/[一-鿿]/g)?.length ?? 0
  const shortDenseCJK = combined < 80 && cjkChars / combined > 0.5
  if ((combined < 50 && !hasWhitespace) || shortDenseCJK) {
    return { tokA: [...a], tokB: [...b] }
  }
  const WORD_RE = /(\s+|\S+)/g
  return {
    tokA: a.match(WORD_RE) ?? [],
    tokB: b.match(WORD_RE) ?? [],
  }
}

// Sentence tokenizer: content units ending in optional terminal punct plus
// optional closing quote/bracket, OR whitespace runs as separators. Whitespace
// is kept as its own token so LCS can align spaces as equal.
const SENTENCE_TOKEN_RE = /[^\s.!?。！？…]+[.!?。！？…]?["')\]】〉》』」）］｝]*|\s+/g
function tokenizeSentence(text: string): string[] {
  return text.match(SENTENCE_TOKEN_RE) ?? [text]
}

// Diff a single aligned line pair. Fine word/char path when there is at most
// one non-trivial change run; otherwise degrade to sentence-level units.
function diffLine(oldLine: string, newLine: string): Segment[] {
  const { tokA, tokB } = tokenizeFine(oldLine, newLine)
  const fineSegs = lcsDiff(tokA, tokB)

  if (countChangeRuns(fineSegs) <= 1) {
    return reorderRedThenGreen(fineSegs).map((s) => {
      if (s.type !== 'equal' && /\S/.test(s.text)) {
        return { ...s, block: true }
      }
      return s
    })
  }

  // Degrade to sentence-level for the whole line.
  const sTokA = tokenizeSentence(oldLine)
  const sTokB = tokenizeSentence(newLine)
  const sSegs = lcsDiff(sTokA, sTokB)
  return reorderRedThenGreen(sSegs).map((s) => {
    if (s.type !== 'equal' && /\S/.test(s.text)) {
      return { ...s, block: true }
    }
    return s
  })
}

// Line-first diff: split on \n, align lines (LCS on line strings when lengths
// differ, else pair by index), diff each pair, and emit \n equal separators
// between lines (preserved by whitespace-pre-wrap on the outer span).
export function diffText(oldText: string, newText: string): Segment[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  let aligned: [string | null, string | null][]
  if (oldLines.length === newLines.length) {
    aligned = oldLines.map((l, i) => [l, newLines[i]])
  } else {
    aligned = []
    for (const seg of lcsDiff(oldLines, newLines)) {
      if (seg.type === 'equal') aligned.push([seg.text, seg.text])
      else if (seg.type === 'delete') aligned.push([seg.text, null])
      else aligned.push([null, seg.text])
    }
  }

  const out: Segment[] = []
  for (let k = 0; k < aligned.length; k++) {
    const [oL, nL] = aligned[k]
    if (oL !== null && nL !== null) {
      if (oL === nL) {
        out.push({ type: 'equal', text: oL })
      } else {
        out.push(...diffLine(oL, nL))
      }
    } else if (oL !== null) {
      out.push({ type: 'delete', text: oL })
    } else if (nL !== null) {
      out.push({ type: 'insert', text: nL })
    }
    if (k < aligned.length - 1) {
      out.push({ type: 'equal', text: '\n' })
    }
  }
  return out
}

export interface InlineModifiedProps {
  oldValue: string
  newValue: string
}

export function InlineModified({ oldValue, newValue }: InlineModifiedProps) {
  const oldEmpty = oldValue === ''
  const newEmpty = newValue === ''
  if (oldEmpty && newEmpty) {
    return <span className="text-sm text-slate-400">-</span>
  }
  if (oldEmpty) {
    return (
      <span className="text-sm bg-green-100 dark:bg-green-950/40 text-green-700 dark:text-green-300 rounded px-0.5 whitespace-pre-wrap break-words">
        {newValue}
      </span>
    )
  }
  if (newEmpty) {
    return (
      <span className="text-sm bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300 rounded px-0.5 whitespace-pre-wrap break-words">
        {oldValue}
      </span>
    )
  }

  const segs = diffText(oldValue, newValue)

  return (
    <span className="whitespace-pre-wrap break-words">
      {segs.map((seg, i) => {
        if (seg.type === 'equal') {
          return (
            <span key={i} className="text-sm text-slate-700 dark:text-slate-300">
              {seg.text}
            </span>
          )
        }
        if (seg.type === 'delete') {
          return (
            <span
              key={i}
              className={`text-sm bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300 rounded px-0.5${seg.block ? ' inline-block mr-0.5' : ''}`}
            >
              {seg.text}
            </span>
          )
        }
        return (
          <span
            key={i}
            className={`text-sm bg-green-100 dark:bg-green-950/40 text-green-700 dark:text-green-300 rounded px-0.5${seg.block ? ' inline-block mr-0.5' : ''}`}
          >
            {seg.text}
          </span>
        )
      })}
    </span>
  )
}
