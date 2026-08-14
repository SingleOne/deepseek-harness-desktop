import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { runNpmChecked } from './npm-command'

const DSH_PACKAGE = '@deepseek-ai/dsh'

interface DshPackageManifest {
  version?: string
  bin?: string | Record<string, string>
}

export interface DshInstallation {
  version: string
  entryPath: string
  nodePath?: string
}

type OutputLine = (line: string) => void

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

function resolveBinPath(manifest: DshPackageManifest): string | undefined {
  if (typeof manifest.bin === 'string') return manifest.bin
  return manifest.bin?.dsh ?? Object.values(manifest.bin ?? {})[0]
}

export async function getInstalledDsh(onLine?: OutputLine): Promise<DshInstallation | null> {
  const npmRootResult = await runNpmChecked(['root', '--global'], onLine)
  const npmRoot = npmRootResult.stdout.trim()
  onLine?.(`[步骤] npm 全局安装目录：${npmRoot}`)
  const packageDirectory = path.join(npmRoot, '@deepseek-ai', 'dsh')
  const manifestPath = path.join(packageDirectory, 'package.json')
  onLine?.(`[文件] 读取 DSH manifest：${manifestPath}`)

  try {
    const manifestText = await readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(manifestText) as DshPackageManifest
    const binPath = resolveBinPath(manifest)
    if (!manifest.version || !binPath) {
      throw new Error('全局 DSH 包缺少版本号或启动入口')
    }

    const installation = {
      version: manifest.version,
      entryPath: path.resolve(packageDirectory, binPath),
      nodePath: process.platform === 'win32'
        ? (() => {
            const candidate = path.resolve(npmRoot, '..', 'node.exe')
            return existsSync(candidate) ? candidate : undefined
          })()
        : undefined
    }
    onLine?.(`[结果] 已安装 DSH ${installation.version}`)
    onLine?.(`[结果] DSH 启动入口：${installation.entryPath}`)
    onLine?.(`[结果] Node 可执行文件：${installation.nodePath ?? 'node（PATH）'}`)
    return installation
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      onLine?.('[结果] 未找到全局安装的 DSH')
      return null
    }
    throw error
  }
}

export async function getLatestDshVersion(onLine?: OutputLine): Promise<string> {
  const result = await runNpmChecked(
    ['view', DSH_PACKAGE, 'dist-tags.latest', '--json'],
    onLine
  )
  const raw = result.stdout.trim()
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== 'string' || !parsed.trim()) {
    throw new Error('npm 没有返回有效的 DSH latest 版本')
  }
  const version = parsed.trim()
  onLine?.(`[结果] npm latest：${version}`)
  return version
}

export async function installDshVersion(
  version: string,
  onLine: (line: string) => void
): Promise<void> {
  await runNpmChecked(
    ['install', '--global', `${DSH_PACKAGE}@${version}`, '--no-audit', '--no-fund'],
    onLine,
    { timeoutMs: 5 * 60_000 }
  )
}

export function startDsh(
  installation: DshInstallation,
  port: number,
  workingDirectory: string,
  onLine: (line: string) => void
): ChildProcess {
  onLine(`$ node --input-type=module --eval <desktop-runner> -- web --host 127.0.0.1 --port ${port}`)
  onLine(`[环境] DSH 工作目录：${workingDirectory}`)
  onLine(`[环境] ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE ?? '未设置'}`)
  onLine(`[环境] NODE_OPTIONS=${process.env.NODE_OPTIONS ?? '未设置'}`)
  onLine(`[环境] DEEPSEEK_HARNESS_DESKTOP_DSH_ENTRY=${installation.entryPath}`)
  onLine(`[环境] Node 可执行文件：${installation.nodePath ?? 'node（PATH）'}`)
  const child = spawn(
    installation.nodePath ?? 'node',
    [
      '--input-type=module',
      '--eval',
      runnerSource,
      '--',
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      String(port)
    ],
    {
      cwd: workingDirectory,
      env: {
        ...process.env,
        DEEPSEEK_HARNESS_DESKTOP_DSH_ENTRY: installation.entryPath
      },
      // Keep the DSH child independent from Electron's IPC channel. The
      // desktop launcher only needs its stdout/stderr and can terminate it
      // directly on shutdown.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )

  const bindOutput = (stream: NodeJS.ReadableStream | null, streamName: 'stdout' | 'stderr'): void => {
    let remainder = ''
    stream?.on('data', (chunk: Buffer) => {
      remainder += chunk.toString('utf8')
      const lines = remainder.split(/\r?\n/)
      remainder = lines.pop() ?? ''
      lines.forEach((line) => line.trim() && onLine(`[${streamName}] ${line.trim()}`))
    })
    stream?.on('end', () => remainder.trim() && onLine(`[${streamName}] ${remainder.trim()}`))
  }

  bindOutput(child.stdout, 'stdout')
  bindOutput(child.stderr, 'stderr')
  child.once('spawn', () => onLine(`[进程] DSH 子进程已创建：pid=${child.pid ?? '未知'}`))
  child.once('exit', (exitCode, signal) => {
    onLine(`[进程] DSH 子进程结束：退出码=${exitCode ?? '未知'}，信号=${signal ?? '无'}`)
  })
  return child
}

export async function waitForDsh(
  url: string,
  child: ChildProcess,
  timeoutMs = 60_000,
  onLine?: OutputLine
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastRetryLogAt = 0
  onLine?.(`[HTTP] GET ${url}`)

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      onLine?.(`[结果] DSH 进程已退出，退出码 ${child.exitCode}`)
      throw new Error(`DSH 在页面可用前退出，退出码 ${child.exitCode}`)
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) })
      if (response.status < 500) {
        onLine?.(`[HTTP] ${response.status}，DSH Web UI 已就绪`)
        return
      }
      if (Date.now() - lastRetryLogAt > 2_000) {
        lastRetryLogAt = Date.now()
        onLine?.(`[HTTP] ${response.status}，服务仍在启动，继续等待`)
      }
    } catch (error) {
      if (Date.now() - lastRetryLogAt > 2_000) {
        lastRetryLogAt = Date.now()
        const message = error instanceof Error ? error.message : String(error)
        onLine?.(`[HTTP] 尚未连接（${message}），继续等待`)
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  onLine?.(`[结果] 等待 DSH Web UI 超时（${Math.round(timeoutMs / 1000)} 秒）`)
  throw new Error('等待 DSH Web UI 启动超时')
}

export function stopDsh(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()

  return new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill()
    }, 5_500)

    child.once('exit', () => {
      clearTimeout(forceTimer)
      resolve()
    })

    if (child.connected) {
      child.send({ type: 'deepseek-harness-desktop:shutdown' })
    } else {
      child.kill()
    }
  })
}
