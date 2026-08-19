const gitHeadPattern = /([a-f0-9]{40}) HEAD(?:\0|[\r\n])/i

export function parseGitHeadAdvertisement(advertisement: string): string {
  const commit = advertisement.match(gitHeadPattern)?.[1]
  if (!commit) throw new Error('GitHub 没有返回完整 HEAD commit SHA')
  return commit.toLowerCase()
}

export async function resolveGithubHeadCommit(
  owner: string,
  repository: string,
  userAgent: string
): Promise<string> {
  const response = await fetch(
    `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}.git/info/refs?service=git-upload-pack`,
    {
      headers: {
        Accept: 'application/x-git-upload-pack-advertisement',
        'User-Agent': userAgent
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000)
    }
  )
  if (!response.ok) {
    throw new Error(`解析 GitHub commit 失败：HTTP ${response.status}`)
  }
  const finalUrl = new URL(response.url)
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname.toLowerCase() !== 'github.com') {
    throw new Error('GitHub commit 查询被重定向到不受信任的地址')
  }
  return parseGitHeadAdvertisement(await response.text())
}
