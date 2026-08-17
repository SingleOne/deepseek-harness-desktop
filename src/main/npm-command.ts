import { spawn } from 'node:child_process'
import { commandEnvironment } from './command-environment'

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface NpmCommandOptions {
  timeoutMs?: number
}

const safeNpmArgument = /^[a-zA-Z0-9@._+/:=-]+$/

function createNpmProcess(args: string[]) {
  const environment = commandEnvironment()
  if (process.platform !== 'win32') {
    return spawn('npm', args, {
      env: environment,
      windowsHide: true
    })
  }

  if (args.some((arg) => !safeNpmArgument.test(arg))) {
    throw new Error('npm 命令包含不支持的参数')
  }

  const command = ['npm', ...args].join(' ')
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
    env: environment,
    windowsHide: true
  })
}

export function runNpm(
  args: string[],
  onLine?: (line: string) => void,
  options: NpmCommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const command = ['npm', ...args].join(' ')
    onLine?.(`$ ${command}`)

    const child = createNpmProcess(args)
    const timeoutMs = options.timeoutMs ?? 20_000
    let stdout = ''
    let stderr = ''
    let stdoutRemainder = ''
    let stderrRemainder = ''
    let settled = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      onLine?.(`[timeout] npm 命令超过 ${Math.round(timeoutMs / 1000)} 秒：${command}`)
      reject(new Error(`npm 命令超时（${Math.round(timeoutMs / 1000)} 秒）：npm ${args.join(' ')}`))
    }, timeoutMs)

    const emitLine = (stream: 'stdout' | 'stderr', line: string): void => {
      const trimmed = line.trim()
      if (trimmed) onLine?.(`[${stream}] ${trimmed}`)
    }

    const emitLines = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const text = chunk.toString('utf8')
      if (stream === 'stdout') {
        stdout += text
        stdoutRemainder += text
        const lines = stdoutRemainder.split(/\r?\n/)
        stdoutRemainder = lines.pop() ?? ''
        lines.forEach((line) => emitLine('stdout', line))
        return
      }

      stderr += text
      stderrRemainder += text
      const lines = stderrRemainder.split(/\r?\n/)
      stderrRemainder = lines.pop() ?? ''
      lines.forEach((line) => emitLine('stderr', line))
    }

    child.stdout.on('data', (chunk: Buffer) => emitLines(chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => emitLines(chunk, 'stderr'))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      onLine?.(`[error] npm 命令启动失败：${error.message}`)
      reject(error)
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      emitLine('stdout', stdoutRemainder)
      emitLine('stderr', stderrRemainder)
      const finalExitCode = exitCode ?? 1
      onLine?.(`[exit ${finalExitCode}] ${command}`)
      resolve({ exitCode: finalExitCode, stdout, stderr })
    })
  })
}

export async function runNpmChecked(
  args: string[],
  onLine?: (line: string) => void,
  options?: NpmCommandOptions
): Promise<CommandResult> {
  const result = await runNpm(args, onLine, options)
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `退出码 ${result.exitCode}`
    throw new Error(message)
  }
  return result
}
