// Core process manager: spawn the Python core, talk to it over localhost HTTP.
// Contract defined by plugin/test/core.test.mjs and host.test.mjs

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const CANDIDATE_NAMES = ['python3', 'python', 'py']

function probe(cmd) {
  if (!cmd) return false
  try {
    const result = spawnSync(cmd, ['-c', 'import sys;print(sys.version_info[0])'], {
      stdio: 'ignore',
      timeout: 8000,
      windowsHide: true
    })
    return result.status === 0
  } catch {
    return false
  }
}

export function pythonCandidates(env = {}) {
  const explicit = []
  for (const key of ['DSH_PYTHON', 'PYTHON', 'python']) {
    if (env && typeof env[key] === 'string' && env[key].trim()) explicit.push(env[key].trim())
  }
  const found = []
  for (const name of [...explicit, ...CANDIDATE_NAMES]) {
    if (probe(name)) found.push(name)
  }
  return [...new Set(found)]
}

export class CoreManager {
  constructor({ coreDir, dataDir, python, env } = {}) {
    this.coreDir = coreDir
    this.dataDir = dataDir
    this.python = python
    this.env = env || {}
    this.child = null
    this.port = null
    this.baseUrl = null
  }

  get runDir() {
    return join(this.dataDir, '.run')
  }

  get coreInfoPath() {
    return join(this.runDir, 'core.json')
  }

  async start() {
    if (this.baseUrl) return this
    mkdirSync(this.runDir, { recursive: true })
    // 单实例：已有健康核心则复用，避免起第二个
    const existing = await this.tryExistingCore()
    if (existing) {
      this.port = existing.port
      this.baseUrl = `http://127.0.0.1:${existing.port}`
      return this
    }
    try {
      rmSync(this.coreInfoPath, { force: true })
    } catch {
      /* best effort */
    }
    const python = this.python || pythonCandidates(this.env)[0]
    if (!python) throw new Error('no Python interpreter found')
    this.child = spawn(python, ['-m', 'secretary_core.cli', 'serve', '--data-dir', this.dataDir], {
      cwd: this.coreDir,
      env: { ...process.env, PYTHONPATH: this.coreDir, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child.stdout?.on('data', () => {})
    this.child.stderr?.on('data', () => {})
    this.child.on('exit', () => {
      this.child = null
    })
    const info = await this.waitForCoreInfo()
    this.port = info.port
    this.baseUrl = `http://127.0.0.1:${info.port}`
    return this
  }

  async tryExistingCore() {
    if (!existsSync(this.coreInfoPath)) return null
    try {
      const info = JSON.parse(readFileSync(this.coreInfoPath, 'utf8'))
      if (!info || !info.port) return null
      const response = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
        signal: AbortSignal.timeout(1500)
      })
      if (response.ok) return info
    } catch {
      /* stale or unreachable */
    }
    return null
  }

  async waitForCoreInfo(timeoutMs = 20000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (existsSync(this.coreInfoPath)) {
        try {
          const info = JSON.parse(readFileSync(this.coreInfoPath, 'utf8'))
          if (info && info.port) return info
        } catch {
          /* still being written */
        }
      }
      await delay(50)
    }
    throw new Error('core did not become ready in time')
  }

  async sendRawEvent(event) {
    // 先落原始事件仓（可重放），核心再归一化成 turn
    return this.request('POST', '/v1/raw-events', event)
  }

  async request(method, path, body) {
    if (!this.baseUrl) await this.start()
    const init = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const response = await fetch(`${this.baseUrl}${path}`, init)
    const text = await response.text()
    const payload = text ? safeParse(text) : undefined
    if (!response.ok) {
      const detail = payload ? JSON.stringify(payload) : text
      throw new Error(`core ${method} ${path} -> ${response.status}: ${detail}`)
    }
    return payload
  }

  dispose() {
    const child = this.child
    this.child = null
    this.baseUrl = null
    this.port = null
    if (child) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
