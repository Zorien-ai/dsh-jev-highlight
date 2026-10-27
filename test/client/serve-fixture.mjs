/**
 * Tiny static server for the highlight fixture.
 *
 * Usage: node test/client/serve-fixture.mjs [port]
 * Serves:
 *   /                                      -> test/client/highlight-fixture.html
 *   /test/client/fixture-driver.js         -> the fixture harness
 *   /lib/client.js                         -> the esbuild browser bundle (built first)
 */

import { createServer } from 'node:http'
import { stat, readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..', '..')

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
}

const ALLOWED_FILES = new Set([
  join(here, 'highlight-fixture.html'),
  join(here, 'fixture-driver.js'),
  join(projectRoot, 'lib', 'client.js'),
])

const port = Number(process.argv[2] ?? process.env.PORT ?? 8123)

function safeResolve(pathname) {
  const decoded = decodeURIComponent(pathname)
  if (decoded === '/' || decoded === '/test/client/highlight-fixture.html') return join(here, 'highlight-fixture.html')
  const absolute = normalize(resolve(projectRoot, '.' + decoded))
  if (!absolute.startsWith(projectRoot + sep)) return null
  return ALLOWED_FILES.has(absolute) ? absolute : null
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const file = safeResolve(url.pathname)
  if (file === null) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
    return
  }
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
    const body = await readFile(file)
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    response.end(body)
  } catch (error) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`not found: ${String(error)}`)
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`fixture server: http://127.0.0.1:${String(port)}/test/client/highlight-fixture.html`)
})
