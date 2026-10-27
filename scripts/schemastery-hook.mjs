/**
 * 测试用 ESM resolve 钩子（只在没装 node_modules 时需要）。
 *
 * 插件在 DSH 里能解析 `@deepseek-ai/schemastery`（dsh-app-boot 会给 profile 装一层
 * 模块路由），但本地直接跑 harness 时如果没 `npm install`，Node 解析不到它。
 * 这里退而求其次：从 DSH profile 的 node_modules 里借一份。
 *
 * 解析失败时直接放行给 Node 默认解析器 —— 装了依赖的仓库根本用不到这个钩子。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const PROFILE = process.env.QD_PROFILE_PACKAGE
  || 'C:/Users/futurvo/.dsh/profiles/desktop/package.json'

let resolved
let failed = false

function target() {
  if (resolved !== undefined) return resolved
  try {
    const require = createRequire(PROFILE)
    const manifest = require.resolve('@deepseek-ai/schemastery/package.json')
    const pkg = require(manifest)
    const entry = pkg.exports?.['.']?.import || pkg.module || pkg.main
    resolved = pathToFileURL(require.resolve(manifest.replace('package.json', entry.replace('./', '')))).href
  } catch (error) {
    failed = true
    console.warn('[dev-harness] 借用 profile 的 schemastery 失败，改用默认解析：' + error.message)
    resolved = null
  }
  return resolved
}

export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/schemastery') {
    const url = target()
    if (url) return { url, shortCircuit: true }
    void failed
  }
  return next(specifier, context)
}
