import assert from 'node:assert/strict'
import test from 'node:test'

test('client module registers the main panel and sidebar icon', async () => {
  let loaded
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition
      }
    }
  }
  try {
    await import('../client.js')
    assert.equal(loaded.id, '@local/dsh-office')
    const React = {
      createElement() {},
      useCallback: (fn) => fn,
      useEffect() {},
      useMemo: (fn) => fn(),
      useState: (value) => [value, () => {}]
    }
    const module = loaded.factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require: ${name}`)
    })
    assert.deepEqual(module.inject, ['slots', 'locale', 'uiWorkspace'])
    const registrations = []
    const injected = []
    const ctx = {
      locale: {
        bind: () => (key) => key,
        register: () => () => {}
      },
      slots: {
        inject(name, callback) {
          injected.push(name)
          callback()
        },
        register(definition) {
          registrations.push(definition)
          return () => {}
        }
      },
      uiWorkspace: {
        openSession() {}
      },
      effect(callback) {
        return callback()
      }
    }
    module.apply(ctx)
    assert.deepEqual(injected.sort(), ['main', 'sidebar.panellist'])
    const main = registrations.find((item) => item.name === 'main')
    const sidebar = registrations.find((item) => item.name === 'sidebar.panellist')
    assert.equal(main.key, 'office-console')
    assert.equal(sidebar.id, 'office-console')
    assert.equal(sidebar.label(), 'title')
  } finally {
    delete globalThis.window
  }
})
