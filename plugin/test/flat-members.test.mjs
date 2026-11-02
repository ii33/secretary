import test from 'node:test'
import assert from 'node:assert/strict'
import {flatMembers} from '../lib/flat-members.js'
test('delegated members are discovered recursively without unrelated top-level sessions',()=>{
 const members=flatMembers([{id:'main',preset:'es',children:[{id:'child',preset:'custom',children:[{id:'nested',preset:'dm'}]}]},{id:'other',preset:'advisor'}],[{id:'stable-id',session_id:'child'}])
 assert.deepEqual(members.map(m=>[m.id,m.role,m.preset]),[['main','main','es'],['stable-id','child','custom'],['nested','child','dm']])
})
test('ambiguous roots fail; empty projects wait for delegation',()=>{
 assert.throws(()=>flatMembers([{id:'a',preset:'es'},{id:'b',preset:'es'}]),/多个候选/)
 assert.deepEqual(flatMembers([]),[])
})
test('existing main identity and custom main preset are supported',()=>{
 const roots=[{id:'custom',preset:'custom-main',children:[{id:'child',preset:'worker'}]}]
 assert.equal(flatMembers(roots)[0].session_id,'custom')
 assert.equal(flatMembers([...roots,{id:'es',preset:'es'}],[{id:'stable',session_id:'custom',role:'main'}])[0].id,'stable')
})
