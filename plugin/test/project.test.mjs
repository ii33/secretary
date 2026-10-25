import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { projectForCwd, readProjectConfig } from '../lib/project.js'

test('reads .dsh/office.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'office-project-'))
  try {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'office.json'), JSON.stringify({ project: 'coating-sim' }), 'utf8')
    assert.equal(projectForCwd(root), 'coating-sim')
    assert.equal(readProjectConfig(root).source, 'office.json')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('falls back to basename', () => {
  const root = mkdtempSync(join(tmpdir(), 'office-project-'))
  try {
    const name = root.split(/[\\/]/u).pop()
    assert.equal(projectForCwd(root), name.replace(/[^A-Za-z0-9._-]+/gu, '-'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
