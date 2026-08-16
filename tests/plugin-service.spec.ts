import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginCatalogService, ResolvedCatalogItem } from '../src/main/plugin-catalog-service'
import type { PluginProfileService } from '../src/main/plugin-profile-service'
import type { PnpmGitBuildApproval } from '../src/main/pnpm-build-policy'

vi.mock('electron', () => ({ app: { getPath: () => 'C:\\Users\\tester' } }))
vi.mock('../src/main/dsh-command', () => ({ runDshCommandChecked: vi.fn() }))

const { runDshCommandChecked } = await import('../src/main/dsh-command')
const { PluginService } = await import('../src/main/plugin-service')

const key = '@0xsline/dsh-spotlight@https://codeload.github.com/0xsline/dsh-spotlight/tar.gz/dd7ef5ed160aa1a624559de16eafd4ea9406d7ed'
const denial = `[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package
allowBuilds:
  ${key}: true
`
const plugin: ResolvedCatalogItem = {
  id: '0xsline/dsh-spotlight::github:github:0xsline/dsh-spotlight',
  name: 'dsh-spotlight',
  owner: '0xsline',
  repositoryUrl: 'https://github.com/0xsline/dsh-spotlight',
  description: 'test plugin',
  category: 'ui',
  stars: 0,
  source: 'github',
  installSpec: 'github:0xsline/dsh-spotlight'
}

function fixture(approved: boolean) {
  const catalog = {
    getPlugin: vi.fn().mockResolvedValue(plugin),
    getCatalog: vi.fn().mockResolvedValue({}),
    findCatalogId: vi.fn(() => plugin.id)
  } as unknown as PluginCatalogService
  const profile = {
    listDirectDependencies: vi.fn().mockResolvedValue({}),
    listInstalled: vi.fn().mockResolvedValue([{
      packageName: '@0xsline/dsh-spotlight',
      version: '0.0.2',
      sourceSpec: plugin.installSpec,
      repositoryUrl: plugin.repositoryUrl
    }]),
    allowBuild: vi.fn().mockResolvedValue(true)
  } as unknown as PluginProfileService
  const runtime = {
    getInstallation: vi.fn(() => ({ version: '0.1.0-rc.6', entryPath: 'dsh.js' })),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    confirmGitBuild: vi.fn<(name: string, approval: PnpmGitBuildApproval) => Promise<boolean>>()
      .mockResolvedValue(approved)
  }
  return { catalog, profile, runtime, service: new PluginService(catalog, profile, runtime) }
}

beforeEach(() => {
  vi.mocked(runDshCommandChecked).mockReset()
})

describe('plugin installation build approval', () => {
  it('writes the validated approval and retries the GitHub installation', async () => {
    vi.mocked(runDshCommandChecked)
      .mockRejectedValueOnce(new Error(denial))
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    const { profile, runtime, service } = fixture(true)

    await expect(service.install(plugin.id)).resolves.toBe(true)
    expect(runtime.confirmGitBuild).toHaveBeenCalledOnce()
    expect(vi.mocked(profile.allowBuild)).toHaveBeenCalledWith(expect.objectContaining({ key }))
    expect(runDshCommandChecked).toHaveBeenCalledTimes(3)
    expect(runtime.restart).toHaveBeenCalledOnce()
    expect(service.currentState.phase).toBe('succeeded')
  })

  it('cancels cleanly and restarts DSH when build permission is declined', async () => {
    vi.mocked(runDshCommandChecked).mockRejectedValueOnce(new Error(denial))
    const { profile, runtime, service } = fixture(false)

    await expect(service.install(plugin.id)).resolves.toBe(false)
    expect(profile.allowBuild).not.toHaveBeenCalled()
    expect(runDshCommandChecked).toHaveBeenCalledOnce()
    expect(runtime.restart).toHaveBeenCalledOnce()
    expect(service.currentState.phase).toBe('idle')
  })
})
