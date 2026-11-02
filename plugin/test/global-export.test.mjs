import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
const source=readFileSync(new URL('../index.js',import.meta.url),'utf8')
const block=source.slice(source.indexOf('  const globalExportPath ='),source.indexOf('  const buffers = new Map()'))
function setup(saved=[],existing=[]) {
 let file=JSON.stringify(saved),callback
 const rows=new Map(existing.map(id=>[id,{id}]))
 const registry={async list(){return [...rows.values()]},async register(def){rows.set(def.id,{id:def.id});return ()=>rows.delete(def.id)}}
 const ctx={get:()=>registry,inject(_deps,cb){callback=cb},logger:{warn(){}}}
 const factory=new Function('ctx','dataDir','join','resolve','homedir','readFileSync','writeFileSync','mkdirSync','BUILTIN_PRESETS',block+';return exportBuiltin')
 const exportPreset=factory(ctx,'test',join,resolve,()=>'',()=>file,(_p,data)=>{file=data},()=>{},[{id:'es',plugins:[]}])
 return {exportPreset,rows,saved:()=>JSON.parse(file),restore(){let cleanup;callback({effect(fn){cleanup=fn()}});return async()=>{await new Promise(r=>setImmediate(r));return cleanup}}}
}
test('export registers globally and persists only explicit exports; repeated export is idempotent',async()=>{
 const state=setup();assert.equal(state.rows.size,0)
 await Promise.all([state.exportPreset('es'),state.exportPreset('es')])
 assert.equal(state.rows.size,1);assert.deepEqual(state.saved(),['es'])
 const restored=setup(state.saved());const cleanup=await restored.restore()();assert.ok(restored.rows.has('es'));await cleanup()
})
test('existing global preset is never overwritten',async()=>{
 const state=setup([],['es']);await assert.rejects(state.exportPreset('es'),/同名/);assert.deepEqual(state.saved(),[])
})
