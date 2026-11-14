// A model server of the user's, as Ollama or llama.cpp serve OpenAI's API (HI-3197), for the dataserver suite: GET
// /v1/models lists its models, POST /v1/chat/completions answers each request; every request is kept (its path, its
// Authorization header and its body), so a suite reads what a CLI sent. Local only (127.0.0.1, a port of its own).
const http = require('http')

/** Starts the stub; resolves with its base URL (…/v1), the requests it took, and close(). */
function startStub(models = ['qwen3:8b', 'big-model-300b']) {
  const requests = []
  const server = http.createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      let body = null
      try {
        body = data ? JSON.parse(data) : null
      } catch {
        body = data
      }
      requests.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? null, body })
      res.setHeader('content-type', 'application/json')
      if (req.method === 'GET' && req.url === '/v1/models') return res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }))
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const model = body && typeof body === 'object' ? body.model : null
        return res.end(JSON.stringify({ id: 'stub-1', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: `stub answer from ${model}` }, finish_reason: 'stop' }] }))
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(() => r())) })
    })
  )
}

module.exports = { startStub }
