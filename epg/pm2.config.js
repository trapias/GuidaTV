module.exports = {
  apps: [
    { name: 'epg', script: 'refresh.mjs' },
    { name: 'cron', script: './node_modules/.bin/chronos',
      args: ['-e', 'node refresh.mjs request', '-p', process.env.CRON_SCHEDULE, '-l'] },
  ],
}
