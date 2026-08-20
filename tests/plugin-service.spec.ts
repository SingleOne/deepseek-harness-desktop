import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginCatalogService, ResolvedCatalogItem } from '../src/main/plugin-catalog-service'
import type { PluginProfileService } from '../src/main/plugin-profile-service'
import type { PluginUpdateTarget } from '../src/main/plugin-update-service'
import type { PnpmRuntime } from '../src/main/pnpm-runtime'
import type { PnpmGitBuildApproval } from '../src/main/pnpm-build-policy'
import type { ScanReport } from '../packages/security-scanner/src'
import type { PluginOperationState } from '../src/shared/plugin-market'
import type {
  PluginSecurityService,
  PreparedSecurityArtifact
} from '../src/main/plugin-security-service'

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

function fixture(
  approved: boolean,
  pnpmRuntime?: PnpmRuntime,
  security?: PluginSecurityService
) {
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
    allowBuild: vi.fn().mockResolvedValue(true),
    createSnapshot: vi.fn().mockResolvedValue({
      backupDirectory: 'C:\\backups\\plugin',
      profileDirectory: 'C:\\Users\\tester\\.dsh\\profiles\\web',
      files: []
    }),
    restoreSnapshot: vi.fn().mockResolvedValue(undefined),
    validatePlugin: vi.fn().mockResolvedValue({
      packageName: '@0xsline/dsh-spotlight',
      version: '0.0.3',
      sourceSpec: plugin.installSpec,
      repositoryUrl: plugin.repositoryUrl
    })
  } as unknown as PluginProfileService
  const runtime = {
    getInstallation: vi.fn(() => ({ version: '0.1.0-rc.6', entryPath: 'dsh.js' })),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    confirmGitBuild: vi.fn<(name: string, approval: PnpmGitBuildApproval) => Promise<boolean>>()
      .mockResolvedValue(approved)
  }
  return {
    catalog,
    profile,
    runtime,
    service: new PluginService(catalog, profile, runtime, pnpmRuntime, security)
  }
}

function securityFixture(recommendation: ScanReport['recommendation']) {
  const report: ScanReport = {
    schemaVersion: 1,
    engine: {
      id: '@dsh-desktop/security-scanner',
      version: '0.1.0',
      rulePacks: [{ id: '@dsh-desktop/rules-dsh', version: '0.1.0' }]
    },
    artifact: { source: 'github', digest: 'a'.repeat(128) },
    recommendation,
    coverage: {
      complete: recommendation !== 'incomplete',
      scannedFiles: 2,
      skippedFiles: 0,
      scannedBytes: 100,
      astFiles: 1,
      parseErrors: 0,
      dependencyCoverage: 'artifact-manifest',
      notes: []
    },
    dependencies: [],
    resolvedDependencies: [],
    supplyChain: {
      osv: { status: 'not-run', queriedPackages: 0, vulnerabilityCount: 0 },
      registrySignature: { status: 'not-applicable' },
      provenance: { status: 'not-applicable' },
      releaseAge: { status: 'not-applicable', minimumHours: 24 }
    },
    findings: [],
    scannedAt: new Date().toISOString(),
    durationMs: 10
  }
  const artifact: PreparedSecurityArtifact = {
    id: 'prepared-test',
    pluginId: plugin.id,
    artifactPath: 'C:\\temp\\artifact.tgz',
    temporaryDirectory: 'C:\\temp\\scanner',
    installSpec: plugin.installSpec,
    source: 'github',
    digest: 'a'.repeat(128),
    report,
    expiresAt: Date.now() + 60_000
  }
  const service = {
    prepare: vi.fn(async (_plugin, onPhase) => {
      onPhase('scanning-artifact', '正在扫描测试制品')
      return artifact
    }),
    verify: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn().mockResolvedValue(undefined)
  } as unknown as PluginSecurityService
  return { service, artifact }
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

  it('injects bundled pnpm for both install and remove commands', async () => {
    vi.mocked(runDshCommandChecked).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    const bundled: PnpmRuntime = {
      source: 'bundled',
      version: '11.22.0',
      binDirectory: 'C:\\app\\resources\\pnpm-bin'
    }
    const { service } = fixture(true, bundled)

    await expect(service.install(plugin.id)).resolves.toBe(true)
    expect(runDshCommandChecked).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      ['plugin', '--profile', 'web', 'add', plugin.installSpec],
      expect.any(String),
      expect.any(Function),
      {
        environment: { DEEPSEEK_HARNESS_DESKTOP_NODE: 'node' },
        prependPath: ['C:\\app\\resources\\pnpm-bin']
      }
    )

    vi.mocked(runDshCommandChecked).mockClear()
    await expect(service.remove('@0xsline/dsh-spotlight')).resolves.toBeUndefined()
    expect(runDshCommandChecked).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      ['plugin', '--profile', 'web', 'remove', '@0xsline/dsh-spotlight'],
      expect.any(String),
      expect.any(Function),
      {
        environment: { DEEPSEEK_HARNESS_DESKTOP_NODE: 'node' },
        prependPath: ['C:\\app\\resources\\pnpm-bin']
      }
    )
  })

  it('fails before stopping DSH when neither system nor bundled pnpm is usable', async () => {
    const { runtime, service } = fixture(true, {
      source: 'unavailable',
      error: 'pnpm unavailable for test'
    })

    await expect(service.install(plugin.id)).rejects.toThrow('pnpm unavailable for test')
    expect(runtime.stop).not.toHaveBeenCalled()
    expect(runDshCommandChecked).not.toHaveBeenCalled()
  })
})

const updateTarget: PluginUpdateTarget = {
  packageName: '@0xsline/dsh-spotlight',
  source: 'github',
  sourceSpec: plugin.installSpec,
  installSpec: plugin.installSpec,
  catalogId: plugin.id,
  installedVersion: '0.0.2',
  targetVersion: '0.0.3',
  repositoryUrl: plugin.repositoryUrl
}

describe('plugin update transaction', () => {
  it('backs up, updates through the DSH command, validates, and restarts', async () => {
    vi.mocked(runDshCommandChecked).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    const { profile, runtime, service } = fixture(true)

    await expect(service.update(updateTarget)).resolves.toBe(true)

    expect(profile.createSnapshot).toHaveBeenCalledWith(updateTarget.packageName)
    expect(runDshCommandChecked).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      ['plugin', '--profile', 'web', 'add', plugin.installSpec],
      expect.any(String),
      expect.any(Function),
      {}
    )
    expect(profile.validatePlugin).toHaveBeenCalledWith(updateTarget.packageName, '0.0.3', true)
    expect(profile.restoreSnapshot).not.toHaveBeenCalled()
    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(runtime.restart).toHaveBeenCalledOnce()
    expect(service.currentState.phase).toBe('succeeded')
  })

  it('rescans a catalog update and installs the exact scanned GitHub commit', async () => {
    const security = securityFixture('pass')
    security.artifact.installSpec = `github:0xsline/dsh-spotlight#${'b'.repeat(40)}`
    security.artifact.commit = 'b'.repeat(40)
    vi.mocked(runDshCommandChecked).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    const { runtime, service } = fixture(true, undefined, security.service)

    await expect(service.update(updateTarget)).resolves.toBe(true)

    expect(security.service.prepare).toHaveBeenCalledWith(plugin, expect.any(Function))
    expect(security.service.verify).toHaveBeenCalledWith(security.artifact)
    expect(runDshCommandChecked).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      ['plugin', '--profile', 'web', 'add', security.artifact.installSpec],
      expect.any(String),
      expect.any(Function),
      {}
    )
    expect(security.service.discard).toHaveBeenCalledWith(security.artifact)
    expect(runtime.stop).toHaveBeenCalledOnce()
  })

  it('restores the snapshot and frozen lockfile when the update command fails', async () => {
    vi.mocked(runDshCommandChecked)
      .mockRejectedValueOnce(new Error('update failed'))
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    const { profile, runtime, service } = fixture(true)

    await expect(service.update(updateTarget)).rejects.toThrow('update failed')

    expect(profile.restoreSnapshot).toHaveBeenCalledOnce()
    expect(runDshCommandChecked).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ['plugin', '--profile', 'web', 'install', '--frozen-lockfile'],
      expect.any(String),
      expect.any(Function),
      {}
    )
    expect(profile.validatePlugin).toHaveBeenCalledWith(updateTarget.packageName, '0.0.2')
    expect(runtime.restart).toHaveBeenCalledOnce()
    expect(service.currentState).toMatchObject({
      phase: 'failed',
      detail: '插件更新失败，已恢复原版本'
    })
  })

  it('rolls back and returns cancelled when a new GitHub build is not approved', async () => {
    vi.mocked(runDshCommandChecked)
      .mockRejectedValueOnce(new Error(denial))
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    const { profile, runtime, service } = fixture(false)

    await expect(service.update(updateTarget)).resolves.toBe(false)

    expect(runtime.confirmGitBuild).toHaveBeenCalledOnce()
    expect(profile.allowBuild).not.toHaveBeenCalled()
    expect(profile.restoreSnapshot).toHaveBeenCalledOnce()
    expect(service.currentState.phase).toBe('idle')
  })

  it('keeps the backup path in the error when automatic recovery also fails', async () => {
    vi.mocked(runDshCommandChecked).mockRejectedValueOnce(new Error('update failed'))
    const { profile, service } = fixture(true)
    vi.mocked(profile.restoreSnapshot).mockRejectedValueOnce(new Error('restore failed'))

    await expect(service.update(updateTarget)).rejects.toThrow('C:\\backups\\plugin')
    expect(service.currentState).toMatchObject({
      phase: 'failed',
      detail: '插件更新失败且自动恢复未完成'
    })
  })
})

describe('plugin security preparation', () => {
  it('scans before stopping DSH and commits the prepared installation', async () => {
    const security = securityFixture('review')
    const { runtime, service } = fixture(true, undefined, security.service)
    vi.mocked(runDshCommandChecked).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })

    const prepared = await service.prepareInstall(plugin.id)

    expect(prepared.report.recommendation).toBe('review')
    expect(runtime.stop).not.toHaveBeenCalled()
    expect(service.currentState.phase).toBe('awaiting-security-review')

    await expect(service.commitInstall(prepared.id)).resolves.toBe(true)
    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(security.service.verify).toHaveBeenCalledOnce()
    expect(security.service.discard).toHaveBeenCalledOnce()
  })

  it('does not commit a blocked scan result', async () => {
    const security = securityFixture('block')
    const { runtime, service } = fixture(true, undefined, security.service)

    const prepared = await service.prepareInstall(plugin.id)

    await expect(service.commitInstall(prepared.id)).rejects.toThrow('严重危险代码')
    expect(runtime.stop).not.toHaveBeenCalled()
    expect(runDshCommandChecked).not.toHaveBeenCalled()
    expect(security.service.discard).toHaveBeenCalledOnce()
    expect(service.currentState.phase).toBe('idle')
  })

  it('continues automatic installation when coverage is incomplete but no critical finding exists', async () => {
    const security = securityFixture('incomplete')
    const { service } = fixture(true, undefined, security.service)
    vi.mocked(runDshCommandChecked).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })

    const prepared = await service.prepareInstall(plugin.id)

    await expect(service.commitInstall(prepared.id)).resolves.toBe(true)
    expect(security.service.verify).toHaveBeenCalledOnce()
  })

  it('clears a previous scan error as soon as the next plugin scan starts', async () => {
    const security = securityFixture('pass')
    const prepare = vi.mocked(security.service.prepare)
    prepare
      .mockRejectedValueOnce(new Error('插件制品超过 32 MiB 下载上限'))
      .mockImplementationOnce(async (_plugin, onPhase) => {
        onPhase('scanning-artifact', '正在扫描下一个插件')
        return security.artifact
      })
    const { service } = fixture(true, undefined, security.service)
    const states: PluginOperationState[] = []
    service.subscribe((state) => states.push({ ...state }))

    await expect(service.prepareInstall(plugin.id)).rejects.toThrow('32 MiB')
    expect(service.currentState.error).toContain('32 MiB')

    await expect(service.prepareInstall(plugin.id)).resolves.toBeDefined()

    const nextScanStates = states.slice(states.findIndex((state) => state.phase === 'failed') + 1)
    expect(nextScanStates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ error: expect.stringContaining('32 MiB') })
    ]))
    expect(service.currentState.error).toBeUndefined()
    expect(service.currentState.phase).toBe('awaiting-security-review')
  })
})
