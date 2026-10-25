// Lightweight client for an already-running core process.
// Contract defined by plugin/test/host.test.mjs

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export class CoreClient {
  constructor({ dataDir, coreDir } = {}) {
    this.dataDir = dataDir
    this.coreDir = coreDir
    this.baseUrl = null
  }

  get coreInfoPath() {
    return join(this.dataDir, '.run', 'core.json')
  }

  async ensure(timeoutMs = 15000) {
    if (this.baseUrl) return this
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (existsSync(this.coreInfoPath)) {
        try {
          const info = JSON.parse(readFileSync(this.coreInfoPath, 'utf8'))
          if (info && info.port) {
            this.baseUrl = `http://127.0.0.1:${info.port}`
            return this
          }
        } catch {
          /* core.json may be mid-write */
        }
      }
      await delay(50)
    }
    throw new Error('core is not available yet')
  }

  async request(method, path, body) {
    if (!this.baseUrl) await this.ensure()
    const init = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const response = await fetch(`${this.baseUrl}${path}`, init)
    const text = await response.text()
    const payload = text ? safeParse(text) : undefined
    if (!response.ok) {
      throw new Error(`core ${method} ${path} -> ${response.status}: ${text}`)
    }
    return payload
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
