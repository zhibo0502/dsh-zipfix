#!/usr/bin/env node
/**
 * 把仓库里的两个源码包组装成一个「可发布、可安装」的单包分发包：
 *
 *   dist/dsh-zipfix/
 *     index.js            Host 半：注册 5 个工具 + /zipfix-api
 *     client.js           浏览器半：左侧边栏「ZIP 修复」入口与上传面板
 *     cordis.patch.yml    插入一行 dsh-zipfix
 *     plugin/             来自 dsh-zipfix-plugin 的 Host 实现与 lib/
 *     ui/index.js         来自 dsh-zipfix-ui 的 Host 半（导入路径改写为 ../plugin/）
 *     locale/、icon.svg   插件管理页显示资源
 *
 * 为什么需要这一步：插件市场（format 1 索引）的 Git 安装只打包 `path:` 指向的目录，
 * 而仓库里两个源码包互为兄弟目录（ui 通过 `../dsh-zipfix-plugin/...` 复用修复核心），
 * 单独安装任一包都会缺文件。组装后的 dist 包把两者收进同一个包内，缺失引用随之消失。
 *
 * 用法：
 *   node tools/build-dist.mjs           # 生成/更新 dist/dsh-zipfix
 *   node tools/build-dist.mjs --check   # 只校验已提交的 dist 是否与源码同步（CI 用）
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(REPO, 'dist', 'dsh-zipfix');
const PLUGIN = path.join(REPO, 'dsh-zipfix-plugin');
const UI = path.join(REPO, 'dsh-zipfix-ui');
const PACKAGE_NAME = 'dsh-zipfix';
const VERSION = '0.4.0';
const NODE_ENGINE = '>=22.12.0';
const REPO_URL = 'https://github.com/zhibo0502/dsh-zipfix';
const NPM_REGISTRY = 'https://registry.npmjs.org/';

/** Host 入口：把工具包与 UI 的 Host 半合到一个 bundle row 里。 */
const HOST_ENTRY = `/**
 * dsh-zipfix 发布包（自动生成，请勿直接编辑；改源码后运行 node tools/build-dist.mjs）。
 *
 * 同一行插件同时提供：
 * - 5 个 agent 工具（来自 plugin/index.js）
 * - 侧边栏 UI 使用的 /zipfix-api 上传/修复/下载接口（来自 ui/index.js）
 */

import { apply as applyTools } from './plugin/index.js';
import { apply as applyUi } from './ui/index.js';

export const name = 'dsh-zipfix';
export const inject = ['tools'];

export function apply(ctx) {
  applyTools(ctx);
  applyUi(ctx);
}
`;

const PATCH = `# dsh-zipfix 发布包（自动生成）：安装后出现一行 dsh-zipfix，同时提供工具与侧边栏 UI
- insert:
    - id: dsh-zipfix
      name: 'dsh-zipfix'
`;

const LICENSE = `MIT License

Copyright (c) 2026 dsh-zipfix contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const DIST_README = `# dsh-zipfix

DeepSeek Harness 插件：修复 ZIP 压缩包与已解压目录中的中文文件名乱码。提供 5 个 agent 工具和一个侧边栏上传面板。

## 功能

- 读取 ZIP 中央目录原始文件名字节，嗅探 UTF-8 / GBK / GB18030 / Big5 编码
- 按正确文件名解压，逐条校验 CRC32；生成置位 UTF-8 文件名标志（0x0800）的修复版 ZIP
- 对 U+FFFD 不可逆乱码，按源包 \`(size, CRC32)\` 唯一配对还原，并用编码指纹验证
- 5 个工具：\`zipfix_scan\`、\`zipfix_fix_zip\`、\`zipfix_rename_dir\`、\`zipfix_match_source\`、\`zipfix_verify_names\`
- 侧边栏「ZIP 修复」：上传 ZIP → 体检 → 下载修复版 ZIP / 按正确文件名解压

## 安装

DSH 插件市场（发现 → 添加索引源）：

\`\`\`text
https://raw.githubusercontent.com/zhibo0502/dsh-zipfix/main/plugin-index.json
\`\`\`

本地目录安装：

\`\`\`powershell
plugin_manager { action: "install_bundle", target: "<本目录绝对路径>" }
\`\`\`

## 安全

- 绝不删除、绝不覆盖源文件；同名目标自动加 \`_fixed\` 后缀；写操作默认 dry-run
- \`/zipfix-api\` 所有路由先经 \`connection.requestRejection\` 宿主认证（fail closed）
- 零运行时依赖，无网络请求

## License

MIT · https://github.com/zhibo0502/dsh-zipfix
`;

const zhLocale = {
  meta: {
    title: 'ZIP 中文文件名修复器',
    description:
      '修复 ZIP 压缩包与已解压目录中的中文文件名乱码：嗅探 GBK/GB18030/Big5 编码、按正确文件名解压并逐条校验 CRC32、生成置位 UTF-8 文件名标志的修复版 ZIP，按 (size, CRC32) 与源包配对还原 U+FFFD 乱码并用编码指纹验证。附侧边栏上传面板（上传 ZIP → 体检 → 下载/解压）。绝不删除、绝不覆盖原文件。',
  },
};

const enLocale = {
  meta: {
    title: 'ZIP Filename Fixer',
    description:
      'Repairs mojibake Chinese filenames inside ZIP archives and extracted folders: sniffs GBK/GB18030/Big5 entry names, extracts with correct names and per-entry CRC32 verification, writes a repaired ZIP with the UTF-8 filename flag set, pairs irreversible U+FFFD damage against a source ZIP by (size, CRC32), and verifies reconstructed names by encoding fingerprint. Includes a sidebar panel (upload ZIP → inspect → download or extract). Never deletes or overwrites the originals.',
  },
};

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** 以相对路径为键收集要写出的全部文件。 */
function collectFiles() {
  /** @type {Map<string, string | Buffer>} */
  const files = new Map();

  // Host 实现：index.js + lib/ + locale + icon
  files.set('plugin/index.js', readText(path.join(PLUGIN, 'index.js')));
  for (const name of fs.readdirSync(path.join(PLUGIN, 'lib')).sort()) {
    if (name.endsWith('.js')) files.set(`plugin/lib/${name}`, readText(path.join(PLUGIN, 'lib', name)));
  }
  for (const name of fs.readdirSync(path.join(PLUGIN, 'locale')).sort()) {
    if (name.endsWith('.json')) files.set(`plugin/locale/${name}`, readText(path.join(PLUGIN, 'locale', name)));
  }
  files.set('icon.svg', readText(path.join(PLUGIN, 'icon.svg')));

  // UI 的 Host 半：改写兄弟目录导入为包内相对路径
  const uiHost = readText(path.join(UI, 'index.js')).replaceAll('../dsh-zipfix-plugin/', '../plugin/');
  files.set('ui/index.js', uiHost);

  // 浏览器半：模块 id 必须等于发布包名
  const client = readText(path.join(UI, 'client.js')).replaceAll('dsh-zipfix-ui', PACKAGE_NAME);
  files.set('client.js', client);

  files.set('index.js', HOST_ENTRY);
  files.set('cordis.patch.yml', PATCH);
  files.set('LICENSE', LICENSE);
  files.set('README.md', DIST_README);
  files.set('locale/zh.json', `${JSON.stringify(zhLocale, null, 2)}\n`);
  files.set('locale/en.json', `${JSON.stringify(enLocale, null, 2)}\n`);

  const manifest = {
    name: PACKAGE_NAME,
    version: VERSION,
    description:
      'ZIP 中文文件名乱码修复器（DeepSeek Harness 插件）：5 个 agent 工具 + 侧边栏上传面板。',
    type: 'module',
    main: 'index.js',
    icon: 'icon.svg',
    exports: {
      '.': './index.js',
      './client': './client.js',
      './icon': './icon.svg',
      './cordis.patch.yml': './cordis.patch.yml',
      './locale/*.json': './locale/*.json',
      './package.json': './package.json',
    },
    files: [
      'index.js',
      'client.js',
      'cordis.patch.yml',
      'icon.svg',
      'locale',
      'plugin/index.js',
      'plugin/lib',
      'plugin/locale',
      'ui/index.js',
    ],
    engines: { node: NODE_ENGINE },
    keywords: ['dsh', 'dsh-plugin', 'deepseek-harness', 'zip', 'filename', 'gbk', 'mojibake', 'chinese', 'cordis'],
    author: { name: 'zhibo0502', url: 'https://github.com/zhibo0502' },
    homepage: `${REPO_URL}#readme`,
    repository: { type: 'git', url: `git+${REPO_URL}.git`, directory: 'dist/dsh-zipfix' },
    bugs: { url: `${REPO_URL}/issues` },
    publishConfig: { access: 'public', registry: NPM_REGISTRY },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      compatibility: { dshReleases: { '0.2.2-rc.1': 'compatible' } },
      client: {
        platform: 'web',
        immediately: true,
        inject: [
          '@deepseek-ai/dsh-client-ui-layout',
          '@deepseek-ai/dsh-client-ui-sidebar',
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-ui-workspace',
        ],
      },
    },
    license: 'MIT',
  };
  files.set('package.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return { files, manifest };
}

async function listExisting(dir, prefix = '') {
  /** @type {Map<string, Buffer>} */
  const found = new Map();
  if (!fs.existsSync(dir)) return found;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [key, value] of await listExisting(path.join(dir, entry.name), relative)) found.set(key, value);
    } else if (entry.isFile()) {
      found.set(relative, await fsp.readFile(path.join(dir, entry.name)));
    }
  }
  return found;
}

function compare(desired, existing) {
  const problems = [];
  for (const [relative, content] of desired) {
    const current = existing.get(relative);
    if (current === undefined) problems.push(`缺少 ${relative}`);
    else if (!current.equals(Buffer.from(content))) problems.push(`内容不同 ${relative}`);
  }
  for (const relative of existing.keys()) {
    if (!desired.has(relative)) problems.push(`多余 ${relative}`);
  }
  return problems;
}

async function writeDist(desired) {
  await fsp.rm(DIST, { recursive: true, force: true });
  for (const [relative, content] of desired) {
    const target = path.join(DIST, ...relative.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
  // 完整性自检：Host/浏览器模块至少能通过语法解析
  for (const relative of ['index.js', 'plugin/index.js', 'ui/index.js', 'client.js']) {
    const file = path.join(DIST, ...relative.split('/'));
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`生成文件语法检查失败：${relative}\n${result.stderr}`);
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const { files, manifest } = collectFiles();
  if (check) {
    const existing = await listExisting(DIST);
    const problems = compare(files, existing);
    if (problems.length > 0) {
      console.error('dist/dsh-zipfix 与源码不同步，请运行 node tools/build-dist.mjs 后提交：');
      for (const problem of problems.slice(0, 40)) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log(`dist/dsh-zipfix 已同步（${manifest.name}@${manifest.version}，${files.size} 个文件）`);
    return;
  }
  await writeDist(files);
  console.log(`已生成 dist/${PACKAGE_NAME}@${VERSION}：${files.size} 个文件`);
}

await main();
