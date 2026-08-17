import { spawnSync } from 'node:child_process'

const pathMarker = '__DEEPSEEK_HARNESS_DESKTOP_PATH__='
let cachedMacOsPath: string | undefined
let didResolveMacOsPath = false

function resolveMacOsLoginPath(baseEnvironment: NodeJS.ProcessEnv): string | undefined {
  if (didResolveMacOsPath) return cachedMacOsPath
  didResolveMacOsPath = true

  const shell = baseEnvironment.SHELL || '/bin/zsh'
  const result = spawnSync(
    shell,
    ['-ilc', `printf '\\n${pathMarker}%s\\n' "$PATH"`],
    {
      encoding: 'utf8',
      env: baseEnvironment,
      timeout: 5_000,
      windowsHide: true
    }
  )
  cachedMacOsPath = result.stdout
    ?.split(/\r?\n/)
    .find((line) => line.startsWith(pathMarker))
    ?.slice(pathMarker.length)
  return cachedMacOsPath
}

export function commandEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment }
  if (process.platform !== 'darwin') return environment

  const loginPath = resolveMacOsLoginPath(baseEnvironment)
  if (!loginPath) return environment

  for (const name of Object.keys(environment)) {
    if (name.toLowerCase() === 'path') delete environment[name]
  }
  environment.PATH = loginPath
  return environment
}
