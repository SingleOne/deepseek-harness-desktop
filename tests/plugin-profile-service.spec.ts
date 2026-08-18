import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginProfileService } from '../src/main/plugin-profile-service'

let temporaryDshHome: string
let previousDshHome: string | undefined
let service: PluginProfileService

beforeEach(async () => {
  temporaryDshHome = await mkdtemp(path.join(tmpdir(), 'dsh-profile-update-test-'))
  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = temporaryDshHome
  service = new PluginProfileService()
  await mkdir(service.profileDirectory, { recursive: true })
})

afterEach(async () => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  await rm(temporaryDshHome, { recursive: true, force: true })
})

describe('plugin profile update safety', () => {
  it('restores backed-up files and removes files created after the snapshot', async () => {
    await writeFile(path.join(service.profileDirectory, 'package.json'), '{"before":true}', 'utf8')
    await writeFile(path.join(service.profileDirectory, 'pnpm-lock.yaml'), 'lockfileVersion: 9', 'utf8')
    await writeFile(path.join(service.profileDirectory, 'pnpm-workspace.yaml'), 'packages: []', 'utf8')
    const snapshot = await service.createSnapshot('example-plugin')

    await writeFile(path.join(service.profileDirectory, 'package.json'), '{"after":true}', 'utf8')
    await writeFile(path.join(service.profileDirectory, 'pnpm-lock.yaml'), 'changed: true', 'utf8')
    await writeFile(path.join(service.profileDirectory, 'cordis.patch.yml'), 'created: true', 'utf8')
    await service.restoreSnapshot(snapshot)

    await expect(readFile(path.join(service.profileDirectory, 'package.json'), 'utf8'))
      .resolves.toBe('{"before":true}')
    await expect(readFile(path.join(service.profileDirectory, 'pnpm-lock.yaml'), 'utf8'))
      .resolves.toBe('lockfileVersion: 9')
    await expect(readFile(path.join(service.profileDirectory, 'cordis.patch.yml'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('validates the installed version, bundle declaration, and patch file', async () => {
    const packageDirectory = path.join(service.profileDirectory, 'node_modules', 'example-plugin')
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(path.join(service.profileDirectory, 'package.json'), JSON.stringify({
      dependencies: { 'example-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['example-plugin'] } }
    }), 'utf8')
    await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'example-plugin',
      version: '1.1.0',
      repository: 'https://github.com/example/example-plugin',
      dsh: { bundle: { patch: './cordis.patch.yml' } }
    }), 'utf8')
    await writeFile(path.join(packageDirectory, 'cordis.patch.yml'), 'name: example', 'utf8')

    await expect(service.validatePlugin('example-plugin', '1.1.0')).resolves.toMatchObject({
      packageName: 'example-plugin',
      version: '1.1.0'
    })
    await expect(service.validatePlugin('example-plugin', '1.2.0'))
      .rejects.toThrow('预期为 1.2.0')
  })
})
