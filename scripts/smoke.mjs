/**
 * Smoke test for the dev harness: start the Host half against mock DSH
 * services, then exercise page rendering, API state and locale switching.
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const EN = JSON.parse(readFileSync(join(ROOT, 'locale', 'en.json'), 'utf8'))
const ZH = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'))
const PORT = 46010

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: options.method || 'GET', headers: options.headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

/** Collect SSE frames for a moment while \`during\` runs, then close. */
function readStream(token, during) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/quickdock/api/stream?t=' + encodeURIComponent(token)
    }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      during()
      setTimeout(() => {
        req.destroy()
        resolve(text)
      }, 700)
    })
    req.on('error', () => resolve(''))
    req.end()
  })
}

function waitForServer(deadline = Date.now() + 15000) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      request('/test/calls').then(resolve).catch(() => {
        if (Date.now() > deadline) reject(new Error('harness did not start'))
        else setTimeout(attempt, 250)
      })
    }
    attempt()
  })
}

const child = spawn(process.execPath, ['--import', './scripts/register-hook.mjs', 'scripts/dev-harness.mjs'], {
  cwd: ROOT,
  env: { ...process.env, QD_PORT: String(PORT), QD_NO_ELECTRON: '1' },
  stdio: 'ignore'
})

const failures = []
const check = (name, ok, detail = '') => {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ' :: ' + detail))
  if (!ok) failures.push(name)
}

try {
  await waitForServer()
  const web = JSON.parse((await request('/test/web-url')).text)
  const token = new URL(web.url).searchParams.get('t')

  const page = await request('/quickdock?t=' + token)
  check('page renders', page.status === 200)
  check('page inlines the locale payload', page.text.includes('window.__QD_I18N__'))
  check('page inlines all page scripts', page.text.includes('__QD_VIEW__') && page.text.includes('QD.display'))
  check('page inlines the stylesheet', page.text.includes('--qd-bg-base'))

  const state = JSON.parse((await request('/quickdock/api/state?t=' + token)).text)
  check('state has an idle snapshot', state.status === 'idle' && state.sessionId === null)
  const initialLocale = state.locale
  check('state carries a locale', initialLocale === 'en' || initialLocale === 'zh')
  check('page language matches the state locale',
    page.text.includes('<html lang="' + (initialLocale === 'zh' ? 'zh-CN' : 'en') + '"'))

  const switchLocale = async (locale) => request('/test/locale', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale })
  })

  check('locale bridge accepts en', JSON.parse((await switchLocale('en')).text).ok === true)
  const enPage = await request('/quickdock?t=' + token)
  check('page switches to English', enPage.text.includes('<html lang="en"'))
  check('injected catalog is English',
    enPage.text.includes(JSON.stringify('status.idle') + ':' + JSON.stringify(EN['status.idle'])))
  check('state follows the en switch',
    JSON.parse((await request('/quickdock/api/state?t=' + token)).text).locale === 'en')

  // The dock pages follow language changes over SSE, without a reload.
  let pushed = false
  const streamText = await readStream(token, () => {
    switchLocale('zh').then(() => { pushed = true })
  })
  check('stream sends the initial frames',
    streamText.includes('event: state') && streamText.includes('event: theme') && streamText.includes('event: locale'))
  check('stream broadcasts the locale switch',
    streamText.includes(JSON.stringify('status.idle') + ':' + JSON.stringify(ZH['status.idle'])))
  check('locale switch request settled', pushed)

  // The Client half pushes the resolved DSH palette; pages and streams follow it.
  const switchTheme = async (theme) => request('/test/theme', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(theme)
  })
  const lightPalette = {
    colorScheme: 'light',
    tokens: {
      '--dsw-alias-bg-base': '#fbfbfc',
      '--dsw-alias-bg-layer-1': '#ffffff',
      '--dsw-alias-bg-layer-2': '#f4f5f6',
      '--dsw-alias-border-l1': '#e6e7e9',
      '--dsw-alias-border-l2': '#d5d6d9',
      '--dsw-alias-label-primary': '#1a1a1c',
      '--dsw-alias-label-secondary': '#5c5e63',
      '--dsw-alias-brand-primary': '#101114'
    },
    fonts: { text: 'Inter', sizeText: 13 }
  }
  check('theme bridge accepts a light palette', JSON.parse((await switchTheme(lightPalette)).text).ok === true)
  const lightPage = await request('/quickdock?t=' + token)
  check('page switches to the light scheme', lightPage.text.includes('data-theme="light"'))
  check('page inlines the pushed palette', lightPage.text.includes('--qd-bg-base: #fbfbfc'))
  check('first-paint CSS outranks the dock light palette', lightPage.text.includes('html[data-theme]'))
  check('page derives text on brand from the base surface', lightPage.text.includes('--qd-brand-fg: #fbfbfc'))
  const themeStream = await readStream(token, () => {})
  check('stream sends the current palette', themeStream.includes('event: theme') && themeStream.includes('--qd-bg-base'))

  check('locale bridge accepts zh', JSON.parse((await switchLocale('zh')).text).ok === true)
  const zhPage = await request('/quickdock?t=' + token)
  check('page switches to Chinese', zhPage.text.includes('<html lang="zh-CN"'))
  check('injected catalog is Chinese',
    zhPage.text.includes(JSON.stringify('status.idle') + ':' + JSON.stringify(ZH['status.idle'])))
  check('state follows the zh switch',
    JSON.parse((await request('/quickdock/api/state?t=' + token)).text).locale === 'zh')

  const bind = await request('/test/bind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 's-demo' }) })
  const bound = JSON.parse(bind.text)
  check('bind reports a starting dock', bound.ok === true && bound.dockRunning === false)
  const boundState = JSON.parse((await request('/quickdock/api/state?t=' + token)).text)
  check('bind selects the session', boundState.sessionId === 's-demo')
  check('session title comes from the projection', boundState.session.title === 'Wire QuickDock into DSH')
  check('bound status stays idle', boundState.status === 'idle')

  // Client API: capability manifest and workspace/session/turn reads.
  const meta = JSON.parse((await request('/quickdock/api/meta?t=' + token)).text)
  check('meta reports the client API version', meta.apiVersion === 1 && meta.capabilities.includes('turns'))
  const workspaceList = JSON.parse((await request('/quickdock/api/workspaces?t=' + token)).text)
  check('workspaces endpoint lists the harness workspaces', workspaceList.workspaces.length >= 1)
  const sessionList = JSON.parse((await request('/quickdock/api/sessions?t=' + token)).text)
  check('sessions endpoint includes the bound session',
    sessionList.sessions.some((row) => row.sessionId === 's-demo'))
  const turnList = JSON.parse((await request('/quickdock/api/turns?t=' + token)).text)
  check('turns endpoint answers for the bound session',
    turnList.sessionId === 's-demo' && Array.isArray(turnList.turns))
  const turnDetail = JSON.parse((await request('/quickdock/api/turn?t=' + token)).text)
  check('turn endpoint reports an unobserved turn', turnDetail.observed === false)
} catch (error) {
  failures.push(String(error && error.stack || error))
  console.error(error)
} finally {
  child.kill()
}

console.log(failures.length ? 'SMOKE FAILED: ' + failures.length : 'SMOKE OK')
process.exitCode = failures.length ? 1 : 0
