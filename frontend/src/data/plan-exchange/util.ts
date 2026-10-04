import type { PlanContent } from './types'

const CONTENT_FIELDS: (keyof PlanContent)[] = ['方案名称', '适用范围', '监测项目', '测次安排']

export function nowText(): string {
  const now = new Date()
  const time = now.toTimeString().slice(0, 8)
  return `${todayText()} ${time}`
}

export function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 稳定校验和：同一附件内容重复上传只识别为一个版本。 */
export function contentChecksum(content: PlanContent): string {
  const text = CONTENT_FIELDS.map((field) => content[field].trim()).join('|')
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33 + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function sameContent(a: PlanContent, b: PlanContent): boolean {
  return contentChecksum(a) === contentChecksum(b)
}

/** 解析一行 CSV，支持引号包裹与转义双引号；返回字段顺序数组。 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell.trim())
  return cells
}

export type ParsedCsv = {
  headers: string[]
  rows: Record<string, string>[]
}

/** 附件清单解析：表头缺列直接报错（连失败行都无法定位），其余逐行校验。 */
export function parseCsv(text: string): ParsedCsv {
  const normalized = text.replace(/^﻿/, '')
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) {
    return { headers: [], rows: [] }
  }
  const headers = parseCsvLine(lines[0]).map((header) => header.replace(/^﻿/, '').trim())
  const rows = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line)
    const row: Record<string, string> = {}
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? ''
    })
    return row
  })
  return { headers, rows }
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function toCsv(headers: string[], rows: Record<string, string>[]): string {
  const lines = [headers.map(csvEscape).join(',')]
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(String(row[header] ?? ''))).join(','))
  }
  return `﻿${lines.join('\n')}`
}

export function downloadTextFile(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 在原文件名基础上加时间戳后缀，便于区分每次导出的方案包。 */
export function stampedName(base: string, ext: string): string {
  return `${base}-${todayText()}.${ext}`
}
