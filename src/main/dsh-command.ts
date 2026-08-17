import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { DshInstallation } from './dsh-service'
import { commandEnvironment } from './command-environment'

type OutputLine = (line: string) => void

export interface DshCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface DshCommandOptions {
  timeoutMs?: number
  environment?: Readonly<Record<string, string>>
  removeEnvironment?: readonly string[]
  prependPath?: readonly string[]
}

const runnerSource = String.raw`
import { pathToFileURL } from 'node:url';
const entryPath = process.env.DEEPSEEK_HARNESS_DESKTOP_DSH_ENTRY;
if (!entryPath) throw new Error('Missing DSH entry path');
const appArgs = process.argv.slice(1);
process.argv = [process.execPath, entryPath, ...appArgs];
process.on('message', (message) => {
  if (message && message.type === 'deepseek-harness-desktop:shutdown') {
    process.emit('SIGTERM', 'SIGTERM');
  }
});
await import(pathToFileURL(entryPath).href);
`

function displayArgument(argument: string): string {
  return /^[a-zA-Z0-9@._+/:=#-]+$/.test(argument) ? argument : JSON.stringify(argument)
}

export function buildDshCommandEnvironment(
  installation: DshInstallation,
  options: Pick<DshCommandOptions, 'environment' | 'removeEnvironment' | 'prependPath'> = {},
  baseEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment }
  for (const name of options.removeEnvironment ?? []) delete environment[name]
  Object.assign(environment, options.environment)
  if (options.prependPath?.length) {
    const pathKeys = Object.keys(environment).filter((name) => name.toLowerCase() === 'path')
    const inheritedPath = pathKeys.map((name) => environment[name]).find(Boolean)
    pathKeys.forEach((name) => delete environment[name])
    environment.PATH = [...options.prependPath, inheritedPath].filter(Boolean).join(path.delimiter)
  }
  environment.DEEPSEEK_HARNESS_DESKTOP_DSH_ENTRY = installation.entryPath
  return environment
}

export function spawnDshCommand(
  installation: DshInstallation,
  args: string[],
  workingDirectory: string,
  onLine?: OutputLine,
  options: Pick<DshCommandOptions, 'environment' | 'removeEnvironment' | 'prependPath'> = {}
): ChildProcess {
  onLine?.(`$ dsh ${args.map(displayArgument).join(' ')}`)
  const environment = buildDshCommandEnvironment(installation, options, commandEnvironment())
  const child = spawn(
    installation.nodePath ?? 'node',
    ['--input-type=module', '--eval', runnerSource, '--', ...args],
    {
      cwd: workingDirectory,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )

  child.once('spawn', () => onLine?.(`[进程] DSH 子进程已创建：pid=${child.pid ?? '未知'}`))
  child.once('exit', (exitCode, signal) => {
    onLine?.(`[进程] DSH 子进程结束：退出码=${exitCode ?? '未知'}，信号=${signal ?? '无'}`)
  })
  return child
}

function bindOutput(
  child: ChildProcess,
  onChunk: (stream: 'stdout' | 'stderr', text: string) => void,
  onLine?: OutputLine
): void {
  const bind = (stream: NodeJS.ReadableStream | null, streamName: 'stdout' | 'stderr'): void => {
    let remainder = ''
    stream?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      onChunk(streamName, text)
      remainder += text
      const lines = remainder.split(/\r?\n/)
      remainder = lines.pop() ?? ''
      lines.forEach((line) => line.trim() && onLine?.(`[${streamName}] ${line.trim()}`))
    })
    stream?.on('end', () => remainder.trim() && onLine?.(`[${streamName}] ${remainder.trim()}`))
  }

  bind(child.stdout, 'stdout')
  bind(child.stderr, 'stderr')
}

export function bindDshOutput(child: ChildProcess, onLine: OutputLine): void {
  bindOutput(child, () => undefined, onLine)
}

export function runDshCommand(
  installation: DshInstallation,
  args: string[],
  workingDirectory: string,
  onLine?: OutputLine,
  options: DshCommandOptions = {}
): Promise<DshCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnDshCommand(installation, args, workingDirectory, onLine, options)
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeoutMs = options.timeoutMs ?? 5 * 60_000
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      onLine?.(`[timeout] DSH 命令超过 ${Math.round(timeoutMs / 1000)} 秒`)
      reject(new Error(`DSH 命令超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)

    bindOutput(
      child,
      (stream, text) => {
        if (stream === 'stdout') stdout += text
        else stderr += text
      },
      onLine
    )

    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ exitCode: exitCode ?? 1, stdout, stderr })
    })
  })
}

export async function runDshCommandChecked(
  installation: DshInstallation,
  args: string[],
  workingDirectory: string,
  onLine?: OutputLine,
  options?: DshCommandOptions
): Promise<DshCommandResult> {
  const result = await runDshCommand(installation, args, workingDirectory, onLine, options)
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `退出码 ${result.exitCode}`
    throw new Error(message)
  }
  return result
}
