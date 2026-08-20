import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledPlugin } from '../src/shared/plugin-market'
import type {
  PluginCatalogService,
  ResolvedCatalogItem
} from '../src/main/plugin-catalog-service'
import type { PluginProfileService } from '../src/main/plugin-profile-service'
import { PluginUpdateService } from '../src/main/plugin-update-service'

const githubPlugin: InstalledPlugin = {
  packageName: 'example-plugin',
  version: '1.2.0',
  sourceSpec: 'github:example/example-plugin#main',
  repositoryUrl: 'https://github.com/example/example-plugin'
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function fixture(
  plugin: InstalledPlugin = githubPlugin,
  catalogPlugin?: ResolvedCatalogItem
) {
  const profile = {
    listInstalled: vi.fn().mockResolvedValue([plugin])
  } as unknown as PluginProfileService
  const catalog = {
    getCatalog: vi.fn().mockResolvedValue({}),
    findCatalogPlugin: vi.fn().mockReturnValue(catalogPlugin)
  } as unknown as PluginCatalogService
  return {
    profile,
    catalog,
    service: new PluginUpdateService(profile, catalog, 'Z:\\missing\\plugin-update-state.json')
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('plugin update detection', () => {
  it('ignores ordinary GitHub commits when the declared plugin version has not changed', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      name: 'example-plugin',
      version: '1.2.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } }
    }))
    const { service } = fixture()

    const [update] = await service.checkInstalled(true)

    expect(update).toMatchObject({
      source: 'github',
      status: 'up-to-date',
      installedVersion: '1.2.0',
      latestVersion: '1.2.0'
    })
    expect(JSON.stringify(update)).not.toContain('Revision')
  })

  it('detects a GitHub update only after the target package version increases', async () => {
    vi.mocked(fetch).mockImplementation(async () => jsonResponse({
      name: 'example-plugin',
      version: '1.3.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } }
    }))
    const { service } = fixture({
      ...githubPlugin,
      sourceSpec: 'github:example/example-plugin#main&path:/packages/plugin'
    })

    const [update] = await service.checkInstalled(true)
    const target = await service.resolveUpdate('example-plugin')

    expect(update).toMatchObject({ status: 'available', latestVersion: '1.3.0' })
    expect(target).toMatchObject({
      installSpec: 'github:example/example-plugin#main&path:/packages/plugin',
      targetVersion: '1.3.0'
    })
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/main/packages/plugin/package.json')
  })

  it('does not query fixed GitHub commits or semantic version tags', async () => {
    const commit = fixture({ ...githubPlugin, sourceSpec: `github:example/example-plugin#${'a'.repeat(40)}` })
    const tag = fixture({ ...githubPlugin, sourceSpec: 'github:example/example-plugin#v1.2.0' })

    await expect(commit.service.checkInstalled(true)).resolves.toEqual([
      expect.objectContaining({ status: 'pinned', source: 'github' })
    ])
    await expect(tag.service.checkInstalled(true)).resolves.toEqual([
      expect.objectContaining({ status: 'pinned', source: 'github' })
    ])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('tracks a scanned GitHub commit through its unpinned catalog source', async () => {
    vi.mocked(fetch).mockImplementation(async () => jsonResponse({
      name: 'example-plugin',
      version: '1.3.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } }
    }))
    const catalogPlugin: ResolvedCatalogItem = {
      id: 'example/example-plugin::github:github:example/example-plugin',
      name: 'example-plugin',
      owner: 'example',
      repositoryUrl: 'https://github.com/example/example-plugin',
      description: 'test plugin',
      category: 'tools',
      stars: 0,
      source: 'github',
      installSpec: 'github:example/example-plugin'
    }
    const { service } = fixture({
      ...githubPlugin,
      sourceSpec: `github:example/example-plugin#${'a'.repeat(40)}`
    }, catalogPlugin)

    const [update] = await service.checkInstalled(true)
    const target = await service.resolveUpdate('example-plugin')

    expect(update).toMatchObject({ status: 'available', latestVersion: '1.3.0' })
    expect(target).toMatchObject({
      catalogId: catalogPlugin.id,
      sourceSpec: `github:example/example-plugin#${'a'.repeat(40)}`,
      installSpec: catalogPlugin.installSpec
    })
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/HEAD/package.json')
  })

  it('treats unknown protocols as unsupported instead of querying npm', async () => {
    const { service } = fixture({
      packageName: 'example-plugin',
      version: '1.2.0',
      sourceSpec: 'git+ssh://git@github.com/example/example-plugin.git#main'
    })

    await expect(service.checkInstalled(true)).resolves.toEqual([
      expect.objectContaining({ status: 'unsupported', source: 'other' })
    ])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('blocks npm updates when the latest package repository changes', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      name: 'example-plugin',
      version: '2.0.0',
      repository: { url: 'git+https://github.com/attacker/example-plugin.git' }
    }))
    const { service } = fixture({
      packageName: 'example-plugin',
      version: '1.2.0',
      sourceSpec: '^1.2.0',
      repositoryUrl: 'https://github.com/example/example-plugin'
    })

    await expect(service.checkInstalled(true)).resolves.toEqual([
      expect.objectContaining({
        status: 'unavailable',
        error: expect.stringContaining('代码仓库与已安装来源不一致')
      })
    ])
  })

  it('returns a stale previous result after a transient remote failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      name: 'example-plugin',
      version: '1.3.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } }
    }))
    const { service } = fixture()
    await service.checkInstalled(true)
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network unavailable'))

    await expect(service.checkInstalled(true)).resolves.toEqual([
      expect.objectContaining({
        status: 'available',
        latestVersion: '1.3.0',
        stale: true,
        error: expect.stringContaining('network unavailable')
      })
    ])
  })
})
