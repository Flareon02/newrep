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
  { ignores: ['**/node_modules/**', 'dist/**', 'extension/assets/**'] },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'tools/**/*.mjs', 'extension/test/**/*.mjs', 'server/test/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, MonitorTime: 'readonly', LiveModel: 'readonly', OddsPricing: 'readonly' } },
  },
  { files: ['tools/e2e-extension-smoke.mjs'], languageOptions: { globals: { chrome: 'readonly', BASE: 'readonly', request: 'readonly' } } },
  { files: ['server/**/*.cjs'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } } },
  {
    // Classic scripts that share globals through <script> tags (module pattern), so no-undef cannot apply.
    files: ['extension/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser, ...globals.serviceworker, chrome: 'readonly' } },
    rules: { 'no-undef': 'off', 'no-redeclare': 'off', 'no-global-assign': 'off', 'no-unassigned-vars': 'off' },
  },
  { rules: legacyRules },
];
