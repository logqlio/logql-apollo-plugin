const js = require('@eslint/js')
const prettier = require('eslint-config-prettier')
const jest = require('eslint-plugin-jest')
const security = require('eslint-plugin-security')
const globals = require('globals')

module.exports = [
  js.configs.recommended,
  prettier,
  {
    files: ['src/**/*.js', 'eslint.config.js'],
    plugins: { security },
    languageOptions: { globals: globals.node },
    rules: { ...security.configs.recommended.rules, 'security/detect-object-injection': 0 },
  },
  {
    files: ['tests/**/*.js'],
    plugins: { jest },
    rules: { ...jest.configs.recommended.rules, 'no-unused-vars': 0 },
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
]
