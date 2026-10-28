/**
 * ESLint flat config (no plugin dependencies).
 *
 * Run with: npm run lint   (needs the dev dependency installed)
 * The repository also has dependency-free checks: npm run check
 *
 * Style notes: the browser pages keep an ES5-friendly IIFE style on purpose
 * (no build step, no imports), so `no-var` and autofix-heavy rules stay off.
 */
const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Intl: 'readonly',
  fetch: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly'
}

const browserGlobals = {
  ...nodeGlobals,
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  EventSource: 'readonly',
  ResizeObserver: 'readonly',
  MutationObserver: 'readonly',
  getComputedStyle: 'readonly',
  requestAnimationFrame: 'readonly',
  renderMarkdown: 'readonly'
}

const commonRules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  eqeqeq: ['warn', 'smart'],
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-duplicate-imports': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': ['error', { checkLoops: false }]
}

export default [
  {
    ignores: ['node_modules/**', 'tmp/**', '*.asar', 'dock-prototype.html', 'package-lock.json']
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals
    },
    rules: commonRules
  },
  {
    // The Electron runtime and the tests are CommonJS.
    files: ['runtime/**/*.js', 'runtime/**/*.cjs', 'runtime/test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly'
      }
    }
  },
  {
    // Scripts and the ESLint config itself are ES modules.
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals
    }
  },
  {
    files: ['web/**/*.js', 'client.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...browserGlobals,
        React: 'readonly'
      }
    }
  }
]
