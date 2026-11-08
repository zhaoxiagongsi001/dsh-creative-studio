// 极简静态服务器：只服务本插件的 preview 目录（离线预览用）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve('D:/DSH/dsh-creative-studio/preview')
const PORT = 4791
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' }

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  const file = path.join(ROOT, url === '/' ? 'panel.html' : url)
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    res.end(buf)
  })
}).listen(PORT, '127.0.0.1', () => console.log(`preview on http://127.0.0.1:${PORT}`))
