const path = require('node:path')
const { chmodSync } = require('node:fs')

exports.default = async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return

  chmodSync(path.join(context.appDir, 'resources', 'pnpm-bin', 'pnpm'), 0o755)
}
