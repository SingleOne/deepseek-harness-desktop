import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isMap, parseDocument } from 'yaml'

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const prepareDeniedCode = '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED]'

export interface PnpmGitBuildApproval {
  readonly key: string
  readonly packageName: string
  readonly repositoryUrl: string
  readonly revision: string
}

function githubRepository(value: string): { owner: string; repository: string } | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    return { owner: parts[0], repository: parts[1].replace(/\.git$/i, '') }
  } catch {
    return null
  }
}

export function parsePnpmGitBuildApproval(
  message: string,
  expectedRepositoryUrl: string
): PnpmGitBuildApproval | null {
  if (!message.includes(prepareDeniedCode)) return null
  const example = message.match(/(?:^|\r?\n)allowBuilds:\r?\n {2}([^\r\n]+): true(?:\r?\n|$)/)
  const key = example?.[1]?.trim()
  if (!key || key.length > 1_000 || /[\u0000-\u001f\u007f]/.test(key)) return null

  const sourceSeparator = key.lastIndexOf('@https://')
  if (sourceSeparator <= 0) return null
  const packageName = key.slice(0, sourceSeparator)
  if (!packageNamePattern.test(packageName)) return null

  let source: URL
  try {
    source = new URL(key.slice(sourceSeparator + 1))
  } catch {
    return null
  }
  if (
    source.protocol !== 'https:'
    || source.hostname.toLowerCase() !== 'codeload.github.com'
    || source.username
    || source.password
    || source.search
    || source.hash
  ) return null

  const sourceParts = source.pathname.split('/').filter(Boolean)
  if (sourceParts.length !== 4 || sourceParts[2] !== 'tar.gz') return null
  const expected = githubRepository(expectedRepositoryUrl)
  if (!expected) return null
  if (
    sourceParts[0].toLowerCase() !== expected.owner.toLowerCase()
    || sourceParts[1].toLowerCase() !== expected.repository.toLowerCase()
  ) return null
  const revision = sourceParts[3]
  if (!/^[a-zA-Z0-9._-]{7,128}$/.test(revision)) return null

  return {
    key,
    packageName,
    repositoryUrl: `https://github.com/${sourceParts[0]}/${sourceParts[1]}`,
    revision
  }
}

export async function allowPnpmBuild(
  profileDirectory: string,
  approval: PnpmGitBuildApproval
): Promise<boolean> {
  const workspacePath = path.join(profileDirectory, 'pnpm-workspace.yaml')
  const source = await readFile(workspacePath, 'utf8')
  const document = parseDocument(source)
  if (document.errors.length) {
    throw new Error('pnpm-workspace.yaml 不是有效的 YAML，无法安全添加构建授权')
  }

  const allowBuilds = document.get('allowBuilds', true)
  if (allowBuilds !== undefined && !isMap(allowBuilds)) {
    throw new Error('pnpm-workspace.yaml 中的 allowBuilds 必须是键值映射')
  }
  if (document.getIn(['allowBuilds', approval.key]) === true) return false
  if (allowBuilds === undefined) document.set('allowBuilds', document.createNode({}))
  document.setIn(['allowBuilds', approval.key], true)

  const temporaryPath = path.join(
    profileDirectory,
    `.pnpm-workspace-${process.pid}-${randomUUID()}.tmp`
  )
  await writeFile(temporaryPath, document.toString({ lineWidth: 0 }), 'utf8')
  try {
    await rename(temporaryPath, workspacePath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
  return true
}
