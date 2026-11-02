import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
for (const directory of ['plugin','dsh-office-local']) {
 test(`${directory} keeps builtins outside global startup composition`,()=>{
  const base=new URL(`../../${directory}/`,import.meta.url)
  const patch=JSON.parse(readFileSync(new URL('cordis.patch.yml',base),'utf8'))
  assert.ok(patch.every(p=>(p.insert||[]).every(row=>row.name!=='@deepseek-ai/dsh-agent-preset')))
  const definitions=JSON.parse(readFileSync(new URL('builtin-presets.json',base),'utf8'))
  assert.deepEqual(definitions.map(p=>p.id),['es','gm','dm'])
  for(const definition of definitions) assert.ok(definition.plugins.length>0)
 })
}
