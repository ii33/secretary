// DSH host adapter: wire session events into the secretary core.
// Contract defined by plugin/test/host.test.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { registerConsoleRoutes } from './lib/console-proxy.js'
import { CoreManager } from './lib/core.js'
import { projectForCwd } from './lib/project.js'
import { TurnBuffer, eventsToEnvelopes } from './lib/turns.js'

const TARGET_PRESETS = ['secretary', 'gm']

/**
 * DSH 把「已归档会话」记在 ~/.dsh/storages/workspace.json 的
 * global.archivedSessionIds（不在 session 文件里）。这里读出来用于过滤。
 */
function readArchivedSessionIds() {
  const homes = []
  if (process.env.DSH_HOME) homes.push(process.env.DSH_HOME)
  homes.push(join(homedir(), '.dsh'))
  const ids = new Set()
  for (const home of homes) {
    for (const file of [
      join(home, 'storages', 'workspace.json'),
      join(home, 'profiles', 'desktop', 'storages', 'workspace.json'),
    ]) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        const list = data && data.global && data.global.archivedSessionIds
        if (Array.isArray(list)) {
          for (const item of list) ids.add(item)
        }
      } catch {
        /* 尝试下一个候选路径 */
      }
    }
  }
  return ids
}

/** 归档 id 前缀不敏感匹配（`session-xxx` 与 `xxx` 视为同一个）。 */
function isArchivedId(archivedIds, id) {
  if (!id) return false
  if (archivedIds.has(id)) return true
  const bare = String(id).replace(/^session-/, '')
  return archivedIds.has(bare) || archivedIds.has(`session-${bare}`)
}

/**
 * 会话的收录方式（用「深度 + 该轮实际 preset」判断，避免会话中途切换预设时误判）：
 *   - 'hot'   ES↔用户（顶层 secretary）→ 热记忆
 *   - 'cold'  ES↔GM（delegationDepth=1）→ 直接进冷备
 *   - 'skip'  顾问 / 普通会话 / GM↔DM↔worker（depth>=2）→ 不收录
 */
function captureMode(depth, preset) {
  const known = preset || ''
  if (depth === undefined || depth === null) {
    // 没有深度信息：按预设兜底
    if (known === 'secretary') return 'hot'
    if (known === 'gm') return 'cold'
    return 'skip'
  }
  if (depth <= 0) {
    // 顶层：只有 ES(secretary) 进热记忆；顾问、普通会话不收录
    return known === 'secretary' ? 'hot' : 'skip'
  }
  if (depth === 1) return 'cold'
  return 'skip'
}

// 项目简报缓存：project -> { text, at }。
// systemPrompt 的 text() 是同步函数，不能在里面 await，所以采用
// "缓存 + 后台刷新（stale-while-revalidate）"：有缓存先返回（哪怕略旧），
// 同时异步刷新；没有缓存时返回含「项目简报」标题的兜底文案。
const BRIEF_TTL_MS = 60_000
const briefCache = new Map()

function fallbackBrief(project) {
  return [
    '## 项目简报',
    '',
    `项目：${project}`,
    '记忆由 secretary-core 维护；回答前可参考项目历史与约定。'
  ].join('\n')
}

function briefFor(cwd) {
  const project = cwd ? projectForCwd(cwd) : 'default'
  const cached = briefCache.get(project)
  if (cached) return cached.text
  return fallbackBrief(project)
}

/** 后台刷新某个项目的简报；失败静默（下次再试）。 */
const refreshing = new Set()
async function refreshBrief(manager, project) {
  // 核心尚未就绪时直接跳过，避免触发重复 spawn。
  if (!project || !manager.baseUrl) return
  // 同一项目已有刷新在飞时不再叠加。
  if (refreshing.has(project)) return
  refreshing.add(project)
  try {
    const res = await manager.request('GET', `/v1/brief?project=${encodeURIComponent(project)}`)
    if (res && typeof res.text === 'string' && res.text.trim()) {
      briefCache.set(project, { text: res.text, at: Date.now() })
    }
  } catch {
    /* core 未就绪或项目无数据：保留旧缓存 */
  } finally {
    refreshing.delete(project)
  }
}

/** 刷新全部已知项目 + 指定项目的简报。 */
async function refreshBriefs(manager, extraProject) {
  const projects = new Set()
  if (extraProject) projects.add(extraProject)
  try {
    const res = await manager.request('GET', '/v1/projects')
    for (const row of res?.projects || []) {
      if (row && row.id) projects.add(String(row.id))
    }
  } catch {
    /* ignore */
  }
  await Promise.all([...projects].map((project) => refreshBrief(manager, project)))
}

function briefIsStale(project) {
  const cached = briefCache.get(project)
  return !cached || Date.now() - cached.at > BRIEF_TTL_MS
}

/** 从会话快照里取最后的 session/title。 */
function pickSessionTitle(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.events)) return ''
  let title = ''
  for (const event of snapshot.events) {
    if (event && event.type === 'session/title') {
      title = (event.data && (event.data.title || event.data.text)) || title
    }
  }
  return title
}

/** 会话是否有实际内容（有标题，或至少一条用户消息）；空会话不入树。 */
function hasSessionContent(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.events)) return false
  for (const event of snapshot.events) {
    if (!event) continue
    if (event.type === 'session/title') return true
    if (event.type === 'user/message') {
      const kind = event.data && event.data.source && event.data.source.kind
      if (!kind || kind === 'user') return true
    }
  }
  return false
}

/**
 * 用 host 的 sessionQuery 构建「ES/顾问 → GM → DM → worker」会话树。
 * 返回根节点数组（每个节点含 id/title/preset/parentId/children）；无法构建时返回 null。
 */
async function buildOrgTree(ctx, project) {
  const sessionQuery = ctx.get('sessionQuery')
  if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return null
  let sessions = []
  try {
    sessions = await sessionQuery.listSessions()
  } catch {
    return null
  }
  const archivedIds = readArchivedSessionIds()
  const flat = []
  for (const entry of sessions || []) {
    const header = (entry && entry.header) || entry || {}
    const id = header.id
    if (!id) continue
    let snapshot = null
    try {
      snapshot = await sessionQuery.readSession(id)
    } catch {
      snapshot = null
    }
    const session = (snapshot && snapshot.session) || {}
    // cwd / parent / depth 都在 session 首行里，字段名兼容多种写法。
    const cwd =
      session.cwd || (session.identity && session.identity.cwd) ||
      header.cwd || (header.identity && header.identity.cwd) || ''
    const parent =
      session.parentSession || session.parentSessionId ||
      header.parentSession || header.parentSessionId || ''
    const depthRaw =
      typeof session.delegationDepth === 'number' ? session.delegationDepth
      : typeof header.delegationDepth === 'number' ? header.delegationDepth
      : undefined
    const depth = depthRaw === undefined ? (parent ? 1 : 0) : depthRaw
    const preset = session.agentPreset || header.agentPreset || ''
    const title = header.title || session.title || pickSessionTitle(snapshot) || ''
    const archived =
      isArchivedId(archivedIds, id) ||
      header.archived === true || session.archived === true ||
      header.isArchived === true || session.isArchived === true ||
      Boolean(header.archivedAt) || Boolean(session.archivedAt) ||
      header.state === 'archived' || session.state === 'archived'
    if (archived) continue
    // 只保留当前项目；拿不到 cwd 的无法判定项目，跳过，避免串项目。
    if (project && !cwd) continue
    if (project && projectForCwd(cwd) !== project) continue
    // 空会话（没有标题、也没有用户消息）不入树，避免一堆空白项。
    if (!hasSessionContent(snapshot)) continue
    flat.push({ id, title, preset, parent, depth, cwd })
  }
  if (flat.length === 0) return null
  const byId = new Map(flat.map((node) => [node.id, { ...node, children: [] }]))
  const roots = []
  for (const node of byId.values()) {
    if (node.parent && byId.has(node.parent)) {
      byId.get(node.parent).children.push(node)
    } else {
      roots.push(node)
    }
  }
  // 顶层排序：ES(secretary) → 顾问(advisor) → 普通会话
  const rank = (preset) => (preset === 'secretary' ? 0 : preset === 'advisor' ? 1 : 2)
  roots.sort((a, b) => rank(a.preset) - rank(b.preset))
  for (const node of byId.values()) {
    if (node.children.length > 1) {
      node.children.sort((a, b) => (a.depth || 0) - (b.depth || 0))
    }
  }
  return roots
}

/** 把人员架构结果写一份快照，便于排查「归档会话为何仍在」这类问题。 */
function dumpOrgDebug(project, tree) {
  try {
    const ids = readArchivedSessionIds()
    const flatten = (node) => ({
      id: node.id,
      title: node.title,
      preset: node.preset,
      parent: node.parent || '',
      depth: node.depth,
      children: (node.children || []).map(flatten)
    })
    const payload = {
      project,
      archivedIds: [...ids],
      roots: tree.map(flatten)
    }
    writeFileSync(
      join(homedir(), '.secretary-office', 'org-debug.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    )
  } catch {
    /* 调试快照失败不影响主流程 */
  }
}

async function backfillHistory(ctx, manager) {
  const sessionQuery = ctx.get('sessionQuery')
  if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return
  let sessions = []
  try {
    sessions = await sessionQuery.listSessions()
  } catch {
    return
  }
  for (const entry of sessions || []) {
    const header = entry.header || entry
    if (!header || !header.id) continue
    let snapshot
    try {
      snapshot = await sessionQuery.readSession(header.id)
    } catch {
      continue
    }
    if (!snapshot) continue
    const cwd = (snapshot.session && snapshot.session.cwd) || header.cwd
    const project = cwd ? projectForCwd(cwd) : 'default'
    const depth =
      snapshot.session && typeof snapshot.session.delegationDepth === 'number'
        ? snapshot.session.delegationDepth
        : typeof header.delegationDepth === 'number'
          ? header.delegationDepth
          : undefined
    const envelopes = eventsToEnvelopes(snapshot, project, 'dsh', { targetPresets: TARGET_PRESETS })
    for (const envelope of envelopes) {
      // 用该轮实际 preset 判断收录方式
      const mode = captureMode(depth, envelope.payload.preset)
      if (mode === 'skip') continue
      if (mode === 'cold') envelope.cold = true
      try {
        await manager.sendRawEvent(envelope)
      } catch {
        /* skip individual failures */
      }
    }
  }
}

export function apply(ctx, options = {}) {
  const { coreDir, dataDir, python } = options
  const manager = new CoreManager({ coreDir, dataDir, python })
  const buffers = new Map()

  // 控制台 API：把 `/office-console/api/*` 白名单代理挂到宿主 webServer 上。
  // webServer 可能在插件加载后才就绪（历史问题是"只重试 5 次然后永久放弃"），
  // 所以这里持续重试直到拿到服务或插件被销毁。
  ctx.effect(() => {
    let disposeRoute
    let cancelled = false
    let timer
    const helpers = {
      async org(project) {
        try {
          const tree = await buildOrgTree(ctx, project)
          if (tree && tree.length > 0) {
            dumpOrgDebug(project, tree)
            return { roots: tree, nodes: [] }
          }
        } catch {
          /* fall through to workspace fallback */
        }
        try {
          const registry = ctx.get('workspaceRegistry')
          const workspaces = typeof registry?.list === 'function' ? registry.list() : []
          return {
            roots: workspaces.map((item) => ({
              id: item.id, title: item.title, path: item.path, preset: 'workspace', children: []
            })),
            nodes: []
          }
        } catch {
          return { roots: [], nodes: [] }
        }
      },
      async presets() {
        try {
          const presets = ctx.get('agentPresets')
          const rows = typeof presets?.list === 'function' ? await presets.list() : []
          return { presets: rows.map((row) => ({ id: row.id, name: row.name, description: row.description })) }
        } catch {
          return { presets: [] }
        }
      },
      async presetDocument(id) {
        try {
          const presets = ctx.get('agentPresets')
          const document = typeof presets?.readDocument === 'function' ? await presets.readDocument(id) : undefined
          return { agentPreset: id, ...(document ?? {}) }
        } catch {
          return { agentPreset: id }
        }
      }
    }
    const attach = () => {
      if (cancelled) return
      const webServer = ctx.get('webServer')
      if (webServer === undefined || typeof webServer.register !== 'function') {
        timer = setTimeout(attach, 1000)
        if (typeof timer.unref === 'function') timer.unref()
        return
      }
      try {
        disposeRoute = registerConsoleRoutes(webServer, manager, helpers)
      } catch (error) {
        ctx.logger?.warn?.(`office: 控制台路由注册失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    attach()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      try {
        if (typeof disposeRoute === 'function') disposeRoute()
      } catch {
        /* ignore */
      }
    }
  })

  ctx.effect(() => {
    const systemPrompt = ctx.get('systemPrompt')
    if (!systemPrompt || typeof systemPrompt.context !== 'function') return () => {}
    const dispose = systemPrompt.context({
      // rc.3 的 PromptContext 要求 name + 有限 order（缺任一都会在装配时抛错）。
      // order 100：紧跟 harness 身份与 persona 前缀之后、第一方指引之前。
      name: 'office:project-brief',
      order: 100,
      text: (arg) => {
        const session = arg && arg.agent && arg.agent.session
        const cwd = session && session.header ? session.header.cwd : undefined
        const project = cwd ? projectForCwd(cwd) : 'default'
        // 缓存过期就顺手在后台刷新（同步函数里不能 await）。
        if (briefIsStale(project)) {
          refreshBrief(manager, project).catch(() => {})
        }
        return briefFor(cwd)
      }
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  })

  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (!session || !session.id) return
      const header = session.header || {}
      const depth = typeof header.delegationDepth === 'number' ? header.delegationDepth : undefined
      let buffer = buffers.get(session.id)
      if (!buffer) {
        const cwd = header.cwd
        buffer = new TurnBuffer({
          sessionId: session.id,
          cwd,
          preset: header.agentPreset,
          project: cwd ? projectForCwd(cwd) : 'default'
        })
        buffers.set(session.id, buffer)
      }
      const envelope = buffer.consume(event)
      if (!envelope) return
      // 用该轮实际 preset 判断（会话可能中途切换预设）
      const mode = captureMode(depth, envelope.payload.preset)
      if (mode === 'skip') return
      if (mode === 'cold') envelope.cold = true
      manager
        .sendRawEvent(envelope)
        .then(() => refreshBrief(manager, envelope.project))
        .catch(() => {})
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  })

  ctx.effect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await manager.start()
      } catch {
        return
      }
      if (cancelled) return
      await backfillHistory(ctx, manager)
      if (cancelled) return
      // 启动后预热简报缓存，让第一轮对话就能看到真实项目简报。
      await refreshBriefs(manager)
    })()
    return () => {
      cancelled = true
      manager.dispose()
    }
  })
}

export default { apply }
