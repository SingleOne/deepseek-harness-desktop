import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { bindDshOutput, spawnDshCommand } from './dsh-command'
import {
  DSH_NOTIFY_BRIDGE_TOKEN_ENV,
  DSH_NOTIFY_BRIDGE_URL_ENV,
  type NotificationBridgeEnvironment
} from './notification-bridge'
import { runNpmChecked } from './npm-command'

const DSH_PACKAGE = '@deepseek-ai/dsh'
// Keep discovery and installation on the same npm prefix for this Desktop run.
let npmGlobalPrefix: string | undefined

interface DshPackageManifest {
  version?: string
  bin?: string | Record<string, string>
}

export interface DshInstallation {
  version: string
  entryPath: string
  nodePath?: string
}

export interface DshRuntimeOptions {
  readonly notificationBridgeEnvironment?: NotificationBridgeEnvironment
  readonly onReadyUrl?: (url: string) => void
}

type OutputLine = (line: string) => void

function resolveBinPath(manifest: DshPackageManifest): string | undefined {
  if (typeof manifest.bin === 'string') return manifest.bin
  return manifest.bin?.dsh ?? Object.values(manifest.bin ?? {})[0]
}

async function getNpmGlobalPrefix(onLine?: OutputLine): Promise<string> {
  if (npmGlobalPrefix) return npmGlobalPrefix
  const result = await runNpmChecked(['prefix', '--global'], onLine)
  npmGlobalPrefix = result.stdout.trim()
  onLine?.(`[步骤] 本次运行使用 npm 全局前缀：${npmGlobalPrefix}`)
  return npmGlobalPrefix
}

export async function getInstalledDsh(onLine?: OutputLine): Promise<DshInstallation | null> {
  const prefix = await getNpmGlobalPrefix(onLine)
  if (!existsSync(prefix)) {
    onLine?.('[结果] npm 全局安装目录尚未创建，未找到 DSH')
    return null
  }

  const npmRootResult = await runNpmChecked(['root', '--global'], onLine, { prefix })
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
  const prefix = await getNpmGlobalPrefix(onLine)
  await mkdir(prefix, { recursive: true })
  await runNpmChecked(
    ['install', '--global', `${DSH_PACKAGE}@${version}`, '--no-audit', '--no-fund'],
    onLine,
    { timeoutMs: 5 * 60_000, prefix }
  )
}

export function startDsh(
  installation: DshInstallation,
  port: number,
  workingDirectory: string,
  onLine: (line: string) => void,
  options: DshRuntimeOptions = {}
): ChildProcess {
  onLine(`[环境] DSH 工作目录：${workingDirectory}`)
  onLine(`[环境] ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE ?? '未设置'}`)
  onLine(`[环境] NODE_OPTIONS=${process.env.NODE_OPTIONS ?? '未设置'}`)
  onLine(`[环境] DEEPSEEK_HARNESS_DESKTOP_DSH_ENTRY=${installation.entryPath}`)
  onLine(`[环境] Node 可执行文件：${installation.nodePath ?? 'node（PATH）'}`)
  onLine(`[环境] 桌面通知桥接=${options.notificationBridgeEnvironment ? '已启用' : '未启用'}`)
  const child = spawnDshCommand(
    installation,
    ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'],
    workingDirectory,
    onLine,
    {
      environment: options.notificationBridgeEnvironment,
      removeEnvironment: [DSH_NOTIFY_BRIDGE_URL_ENV, DSH_NOTIFY_BRIDGE_TOKEN_ENV]
    }
  )
  bindDshOutput(child, (line) => {
    const readyUrl = line.match(/^\[stdout\] dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*)/)?.[1]
    if (readyUrl?.startsWith(`http://127.0.0.1:${port}/`)) {
      options.onReadyUrl?.(readyUrl)
      onLine(`[stdout] dsh web: http://127.0.0.1:${port}/（鉴权信息已省略）`)
      return
    }
    onLine(line)
  })
  return child
}

export async function waitForDsh(
  url: string,
  child: ChildProcess,
  timeoutMs = 60_000,
  onLine?: OutputLine,
  getReadyUrl?: () => string | undefined
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastRetryLogAt = 0
  onLine?.(`[HTTP] GET ${url}`)

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      onLine?.(`[结果] DSH 进程已退出，退出码 ${child.exitCode}`)
      throw new Error(`DSH 在页面可用前退出，退出码 ${child.exitCode}`)
    }

    try {
      const pageUrl = getReadyUrl?.() ?? url
      const response = await fetch(pageUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(1_500)
      })
      if (response.ok || (response.status === 303 && pageUrl !== url)) {
        onLine?.(`[HTTP] ${response.status}，DSH Web UI 已就绪`)
        return pageUrl
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
