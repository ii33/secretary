import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {projectForCwd} from '../lib/project.js'

test('only explicitly managed workspaces resolve, including their subdirectories',()=>{
 const dir=mkdtempSync(join(tmpdir(),'office-project-'))
 const previous=process.env.SECRETARY_OFFICE_HOME
 try {
  process.env.SECRETARY_OFFICE_HOME=dir
  const workspace=join(dir,'workspace')
  mkdirSync(join(workspace,'.dsh'),{recursive:true})
  writeFileSync(join(workspace,'.dsh','office.json'),JSON.stringify({project:'legacy-name'}))
  assert.equal(projectForCwd(workspace),null)
  writeFileSync(join(dir,'managed-projects.json'),JSON.stringify({projects:[{id:'managed',path:workspace}]}))
  assert.equal(projectForCwd(workspace),'managed')
  assert.equal(projectForCwd(join(workspace,'src')),'managed')
  assert.equal(projectForCwd(join(dir,'workspace-other')),null)
 } finally {
  if(previous===undefined)delete process.env.SECRETARY_OFFICE_HOME;else process.env.SECRETARY_OFFICE_HOME=previous
  rmSync(dir,{recursive:true,force:true})
 }
})
test('unknown and missing working directories are not managed',()=>{
 assert.equal(projectForCwd(),null)
 assert.equal(projectForCwd(join(tmpdir(),'unmanaged-office-project')),null)
})
