import { describe, expect, it } from 'vitest'
import { parseGitHeadAdvertisement } from '../src/main/github-reference-service'

describe('GitHub reference resolution', () => {
  it('reads HEAD from a Git Smart HTTP v0 advertisement', () => {
    const commit = 'DD7EF5ED160AA1A624559DE16EAFD4EA9406D7ED'
    const advertisement =
      '001e# service=git-upload-pack\n0000' +
      `015b${commit} HEAD\0multi_ack thin-pack symref=HEAD:refs/heads/main\n` +
      `003f${commit} refs/heads/main\n0000`

    expect(parseGitHeadAdvertisement(advertisement)).toBe(commit.toLowerCase())
  })

  it('rejects advertisements without a complete HEAD commit', () => {
    expect(() => parseGitHeadAdvertisement('001e# service=git-upload-pack\n0000'))
      .toThrow('完整 HEAD commit SHA')
  })
})
