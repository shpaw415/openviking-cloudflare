// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from '../http.js'

export const robotsDenied = () => new ApiError(403, 'ROBOTS_DENIED', 'The approved site policy does not permit this document.')
type Rule = { path: string; exact: boolean; allow: boolean }
type Group = { agents: string[]; rules: Rule[]; unsupported: boolean; started: boolean }

/** A deliberately small, fail-closed REP subset for the canonical ASCII paths
 * accepted by the catalogue. Unsupported rules in the applicable group are
 * not ignored (including wildcard paths, percent escapes and crawl-delay). */
export function robotsPolicy(text: string): (path: string) => boolean {
  const groups: Group[] = []
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.split('#', 1)[0].trim()
    if (!line) continue
    const field = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line)
    if (!field) throw robotsDenied()
    const key = field[1].toLowerCase(), value = field[2].trim()
    let group = groups.at(-1)
    if (key === 'user-agent') {
      if (!/^(?:\*|[a-z][a-z0-9_-]{0,63})$/i.test(value) || groups.length >= 128) throw robotsDenied()
      if (!group || group.started) groups.push(group = { agents: [], rules: [], unsupported: false, started: false })
      group.agents.push(value.toLowerCase())
    } else if (key === 'allow' || key === 'disallow' || key === 'crawl-delay') {
      if (!group) throw robotsDenied()
      group.started = true
      if ((!value && key !== 'crawl-delay') || (key === 'crawl-delay' && value === '0')) continue
      if (key === 'crawl-delay' || !/^\/[A-Za-z0-9._/-]{0,998}\$?$/.test(value) || group.rules.length >= 128) {
        group.unsupported = true
        continue
      }
      const exact = value.endsWith('$')
      group.rules.push({ path: exact ? value.slice(0, -1) : value, exact, allow: key === 'allow' })
    }
    // Sitemap and unfamiliar, non-policy fields never introduce destinations.
  }
  const named = groups.filter(group => group.agents.includes('openvikingedgeimport'))
  const active = named.length ? named : groups.filter(group => group.agents.includes('*'))
  if (active.some(group => group.unsupported)) throw robotsDenied()
  const rules = active.flatMap(group => group.rules).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow))
  return path => rules.find(rule => rule.exact ? path === rule.path : path.startsWith(rule.path))?.allow ?? true
}
