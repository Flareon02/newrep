// Lint for real defects (undefined names, unreachable code, duplicate keys, ...), not style:
// the code base is deliberately dense and is formatted by hand.
//   npm install            (dev dependencies only: eslint, @eslint/js, globals)
//   npm run lint
import js from '@eslint/js';
import globals from 'globals';

const legacyRules = {
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
  'no-prototype-builtins': 'off',
  'no-useless-escape': 'off',
  'no-control-regex': 'off',
  'no-misleading-character-class': 'off',
  'no-cond-assign': 'off',
  'no-useless-assignment': 'off',
  'preserve-caught-error': 'off',
};

export default [
  { ignores: ['**/node_modules/**', 'dist/**', 'extension/assets/**', 'web/gateway/src/vendor/**', 'desktop/src-tauri/target/**'] },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'tools/**/*.mjs', 'extension/test/**/*.mjs', 'server/test/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, MonitorTime: 'readonly', LiveModel: 'readonly', OddsPricing: 'readonly' } },
  },
  { files: ['tools/e2e-extension-smoke.mjs', 'tools/e2e/*.mjs', 'tools/bench/*.mjs', 'tools/ux/*.mjs'], languageOptions: { globals: { ...globals.browser, chrome: 'readonly', BASE: 'readonly', request: 'readonly', prefs: 'readonly', cache: 'readonly', self: 'readonly' } } },
  { files: ['server/**/*.cjs'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } } },
  {
    // Classic scripts that share globals through <script> tags (module pattern), so no-undef cannot apply.
    files: ['extension/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser, ...globals.serviceworker, chrome: 'readonly' } },
    rules: { 'no-undef': 'off', 'no-redeclare': 'off', 'no-global-assign': 'off', 'no-unassigned-vars': 'off' },
  },
  // Web gateway, build and test tools (Node modules).
  { files: ['web/**/*.mjs', 'web/gateway/**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } } },
  { files: ['web/test/web-e2e.mjs', 'web/test/prod-acceptance.mjs', 'web/scripts/desktop-smoke.mjs'], languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } } },
  // Web/desktop platform layer: classic browser scripts sharing globals with the extension UI.
  { files: ['web/platform/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser, Platform: 'writable', ServerConfig: 'writable' } }, rules: { 'no-redeclare': 'off' } },
  { rules: legacyRules },
];
