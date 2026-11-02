import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { apply } from '../tools.js'
const runtime = process.env.DSH_TOOLS_MODULE
const schemas = runtime ? await import(pathToFileURL(runtime).href) : null
for (const role of ['es','gm','dm']) {
  test(`${role} tools provide complete raw JSON schemas`, () => {
    const definitions=[]
    apply({tools:{register(definition){definitions.push(definition)}}},{role})
    assert.ok(definitions.length > 0)
    for (const tool of definitions) {
      assert.equal(tool.parameters.type,'object',tool.name)
      assert.ok(tool.parameters.properties)
      assert.deepEqual(tool.output.schema,{})
      assert.equal(typeof tool.output.render,'function')
      if (schemas) {
        schemas.assertObjectJsonSchema(tool.parameters)
        schemas.assertSupportedJsonSchema(tool.output.schema)
        assert.deepEqual(schemas.validateJsonSchemaValue(tool.parameters,{assignments:{dm:'check'}},''),[])
      }
    }
  })
}
