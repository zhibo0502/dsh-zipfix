import js from '@eslint/js';
import globals from 'globals';

/**
 * 仓库统一 lint 规则。
 *
 * 说明：
 * - `dsh-zipfix-ui/client.js` 是浏览器端 classic script（由页面模块表加载，经 `require('react')`
 *   取得 React），所以单独使用 browser globals + script 源类型。
 * - 其余 `.js/.mjs` 均为 Node ESM。
 * - 插件里做路径安全化时会刻意匹配控制字符，因此关闭 `no-control-regex`。
 * - 测试里允许空 catch、以下划线开头的未使用参数。
 */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '.tools/**',
      'dsh-zipfix-plugin/test/fixtures/**',
      'spec/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-control-regex': 'off',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['dsh-zipfix-ui/client.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
];
