/**
 * Credential resolution: config → env → env → $DSH_HOME/.credentials.yaml.
 * Tests always inject env/dshHome; the real home file is never read.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MissingJevApiKeyError,
  MissingStartLuxApiKeyError,
  clearStartLuxKey,
  credentialsFilePath,
  parseCredentialsYaml,
  resolveDshHome,
  resolveJevApiKey,
  resolveStartLuxApiKey,
  saveStartLuxKey,
  startluxKeyFilePath,
} from '../../lib/index.js'

function makeTempHome(credentialsContent) {
  const home = mkdtempSync(join(tmpdir(), 'jev-creds-'))
  if (credentialsContent !== undefined) {
    writeFileSync(join(home, '.credentials.yaml'), credentialsContent, 'utf8')
  }
  return home
}

test('config key wins over environment and file', () => {
  const home = makeTempHome('jevApiKey: "from-file"\n')
  const credential = resolveJevApiKey({
    configKey: 'from-config',
    env: { JEV_API_KEY: 'from-env', TYPESAFE_API_KEY: 'from-typesafe' },
    dshHome: home,
  })
  assert.equal(credential.key, 'from-config')
  assert.equal(credential.source, 'config')
})

test('JEV_API_KEY is used when config is empty', () => {
  const credential = resolveJevApiKey({
    configKey: '   ',
    env: { JEV_API_KEY: ' from-env ', TYPESAFE_API_KEY: 'from-typesafe' },
    dshHome: makeTempHome(),
  })
  assert.equal(credential.key, 'from-env')
  assert.equal(credential.source, 'env:JEV_API_KEY')
})

test('TYPESAFE_API_KEY is the fallback environment variable', () => {
  const credential = resolveJevApiKey({ env: { TYPESAFE_API_KEY: 'ts-key' }, dshHome: makeTempHome() })
  assert.equal(credential.key, 'ts-key')
  assert.equal(credential.source, 'env:TYPESAFE_API_KEY')
})

test('credentials file top-level jevApiKey is read with quoted scalars', () => {
  const home = makeTempHome(
    [
      '# comment line',
      'otherKey: ignored',
      'jevApiKey: "quoted key with spaces"',
      'nested:',
      '  jevApiKey: "must be ignored"',
      '',
    ].join('\n'),
  )
  const credential = resolveJevApiKey({ env: {}, dshHome: home })
  assert.equal(credential.key, 'quoted key with spaces')
  assert.equal(credential.source, 'file:$DSH_HOME/.credentials.yaml')
})

test('credentials file supports single quotes and trailing comments', () => {
  assert.deepEqual(parseCredentialsYaml("jevApiKey: 'single-quoted'\n"), { jevApiKey: 'single-quoted' })
  assert.deepEqual(parseCredentialsYaml('jevApiKey: plain-value # comment\n'), { jevApiKey: 'plain-value' })
  assert.deepEqual(parseCredentialsYaml('jevApiKey: "a#b"\n'), { jevApiKey: 'a#b' })
  assert.deepEqual(parseCredentialsYaml('  jevApiKey: indented\n'), {})
  assert.deepEqual(parseCredentialsYaml('jevApiKey:\n'), {})
  assert.deepEqual(parseCredentialsYaml('   \n#x\n'), {})
  assert.deepEqual(parseCredentialsYaml('jevApiKey: "a\\"b"\n'), { jevApiKey: 'a"b' })
})

test('missing key throws a loud, actionable error without leaking a value', () => {
  const home = makeTempHome()
  let error
  try {
    resolveJevApiKey({ env: {}, dshHome: home })
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof MissingJevApiKeyError)
  assert.equal(error.code, 'JEV_API_KEY_MISSING')
  const expectedPath = join(home, '.credentials.yaml')
  assert.equal(error.credentialsPath, expectedPath)
  assert.match(error.message, /\.credentials\.yaml/u)
  assert.ok(error.message.includes(expectedPath))
  assert.match(error.message, /JEV_API_KEY/u)
  assert.match(error.message, /TYPESAFE_API_KEY/u)
  assert.match(error.message, /restart|retry/iu)
  assert.doesNotMatch(error.message, /secret|sk-/u)
})

test('unreadable credentials file still yields the missing-key error', () => {
  const home = mkdtempSync(join(tmpdir(), 'jev-creds-'))
  mkdirSync(join(home, '.credentials.yaml')) // a directory, not a readable file
  assert.throws(() => resolveJevApiKey({ env: {}, dshHome: home }), MissingJevApiKeyError)
})

test('resolveDshHome and credentialsFilePath follow $DSH_HOME', () => {
  assert.equal(resolveDshHome({ DSH_HOME: ' C:\\dsh-home ' }), 'C:\\dsh-home')
  assert.match(resolveDshHome({}), /\.dsh$/u)
  assert.equal(credentialsFilePath('C:\\dsh-home'), join('C:\\dsh-home', '.credentials.yaml'))
})

test('StartLux key: file save/clear round-trip and resolution order', () => {
  const home = makeTempHome()
  const keyFile = startluxKeyFilePath({ dshHome: home })
  assert.ok(keyFile.endsWith('jev-highlight-startlux.key'))
  assert.throws(() => resolveStartLuxApiKey({ env: {}, dshHome: home }), MissingStartLuxApiKeyError)

  const saved = saveStartLuxKey('bk-1234567890', keyFile)
  assert.equal(saved.ok, true)
  assert.equal(existsSync(keyFile), true)
  assert.deepEqual(resolveStartLuxApiKey({ env: {}, dshHome: home }), { key: 'bk-1234567890', source: 'settings:key-file' })

  // File wins over env.
  assert.equal(resolveStartLuxApiKey({ env: { STARTLUX_API_KEY: 'env-key' }, dshHome: home }).key, 'bk-1234567890')

  const cleared = clearStartLuxKey(keyFile)
  assert.equal(cleared.ok, true)
  assert.equal(existsSync(keyFile), false)
  assert.equal(resolveStartLuxApiKey({ env: { STARTLUX_API_KEY: 'env-key' }, dshHome: home }).source, 'env:STARTLUX_API_KEY')
  assert.equal(resolveStartLuxApiKey({ env: { BAMBOO_API_KEY: 'bamboo-key' }, dshHome: home }).source, 'env:BAMBOO_API_KEY')

  assert.equal(saveStartLuxKey('bad key with spaces', keyFile).ok, false)
})

test('StartLux key falls back to .credentials.yaml startluxApiKey', () => {
  const home = makeTempHome('startluxApiKey: "from-file"\n')
  assert.deepEqual(resolveStartLuxApiKey({ env: {}, dshHome: home }), {
    key: 'from-file',
    source: 'file:$DSH_HOME/.credentials.yaml',
  })
})
