/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import type { TOptions } from 'i18next'

import { toIntlLocale } from '@/i18n/languages'

import { flattenBinary } from './display'
import { compileBillingExpression } from './parser'
import { TIME_FUNCTIONS, type ExpressionNode, type TimeFunction } from './types'

type Translate = (key: string, options?: TOptions) => string
type Description = {
  text: string
  kind: 'calendar' | 'clock' | 'combined' | 'dates'
  timezone: string
  disjunction?: boolean
  // Peak windows that exclude a date list. The complement names weekends and
  // those dates instead of saying "outside ... except", which reads as if the
  // dates were removed from the off-peak period.
  exceptDates?: { window: string; dates: string }
}
type TimeComparison = {
  name: TimeFunction
  timezone: string
  operator: string
  value: number
}
const DOMAINS: Record<TimeFunction, [number, number]> = {
  hour: [0, 24],
  minute: [0, 60],
  weekday: [0, 7],
  month: [1, 13],
  day: [1, 32],
  year: [1, 10000],
}

function timeCall(
  node: ExpressionNode,
  name: TimeFunction
): { timezone: string } | null {
  if (
    node.kind !== 'call' ||
    node.name !== name ||
    node.args.length !== 1 ||
    node.args[0].kind !== 'literal' ||
    typeof node.args[0].value !== 'string'
  ) {
    return null
  }
  return { timezone: node.args[0].value.trim() || 'UTC' }
}

function sameZoneBound(
  node: ExpressionNode,
  name: 'month' | 'day' | 'year',
  timezone: string
): { operator: string; value: number } | null {
  if (
    node.kind !== 'binary' ||
    node.left.kind !== 'call' ||
    node.right.kind !== 'literal' ||
    typeof node.right.value !== 'number' ||
    !Number.isInteger(node.right.value)
  ) {
    return null
  }
  const call = timeCall(node.left, name)
  if (!call || call.timezone !== timezone) return null
  return { operator: node.operator, value: node.right.value }
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function monthDaySpan(
  node: ExpressionNode,
  timezone: string
): { month: number; start: number; end: number } | null {
  let month: number | null = null
  let start = 1
  let end = 31
  let sawDay = false
  for (const part of flattenBinary(node, '&&')) {
    const monthBound = sameZoneBound(part, 'month', timezone)
    if (monthBound) {
      if (
        monthBound.operator !== '==' ||
        month !== null ||
        monthBound.value < 1 ||
        monthBound.value > 12
      ) {
        return null
      }
      month = monthBound.value
      continue
    }
    const dayBound = sameZoneBound(part, 'day', timezone)
    if (!dayBound) return null
    sawDay = true
    switch (dayBound.operator) {
      case '==':
        start = Math.max(start, dayBound.value)
        end = Math.min(end, dayBound.value)
        break
      case '>=':
        start = Math.max(start, dayBound.value)
        break
      case '>':
        start = Math.max(start, dayBound.value + 1)
        break
      case '<=':
        end = Math.min(end, dayBound.value)
        break
      case '<':
        end = Math.min(end, dayBound.value - 1)
        break
      default:
        return null
    }
  }
  if (month === null || !sawDay || start > end || start < 1 || end > 31) {
    return null
  }
  return { month, start, end }
}

/** A year conjoined with month/day spans, such as the 2027 holiday list. */
function statutoryDates(
  node: ExpressionNode
): { timezone: string; dates: string } | null {
  const parts = flattenBinary(node, '&&')
  if (parts.length !== 2) return null
  const yearPart = parts.find(
    (part) =>
      part.kind === 'binary' &&
      part.operator === '==' &&
      part.left.kind === 'call' &&
      part.left.name === 'year'
  )
  const rest = parts.find((part) => part !== yearPart)
  if (!yearPart || !rest || yearPart.kind !== 'binary') return null
  const call = timeCall(yearPart.left, 'year')
  if (
    !call ||
    yearPart.right.kind !== 'literal' ||
    typeof yearPart.right.value !== 'number' ||
    !Number.isInteger(yearPart.right.value) ||
    yearPart.right.value < 1 ||
    yearPart.right.value > 9999
  ) {
    return null
  }
  const year = yearPart.right.value
  const spans: string[] = []
  for (const clause of flattenBinary(rest, '||')) {
    const span = monthDaySpan(clause, call.timezone)
    if (!span) return null
    const start = isoDate(year, span.month, span.start)
    const end = isoDate(year, span.month, span.end)
    spans.push(start === end ? start : `${start}–${end}`)
  }
  if (spans.length === 0) return null
  return { timezone: call.timezone, dates: spans.join(', ') }
}

function timeComparison(node: ExpressionNode): TimeComparison | null {
  if (
    node.kind !== 'binary' ||
    !['==', '>=', '>', '<=', '<'].includes(node.operator) ||
    node.left.kind !== 'call' ||
    !(TIME_FUNCTIONS as readonly string[]).includes(node.left.name) ||
    node.left.args[0].kind !== 'literal' ||
    typeof node.left.args[0].value !== 'string' ||
    node.right.kind !== 'literal' ||
    typeof node.right.value !== 'number' ||
    !Number.isInteger(node.right.value)
  ) {
    return null
  }
  return {
    name: node.left.name as TimeFunction,
    timezone: node.left.args[0].value.trim() || 'UTC',
    operator: node.operator,
    value: node.right.value,
  }
}

function describeTimeRange(
  comparisons: TimeComparison[],
  t: Translate,
  locale: string
): Description | null {
  const first = comparisons[0]
  let [start, end] = DOMAINS[first.name]
  for (const comparison of comparisons) {
    switch (comparison.operator) {
      case '>=':
        start = Math.max(start, comparison.value)
        break
      case '>':
        start = Math.max(start, comparison.value + 1)
        break
      case '<':
        end = Math.min(end, comparison.value)
        break
      case '<=':
        end = Math.min(end, comparison.value + 1)
        break
      case '==':
        start = Math.max(start, comparison.value)
        end = Math.min(end, comparison.value + 1)
        break
    }
  }
  if (start >= end) return null
  let text: string
  let kind: Description['kind'] = 'calendar'
  if (first.name === 'hour') {
    kind = 'clock'
    text = t('{{start}}–{{end}}', {
      start: `${String(start).padStart(2, '0')}:00`,
      end: `${String(end).padStart(2, '0')}:00`,
    })
  } else if (first.name === 'weekday') {
    const formatter = new Intl.DateTimeFormat(toIntlLocale(locale), {
      weekday: 'short',
      timeZone: 'UTC',
    })
    // 2026-01-04 is Sunday, matching Go's weekday numbering.
    const from = formatter.format(new Date(Date.UTC(2026, 0, 4 + start)))
    const to = formatter.format(new Date(Date.UTC(2026, 0, 4 + end - 1)))
    text =
      start === end - 1
        ? from
        : t('{{start}}–{{end}}', { start: from, end: to })
  } else {
    const labels: Record<string, string> = {
      minute: 'Minute',
      month: 'Month',
      day: 'Day',
      year: 'Calendar year',
    }
    const values =
      start === end - 1
        ? String(start)
        : t('{{start}}–{{end}}', { start, end: end - 1 })
    text = `${t(labels[first.name])}: ${values}`
  }
  return { text, kind, timezone: first.timezone }
}

function describeBillingCondition(
  node: ExpressionNode,
  t: Translate,
  locale: string
): Description | null {
  if (node.kind === 'unary' && node.operator === '!') {
    const holiday = statutoryDates(node.operand)
    if (holiday) {
      return { text: holiday.dates, kind: 'dates', timezone: holiday.timezone }
    }
    const description = describeBillingCondition(node.operand, t, locale)
    if (!description) return null
    if (description.exceptDates) {
      return {
        text: t('All other times, including weekends and {{dates}}', {
          dates: description.exceptDates.dates,
        }),
        kind: 'combined',
        timezone: description.timezone,
      }
    }
    return {
      ...description,
      text: t('Outside these times: {{condition}}', {
        condition: description.text,
      }),
      kind: 'combined',
      exceptDates: undefined,
    }
  }
  if (
    node.kind === 'binary' &&
    ['<', '<=', '>', '>=', '==', '!='].includes(node.operator) &&
    node.left.kind === 'variable' &&
    node.right.kind === 'literal' &&
    typeof node.right.value === 'number'
  ) {
    const labels: Record<string, string> = {
      p: 'Input',
      c: 'Output',
      len: 'Full input length',
    }
    const label = labels[node.left.name]
    if (!label) return null
    return {
      text: `${t(label)} ${node.operator} ${node.right.value.toLocaleString(toIntlLocale(locale))}`,
      kind: 'combined',
      timezone: '',
    }
  }
  const single = timeComparison(node)
  if (single) return describeTimeRange([single], t, locale)
  if (node.kind !== 'binary' || !['&&', '||'].includes(node.operator)) {
    return null
  }
  const nodes = flattenBinary(node, node.operator)
  const parts: Description[] = []
  if (node.operator === '&&') {
    const ranges = new Map<string, TimeComparison[]>()
    for (const part of nodes) {
      const comparison = timeComparison(part)
      if (comparison) {
        const key = `${comparison.name}:${comparison.timezone}`
        const range = ranges.get(key) ?? []
        range.push(comparison)
        ranges.set(key, range)
      } else {
        const description = describeBillingCondition(part, t, locale)
        if (!description) return null
        parts.push(description)
      }
    }
    for (const range of ranges.values()) {
      const description = describeTimeRange(range, t, locale)
      if (!description) return null
      parts.push(description)
    }
  } else {
    for (const part of nodes) {
      const description = describeBillingCondition(part, t, locale)
      if (!description) return null
      parts.push(description)
    }
  }
  const zones = [...new Set(parts.map((part) => part.timezone).filter(Boolean))]
  if (parts.length === 0 || zones.length > 1) return null
  const timezone = zones[0] ?? ''
  if (parts.length === 1) return parts[0]
  const calendars = parts.filter((part) => part.kind === 'calendar')
  const clocks = parts.filter((part) => part.kind === 'clock')
  const dateLists = parts.filter((part) => part.kind === 'dates')
  if (
    node.operator === '&&' &&
    parts.length === 3 &&
    calendars.length === 1 &&
    clocks.length === 1 &&
    dateLists.length === 1
  ) {
    const window = `${calendars[0].text} ${clocks[0].text}`
    const dates = dateLists[0].text
    return {
      text: t('{{window}}, except {{dates}}', { window, dates }),
      kind: 'combined',
      timezone,
      exceptDates: { window, dates },
    }
  }
  if (
    node.operator === '&&' &&
    parts.length === 2 &&
    calendars.length === 1 &&
    clocks.length === 1
  ) {
    return {
      text: `${calendars[0].text} ${clocks[0].text}`,
      kind: 'combined',
      timezone: parts[0].timezone,
    }
  }
  const separator =
    node.operator === '&&'
      ? '{{first}} and {{second}}'
      : '{{first}} or {{second}}'
  let text =
    node.operator === '&&' && parts[0].disjunction
      ? `(${parts[0].text})`
      : parts[0].text
  for (const part of parts.slice(1)) {
    const second =
      node.operator === '&&' && part.disjunction ? `(${part.text})` : part.text
    text = t(separator, { first: text, second })
  }
  return {
    text,
    kind: clocks.length === parts.length ? 'clock' : 'combined',
    timezone,
    disjunction: node.operator === '||',
  }
}

/** Presentation only. Unknown conditions retain their source; this never changes tier selection. */
export function formatBillingCondition(
  source: string,
  t: Translate,
  locale = 'en'
): string | null {
  const compiled = compileBillingExpression(source)
  if (compiled.status !== 'ready') return null
  try {
    // The returned value is rendered as React text, never as HTML.
    const translate: Translate = (key, options) =>
      t(key, { ...options, interpolation: { escapeValue: false } })
    const description = describeBillingCondition(
      compiled.ast,
      translate,
      locale
    )
    if (!description) return null
    if (!description.timezone) return description.text
    return translate('{{condition}} ({{timezone}})', {
      condition: description.text,
      timezone: description.timezone,
    })
  } catch {
    return null
  }
}
