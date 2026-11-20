const upstream = require('./upstream.js')

module.exports = {
  ...upstream,
  parser(context) {
    const data = JSON.parse(context.content)
    for (const { program } of data.response?.entries?.[0]?.listings || []) {
      if (!program) continue
      const genre = program['mediasetprogram$skyGenre']
      const subgenre = program['mediasetprogram$skySubGenre']
      if (program.programType === 'movie') program['mediasetprogram$skyGenre'] = 'Film'
      else if (/^(fiction|telefilm|sit[ -]?com|soap opera|serie tv|notiziario)$/i.test(subgenre || '')) {
        program['mediasetprogram$skyGenre'] = genre ? `${genre}/${subgenre}` : subgenre
      }
    }
    return upstream.parser({ ...context, content: JSON.stringify(data) })
  },
}
