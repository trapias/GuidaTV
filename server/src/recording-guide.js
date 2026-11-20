const MOVEMENT_WINDOW = 3 * 60 * 60000
export const titleKey = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()

export function guideChange(row, programmes, now) {
  if (row.status !== 'scheduled' || row.kind !== 'guide' || row.end <= now || !programmes?.length) return null
  const sameTitle = p => titleKey(p.t) === titleKey(row.title)
  const original = programmes.find(p => p.s === row.start)
  if (original && sameTitle(original) && (!row.episode || !original.episode || original.episode === row.episode)) {
    return original.e === row.end || original.e <= now ? null : { s: original.s, e: original.e }
  }
  const candidates = programmes.filter(p => p.e > now && Math.abs(p.s - row.start) <= MOVEMENT_WINDOW &&
    sameTitle(p) && (row.episode ? p.episode === row.episode : !row.subtitle || titleKey(p.sub || '') === titleKey(row.subtitle)))
  return candidates.length === 1 ? { s: candidates[0].s, e: candidates[0].e } : null
}
