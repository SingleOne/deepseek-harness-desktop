import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  allowPnpmBuild,
  parsePnpmGitBuildApproval,
  type PnpmGitBuildApproval
} from '../src/main/pnpm-build-policy'

const key = '@0xsline/dsh-spotlight@https://codeload.github.com/0xsline/dsh-spotlight/tar.gz/dd7ef5ed160aa1a624559de16eafd4ea9406d7ed'
const denial = `[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package

Add the package to "allowBuilds" in your project's pnpm-workspace.yaml. For example:
allowBuilds:
  ${key}: true
`
const directories: string[] = []

async function profile(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-build-policy-'))
  directories.push(directory)
  await writeFile(path.join(directory, 'pnpm-workspace.yaml'), source, 'utf8')
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('pnpm Git build policy', () => {
  it('extracts only an approval key belonging to the selected GitHub repository', () => {
    expect(parsePnpmGitBuildApproval(
      denial,
      'https://github.com/0xsline/dsh-spotlight'
    )).toEqual({
      key,
      packageName: '@0xsline/dsh-spotlight',
      repositoryUrl: 'https://github.com/0xsline/dsh-spotlight',
      revision: 'dd7ef5ed160aa1a624559de16eafd4ea9406d7ed'
    })
    expect(parsePnpmGitBuildApproval(
      denial,
      'https://github.com/other/repository'
    )).toBeNull()
    expect(parsePnpmGitBuildApproval(
      denial.replace('[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED]', '[OTHER_ERROR]'),
      'https://github.com/0xsline/dsh-spotlight'
    )).toBeNull()
  })

  it('adds the exact commit-scoped key while preserving other workspace settings', async () => {
    const directory = await profile(`# keep this comment
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  existing-package@https://codeload.github.com/example/repo/tar.gz/1234567: true
`)
    const approval = parsePnpmGitBuildApproval(
      denial,
      'https://github.com/0xsline/dsh-spotlight'
    ) as PnpmGitBuildApproval

    expect(await allowPnpmBuild(directory, approval)).toBe(true)
    expect(await allowPnpmBuild(directory, approval)).toBe(false)
    const updated = await readFile(path.join(directory, 'pnpm-workspace.yaml'), 'utf8')
    const parsed = parse(updated) as { allowBuilds: Record<string, boolean> }
    expect(updated).toContain('# keep this comment')
    expect(parsed.allowBuilds[key]).toBe(true)
    expect(parsed.allowBuilds['existing-package@https://codeload.github.com/example/repo/tar.gz/1234567'])
      .toBe(true)
  })

  it('creates allowBuilds for a default DSH workspace', async () => {
    const directory = await profile(`packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n`)
    const approval = parsePnpmGitBuildApproval(
      denial,
      'https://github.com/0xsline/dsh-spotlight'
    ) as PnpmGitBuildApproval

    expect(await allowPnpmBuild(directory, approval)).toBe(true)
    const parsed = parse(
      await readFile(path.join(directory, 'pnpm-workspace.yaml'), 'utf8')
    ) as { allowBuilds: Record<string, boolean> }
    expect(parsed.allowBuilds).toEqual({ [key]: true })
  })

  it('refuses to overwrite a malformed allowBuilds value', async () => {
    const directory = await profile(`packages:\n  - .\nallowBuilds: true\n`)
    const approval = parsePnpmGitBuildApproval(
      denial,
      'https://github.com/0xsline/dsh-spotlight'
    ) as PnpmGitBuildApproval

    await expect(allowPnpmBuild(directory, approval)).rejects.toThrow('必须是键值映射')
  })
})
