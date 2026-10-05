// The burn chart as rows of colored runs: bars in eighth blocks, the burn
// limit as a dotted line behind them, a baseline under everything.

export type Tone = 'calm' | 'warm' | 'hot' | 'axis' | 'limit' | 'blank'
export type Run = { text: string; tone: Tone }

const EIGHTHS = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

export const chartRows = (
  series: readonly number[],
  limit: number,
  height: number,
): { rows: Run[][]; scale: number; limitRow: number } => {
  const peak = Math.max(0, ...series)
  const scale = Math.max(peak * 1.1, limit * 1.25, 0.01)
  const levels = height * 8
  const limitLevel = Math.min(levels, Math.max(1, Math.round((limit / scale) * levels)))
  const limitRow = height - 1 - Math.floor((limitLevel - 1) / 8)

  const columns = series.map(v => ({
    level: v > 0 ? Math.max(1, Math.round((v / scale) * levels)) : 0,
    tone: (v > limit ? 'hot' : v > limit * 0.6 ? 'warm' : 'calm') as Tone,
  }))

  const rows: Run[][] = []
  for (let r = 0; r < height; r++) {
    const floor = (height - 1 - r) * 8
    const runs: Run[] = []
    const put = (text: string, tone: Tone) => {
      const last = runs[runs.length - 1]
      if (last && last.tone === tone) runs[runs.length - 1] = { text: last.text + text, tone }
      else runs.push({ text, tone })
    }
    for (const c of columns) {
      const fill = Math.min(8, Math.max(0, c.level - floor))
      if (fill > 0) put(EIGHTHS[fill] ?? '█', c.tone)
      else if (r === limitRow) put('┈', 'limit')
      else if (r === height - 1) put('▁', 'axis')
      else put(' ', 'blank')
    }
    rows.push(runs)
  }
  return { rows, scale, limitRow }
}
