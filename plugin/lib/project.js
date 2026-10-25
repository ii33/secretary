// Project resolution: map a workspace cwd to a stable project id.
// Contract defined by plugin/test/project.test.mjs

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const PROJECT_ID_SAFE = /[^A-Za-z0-9._-]+/gu

export function sanitizeProjectName(name) {
  return String(name || '').replace(PROJECT_ID_SAFE, '-')
}

export function readProjectConfig(cwd) {
  const configPath = join(cwd, '.dsh', 'office.json')
  try {
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
      if (parsed && typeof parsed.project === 'string' && parsed.project.trim()) {
        return { project: parsed.project.trim(), source: 'office.json', path: configPath }
      }
    }
  } catch {
    // Malformed or unreadable config falls back to the directory name.
  }
  return { project: sanitizeProjectName(basename(cwd)), source: 'basename', path: null }
}

export function projectForCwd(cwd) {
  return readProjectConfig(cwd).project
}
