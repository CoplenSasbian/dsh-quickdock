/**
 * 首次运行下载 Electron（DESIGN.md §10 正式任务）。
 * 独立入口：node scripts/ensure-electron.mjs [--version 30.5.1] [--force]
 * 也可由宿主在激活时后台调用。失败时打印 DSH_QUICKDOCK_ELECTRON_PATH 提示，只影响桌面模式。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'

const require = createRequire(import.meta.url)
// 与 index.js 的 ELECTRON_VERSION 保持一致；默认对齐 DSH 宿主内置版本。
// 30.5.1 在部分 Windows 上以 STATUS_BREAKPOINT 崩于 JS 执行前，已弃用。
const VERSION = process.argv.includes('--version')
  ? process.argv[process.argv.indexOf('--version') + 1]
  : (process.env.DSH_QUICKDOCK_ELECTRON_VERSION ?? '44.7.0')
const FORCE = process.argv.includes('--force')

function targetRoot() {
  if (process.env.DSH_QUICKDOCK_ELECTRON_PATH) return null // 显式配置：不下载
  // 落盘到 %LOCALAPPDATA%\dsh-quickdock\electron\<version>，与 index.js 的 electronRoot() 对应。
  // 不放 ~/.dsh：第三方安全软件（如联想版火绒）对用户配置目录做注入防护，
  // Chromium 自检失败会以 STATUS_BREAKPOINT (0x80000003) 自杀——同一份二进制在
  // %LOCALAPPDATA% 下可正常运行。详见 index.js electronRoot 注释。
  const localAppData = process.env.LOCALAPPDATA
    || (platform() === 'win32' ? join(homedir(), 'AppData', 'Local') : join(homedir(), '.local', 'share'))
  return join(String(localAppData), 'dsh-quickdock', 'electron', VERSION)
}

async function main() {
  const root = targetRoot()
  if (!root) {
    console.log('DSH_QUICKDOCK_ELECTRON_PATH is set; skipping download.')
    return
  }
  const exeName = platform() === 'win32' ? 'electron.exe' : platform() === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'
  const exe = join(root, exeName)
  if (!FORCE && existsSync(exe)) {
    console.log('Electron already present: ' + exe)
    return
  }
  console.log('Downloading Electron ' + VERSION + ' (~100MB via npmmirror)…')
  const { download } = await import('@electron/get')
  const { extract } = await import('@electron-internal/extract-zip')
  const mirror = process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/'
  let received = 0, total = 0
  const zipPath = await download(VERSION, {
    mirrorOptions: { mirror },
    progressCallback: (p) => {
      // 控制台进度：比例 + 已下载/总量（DESIGN §10 任务要求）
      received = p.received ?? received
      total = p.total ?? total
      if (total > 0) {
        const pct = Math.round((received / total) * 100)
        const mb = (received / 1048576).toFixed(1), mbt = (total / 1048576).toFixed(1)
        process.stdout.write('\r  ' + pct + '%  ' + mb + ' / ' + mbt + ' MB')
      }
    }
  })
  console.log('\nExtracting…')
  await extract(zipPath, { dir: root })
  console.log('Done: ' + exe)
}

main().catch((error) => {
  console.error('Electron download failed: ' + String(error))
  console.error('Set DSH_QUICKDOCK_ELECTRON_PATH to an existing Electron binary to use desktop mode.')
  console.error('Web mode is unaffected.')
  process.exitCode = 1
})
