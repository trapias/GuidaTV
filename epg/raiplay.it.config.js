const upstream = require('./upstream.js')

const categories = new Map([
  ['Film', 'Film'],
  ['SerieTV', 'Serie TV'],
  ['Fiction', 'Fiction'],
])

module.exports = {
  ...upstream,
  parser(context) {
    const { events } = JSON.parse(context.content)
    const categoriesByProgramme = new Map((events || []).map(event => [
      `${event.hour?.slice(0, 5)} ${event.name}`,
      categories.get(event.dfp?.escaped_typology_name),
    ]))
    return upstream.parser(context).map(programme => {
      const category = categoriesByProgramme.get(`${programme.start.format('HH:mm')} ${programme.title}`)
      return category ? { ...programme, category } : programme
    })
  },
}
