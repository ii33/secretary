// Derive membership from the project's actual delegation tree.
export function flatMembers(roots, previous = []) {
  const knownMain = previous.find(m=>m.role==='main')
  const retained = roots.find(node=>node.id===knownMain?.session_id)
  const esRoots = roots.filter(node => ['es','secretary'].includes(node.preset))
  const candidates = retained ? [retained] : esRoots.length ? esRoots : roots.filter(node=>(node.children||[]).length>0)
  if (candidates.length > 1) throw new Error('项目存在多个候选顶级会话，无法唯一识别主代理')
  if (!candidates.length) return []
  const members = []
  const visit = (node, role) => {
    const existing = previous.find(m=>m.session_id===node.id)
    members.push({id:existing?.id || node.id,session_id:node.id,name:node.title || node.id,preset:node.preset || 'generic',role})
    for (const child of node.children || []) visit(child,'child')
  }
  visit(candidates[0],'main')
  return members
}
