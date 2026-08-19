import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { extract } from 'tar-stream'
import type {
  ArtifactEntry,
  ScanArtifactInput,
  ScanCoverage,
  ScanFinding,
  ScanLimits
} from './types.js'

interface ReadArtifactResult {
  entries: ArtifactEntry[]
  coverage: ScanCoverage
  findings: ScanFinding[]
}

function archiveFinding(
  ruleId: string,
  title: string,
  description: string,
  file?: string
): ScanFinding {
  return {
    ruleId,
    severity: 'critical',
    category: 'archive',
    title,
    description,
    file,
    engine: 'artifact-reader'
  }
}

function normalizedArchivePath(value: string): string | undefined {
  if (!value || value.includes('\0')) return undefined
  const replaced = value.replaceAll('\\', '/')
  if (replaced.startsWith('/') || replaced.startsWith('//') || /^[a-zA-Z]:\//.test(replaced)) {
    return undefined
  }
  const parts = replaced.split('/')
  if (parts.some((part) => part === '..')) return undefined
  const normalized = posix.normalize(replaced).replace(/^\.\//, '').replace(/\/$/, '')
  return normalized && normalized !== '.' ? normalized : undefined
}

function isProbablyText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192))
  if (sample.includes(0)) return false
  let controlCharacters = 0
  for (const value of sample) {
    if (value < 9 || (value > 13 && value < 32)) controlCharacters += 1
  }
  return controlCharacters <= Math.max(2, Math.floor(sample.length * 0.01))
}

function stripArchiveRoot(entries: ArtifactEntry[], packagePath?: string): ArtifactEntry[] {
  const roots = new Set(entries.map((entry) => entry.path.split('/')[0]))
  const root = roots.size === 1 ? [...roots][0] : undefined
  const normalizedPackagePath = packagePath
    ? posix.normalize(packagePath.replace(/^\/+|\/+$/g, ''))
    : undefined

  return entries.flatMap((entry) => {
    let relative = root && entry.path.startsWith(`${root}/`)
      ? entry.path.slice(root.length + 1)
      : entry.path
    if (normalizedPackagePath) {
      if (relative === normalizedPackagePath) return []
      if (!relative.startsWith(`${normalizedPackagePath}/`)) return []
      relative = relative.slice(normalizedPackagePath.length + 1)
    }
    return relative ? [{ ...entry, path: relative }] : []
  })
}

export async function readArtifact(
  input: ScanArtifactInput,
  limits: ScanLimits
): Promise<ReadArtifactResult> {
  if ((input.filePath ? 1 : 0) + (input.bytes ? 1 : 0) !== 1) {
    throw new Error('扫描输入必须且只能提供 filePath 或 bytes')
  }
  const archive = input.bytes ? Buffer.from(input.bytes) : await readFile(input.filePath!)
  const coverage: ScanCoverage = {
    complete: true,
    scannedFiles: 0,
    skippedFiles: 0,
    scannedBytes: 0,
    astFiles: 0,
    parseErrors: 0,
    dependencyCoverage: 'artifact-manifest',
    notes: []
  }
  const findings: ScanFinding[] = []
  if (archive.byteLength > limits.maxArchiveBytes) {
    coverage.complete = false
    coverage.notes.push(`压缩包超过 ${limits.maxArchiveBytes} 字节上限`)
    findings.push(archiveFinding(
      'archive.size-limit',
      '压缩包超过扫描上限',
      '扫描器没有完整读取该制品。'
    ))
    return { entries: [], coverage, findings }
  }

  const entries: ArtifactEntry[] = []
  const seen = new Set<string>()
  const extractor = extract()
  let expandedBytes = 0
  let stopped = false

  const stopIncomplete = (message: string): void => {
    if (stopped) return
    stopped = true
    coverage.complete = false
    coverage.notes.push(message)
  }

  extractor.on('entry', (header, stream, next) => {
    if (stopped) {
      stream.resume()
      stream.once('end', next)
      return
    }
    const entryPath = normalizedArchivePath(header.name)
    if (!entryPath) {
      findings.push(archiveFinding(
        'archive.path-traversal',
        '归档包含不安全路径',
        '制品中存在绝对路径、盘符、NUL 或上级目录跳转。',
        header.name
      ))
      stream.resume()
      stream.once('end', next)
      return
    }

    if (header.type === 'symlink' || header.type === 'link') {
      const linkTarget = normalizedArchivePath(header.linkname ?? '')
      findings.push(archiveFinding(
        'archive.link-entry',
        '归档包含链接条目',
        linkTarget
          ? '扫描器不会跟随归档中的符号链接或硬链接。'
          : '归档链接指向包边界之外。',
        entryPath
      ))
      stream.resume()
      stream.once('end', next)
      return
    }
    if (header.type !== 'file' && header.type !== 'contiguous-file' && header.type !== undefined) {
      stream.resume()
      stream.once('end', next)
      return
    }
    if (seen.has(entryPath)) {
      findings.push(archiveFinding(
        'archive.duplicate-path',
        '归档重复覆盖同一路径',
        '不同归档条目会写入同一个规范化路径。',
        entryPath
      ))
      stream.resume()
      stream.once('end', next)
      return
    }
    seen.add(entryPath)
    if (seen.size > limits.maxFiles) {
      stopIncomplete(`文件数超过 ${limits.maxFiles} 个上限`)
      stream.resume()
      stream.once('end', next)
      return
    }

    const chunks: Buffer[] = []
    let fileBytes = 0
    let skipped = false
    stream.on('data', (chunk: Buffer) => {
      fileBytes += chunk.length
      expandedBytes += chunk.length
      if (expandedBytes > limits.maxExpandedBytes) {
        stopIncomplete(`展开内容超过 ${limits.maxExpandedBytes} 字节上限`)
        skipped = true
        chunks.length = 0
      } else if (fileBytes > limits.maxFileBytes) {
        skipped = true
        chunks.length = 0
      } else if (!skipped) {
        chunks.push(Buffer.from(chunk))
      }
    })
    stream.once('end', () => {
      if (skipped) {
        coverage.skippedFiles += 1
        coverage.complete = false
        coverage.notes.push(`${entryPath} 超过单文件扫描上限`)
      } else {
        const bytes = Buffer.concat(chunks)
        entries.push({
          path: entryPath,
          bytes,
          text: isProbablyText(bytes) ? bytes.toString('utf8') : undefined
        })
      }
      next()
    })
  })

  await new Promise<void>((resolve, reject) => {
    extractor.once('finish', resolve)
    extractor.once('error', reject)
    const source = Readable.from([archive])
    source.once('error', reject)
    if (archive[0] === 0x1f && archive[1] === 0x8b) {
      const gunzip = createGunzip()
      gunzip.once('error', reject)
      source.pipe(gunzip).pipe(extractor)
    } else {
      source.pipe(extractor)
    }
  }).catch((error: unknown) => {
    coverage.complete = false
    coverage.notes.push(`归档解析失败：${error instanceof Error ? error.message : String(error)}`)
  })

  const selectedEntries = stripArchiveRoot(entries, input.identity?.packagePath)
  if (input.identity?.packagePath && selectedEntries.length === 0) {
    coverage.complete = false
    coverage.notes.push(`归档中没有找到子包路径 ${input.identity.packagePath}`)
  }
  coverage.scannedFiles = selectedEntries.length
  coverage.scannedBytes = selectedEntries.reduce((total, entry) => total + entry.bytes.byteLength, 0)
  return { entries: selectedEntries, coverage, findings }
}
