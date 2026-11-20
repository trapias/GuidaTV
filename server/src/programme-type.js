const SERIES = /(?:^|\/)\s*(?:serie\s*tv|fiction|telefilm|sit[ -]?com|soap opera|miniserie)\s*(?:\/|$)/i
const BULLETIN = /(?:^|\/)\s*(?:notiziario|telegiornale)\s*(?:\/|$)/i
const BULLETIN_TITLE = /^(?:telegiornale|rai parlamento telegiornale|rainews24|rtv news|tg san marino|tg sport|prima pagina tg5|tgcom24(?: diretta(?:[ -].*)?)?|studio aperto(?: live| - la giornata)?|tg\s*la\s*7(?: notte| ore \d{1,2}[.:]\d{2})?)$/i
const EDITION_TITLE = /^tg\s*[1-5](?:\s*(?:[-–]\s*)?(?:l\.?\s*i\.?\s*s\.?|flash|giorno|sera|notte|ultima ora (?:mattina|notte)|prima pagina|speciale|linea notte|(?:ore\s+)?\d{1,2}(?:[.:]\d{2})?))?$/i
const REGIONAL_TITLE = /^(?:tgr|tg regione)(?: buon(?:giorno|asera) (?:italia|regione)| l\.?\s*i\.?\s*s\.?)?$/i
const RAI_NEWS_EDITION = /(?:^|[+ ])tg (?:notte|alba|primo giorno|giorno|sera|edizione principale|breve|lis|in inglese|ucraino)\b/i

export function programmeType(channelId, title, categories) {
  if (categories.some(category => /^(?:film(?: tv)?|movie)\s*(?:\/|$)/i.test(category))) return 'movie'
  if (categories.some(category => SERIES.test(category))) return 'series'

  if (/\bmeteo\b/i.test(title)) return null
  if (categories.some(category => BULLETIN.test(category))) return 'news'
  if (BULLETIN_TITLE.test(title) || EDITION_TITLE.test(title) || REGIONAL_TITLE.test(title)) return 'news'
  if (channelId === 'rainews24' && RAI_NEWS_EDITION.test(title)) return 'news'
  return null
}
