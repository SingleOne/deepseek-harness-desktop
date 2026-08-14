import net from 'node:net'

export function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('无法分配本地端口'))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}
