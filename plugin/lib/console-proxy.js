// Console HTTP proxy: expose a whitelisted subset of the core API to the UI.
// Contract defined by plugin/test/console-proxy.test.mjs

const BASE = '/office-console/api'

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function send(res, status, payload) {
  res.writeHead(status)
  res.end(payload === undefined ? undefined : JSON.stringify(payload))
}

export function registerConsoleRoutes(webServer, manager, helpers = {}) {
  const definition = {
    path: BASE,
    handler: async (req, res) => {
      const url = new URL(req.url || BASE, 'http://localhost')
      const method = (req.method || 'GET').toUpperCase()
      const sub = url.pathname.slice(BASE.length) || '/'
      const query = url.search || ''
      try {
        const body = method === 'POST' ? await readBody(req) : undefined

        if (sub === '/projects' && method === 'GET') {
          return send(res, 200, await manager.request('GET', '/v1/projects'))
        }

        // 记忆查询面：搜索 / 最近 / 简报 / 按 id 取。
        // 之前白名单缺这几个，控制台界面够不到核心已实现的能力。
        if (sub === '/search' && method === 'GET') {
          return send(res, 200, await manager.request('GET', `/v1/search${query}`))
        }

        if (sub === '/recent' && method === 'GET') {
          return send(res, 200, await manager.request('GET', `/v1/recent${query}`))
        }

        if (sub === '/brief' && method === 'GET') {
          return send(res, 200, await manager.request('GET', `/v1/brief${query}`))
        }

        const getMatch = sub.match(/^\/get\/(.+)$/)
        if (getMatch && method === 'GET') {
          const id = encodeURIComponent(decodeURIComponent(getMatch[1]))
          return send(res, 200, await manager.request('GET', `/v1/get/${id}`))
        }

        const noteMatch = sub.match(/^\/notes\/(.+)$/)
        if (noteMatch && method === 'GET') {
          const id = encodeURIComponent(decodeURIComponent(noteMatch[1]))
          return send(res, 200, await manager.request('GET', `/v1/notes/${id}`))
        }

        if (sub === '/org' && method === 'GET') {
          const payload = helpers.org
            ? await helpers.org(url.searchParams.get('project'))
            : { roots: [], nodes: [] }
          return send(res, 200, payload)
        }

        if (sub === '/presets' && method === 'GET') {
          const payload = helpers.presets ? await helpers.presets() : { presets: [] }
          return send(res, 200, payload)
        }

        const presetMatch = sub.match(/^\/presets\/(.+)$/)
        if (presetMatch && method === 'GET') {
          const payload = helpers.presetDocument
            ? await helpers.presetDocument(decodeURIComponent(presetMatch[1]))
            : { agentPreset: decodeURIComponent(presetMatch[1]) }
          return send(res, 200, payload)
        }

        if (sub === '/agent-names') {
          if (method === 'GET') {
            return send(res, 200, await manager.request('GET', `/v1/agent-names${query}`))
          }
          if (method === 'POST') {
            return send(res, 200, await manager.request('POST', '/v1/agent-names', body))
          }
        }

        if (sub === '/project-presets') {
          if (method === 'GET') {
            return send(res, 200, await manager.request('GET', `/v1/project-presets${query}`))
          }
          if (method === 'POST') {
            return send(res, 200, await manager.request('POST', '/v1/project-presets', body))
          }
        }

        const projectPresetMatch = sub.match(/^\/project-presets\/(.+)$/)
        if (projectPresetMatch && method === 'DELETE') {
          const presetId = encodeURIComponent(decodeURIComponent(projectPresetMatch[1]))
          return send(res, 200, await manager.request('DELETE', `/v1/project-presets/${presetId}${query}`))
        }

        if (sub === '/summarize/preview' && method === 'GET') {
          return send(res, 200, await manager.request('GET', `/v1/summarize/preview${query}`))
        }

        // 真压缩：preview 是 dry-run，POST /compress 需 confirm=true 才落库。
        if (sub === '/compress/preview' && method === 'GET') {
          return send(res, 200, await manager.request('GET', `/v1/compress/preview${query}`))
        }

        if (sub === '/compress' && method === 'POST') {
          return send(res, 200, await manager.request('POST', '/v1/compress', body))
        }

        if (sub === '/summarize' && method === 'POST') {
          return send(res, 200, await manager.request('POST', '/v1/summarize', body))
        }

        if (sub === '/taskboard') {
          if (method === 'GET') {
            return send(res, 200, await manager.request('GET', `/v1/taskboard${query}`))
          }
          if (method === 'POST') {
            return send(res, 200, await manager.request('POST', '/v1/taskboard', body))
          }
        }

        const taskMatch = sub.match(/^\/taskboard\/([^/]+)$/)
        if (taskMatch && method === 'DELETE') {
          return send(
            res,
            200,
            await manager.request('DELETE', `/v1/taskboard/${encodeURIComponent(taskMatch[1])}`)
          )
        }

        if (sub === '/conventions') {
          if (method === 'GET') {
            return send(res, 200, await manager.request('GET', `/v1/conventions${query}`))
          }
          if (method === 'POST') {
            return send(res, 200, await manager.request('POST', '/v1/conventions', body))
          }
        }

        const conventionMatch = sub.match(/^\/conventions\/([^/]+)$/)
        if (conventionMatch && method === 'DELETE') {
          return send(
            res,
            200,
            await manager.request('DELETE', `/v1/conventions/${encodeURIComponent(conventionMatch[1])}`)
          )
        }

        if (sub === '/audit' && method === 'GET') {
          return send(res, 200, await manager.request('GET', `/v1/audit${query}`))
        }

        if (sub === '/archive' && method === 'POST') {
          return send(res, 200, await manager.request('POST', '/v1/archive', body))
        }

        if (sub === '/recycle') {
          if (method === 'GET') {
            return send(res, 200, await manager.request('GET', `/v1/recycle${query}`))
          }
          if (method === 'POST') {
            return send(res, 200, await manager.request('POST', '/v1/recycle', body))
          }
        }

        if (sub === '/restore' && method === 'POST') {
          return send(res, 200, await manager.request('POST', '/v1/restore', body))
        }

        if (sub === '/stats' && method === 'GET') {
          return send(res, 200, await manager.request('GET', `/v1/stats${query}`))
        }

        if (sub === '/artifacts') {
          if (method === 'GET') {
            return send(res, 200, await manager.request('GET', `/v1/artifacts${query}`))
          }
          if (method === 'POST') {
            return send(res, 200, await manager.request('POST', '/v1/artifacts', body))
          }
        }

        if (sub === '/roles' && method === 'GET') {
          return send(res, 200, await manager.request('GET', `/v1/roles${query}`))
        }

        if (sub === '/cold' && method === 'GET') {
          return send(res, 200, await manager.request('GET', `/v1/cold${query}`))
        }

        if (sub === '/purge' && method === 'POST') {
          return send(res, 200, await manager.request('POST', '/v1/purge', body))
        }

        if (sub === '/advice') {
          if (method === 'GET') {
            return send(res, 200, await manager.request('GET', `/v1/advice${query}`))
          }
          if (method === 'POST') {
            return send(res, 200, await manager.request('POST', '/v1/advice', body))
          }
        }

        const adviceMatch = sub.match(/^\/advice\/([^/]+)\/(delivered|decision)$/)
        if (adviceMatch && method === 'POST') {
          const adviceId = encodeURIComponent(adviceMatch[1])
          const action = adviceMatch[2]
          return send(
            res,
            200,
            await manager.request('POST', `/v1/advice/${adviceId}/${action}`, body)
          )
        }

        return send(res, 404, { error: 'not found' })
      } catch (error) {
        return send(res, 500, { error: error && error.message ? error.message : String(error) })
      }
    }
  }

  const dispose = webServer.register(definition)
  return dispose
}
