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

// Braille charts: each cell is two dots wide and four tall, so a chart gets
// twice the columns and four times the rows of a block chart in the same
// space. A cell is filled from the bottom up to each of its two samples.
const DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const

export type Cell = { char: string | null; value: number }

export const brailleArea = (series: readonly number[], height: number, scale: number): Cell[][] => {
  const levels = height * 4
  const top = Math.max(scale, 1e-9)
  const level = series.map(v => (v > 0 ? Math.max(1, Math.min(levels, Math.round((v / top) * levels))) : 0))
  const width = Math.ceil(series.length / 2)
  const rows: Cell[][] = []
  for (let r = 0; r < height; r++) {
    const cells: Cell[] = []
    for (let c = 0; c < width; c++) {
      let bits = 0
      for (let side = 0; side < 2; side++) {
        const l = level[2 * c + side] ?? 0
        for (let d = 0; d < 4; d++) {
          const fromBottom = (height - 1 - r) * 4 + (3 - d) + 1
          if (l >= fromBottom) bits |= DOTS[side]![d]!
        }
      }
      const value = Math.max(series[2 * c] ?? 0, series[2 * c + 1] ?? 0)
      cells.push({ char: bits === 0 ? null : String.fromCharCode(0x2800 + bits), value })
    }
    rows.push(cells)
  }
  return rows
}

// A one line braille sparkline, scaled to its own peak.
export const sparkline = (series: readonly number[]): string => {
  const peak = Math.max(0, ...series)
  const [row] = brailleArea(series, 1, peak)
  return (row ?? []).map(c => c.char ?? '⣀').join('')
}
