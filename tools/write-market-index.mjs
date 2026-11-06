#!/usr/bin/env node
/**
 * 生成插件市场索引（format 1）——`plugin-index.json`。
 *
 * 版本来源：dist/dsh-zipfix/package.json（由 tools/build-dist.mjs 生成）。
 * 安装来源默认是 Git（commit 固定到包含 dist 的那次提交），发布 npm 后可用 --source npm。
 *
 * 用法（发布流程：先提交 dist，再生成索引，再提交索引）：
 *   node tools/build-dist.mjs
 *   git add dist && git commit -m "build: dist bundle"
 *   node tools/write-market-index.mjs --commit "$(git rev-parse HEAD)"
 *   git add plugin-index.json && git commit -m "market: pin index"
 *
 * 选项：
 *   --commit <sha>       Git 安装来源的 40 位小写 commit（默认取当前 HEAD）
 *   --source git|npm     安装来源类型（默认 git）
 *   --timestamp <sec>    publishTimestamp（默认当前时间，测试可用固定值）
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'dist', 'dsh-zipfix', 'package.json'), 'utf8'));
const REPO_URL = 'https://github.com/zhibo0502/dsh-zipfix';
const INDEX_FILE = path.join(REPO, 'plugin-index.json');

function arg(name, fallback) {
  const position = process.argv.indexOf(`--${name}`);
  if (position === -1 || position + 1 >= process.argv.length) return fallback;
  return process.argv[position + 1];
}

function currentHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git rev-parse HEAD 失败：${result.stderr}`);
  return result.stdout.trim();
}

const commit = arg('commit', currentHead());
if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`--commit 必须是 40 位小写 commit，实际：${commit}`);
const sourceType = arg('source', 'git');
if (sourceType !== 'git' && sourceType !== 'npm') throw new Error('--source 只能是 git 或 npm');
const timestamp = Number(arg('timestamp', String(Math.floor(Date.now() / 1000))));
if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp >= 1e11) {
  throw new Error(`--timestamp 必须是 Unix 秒整数：${timestamp}`);
}

const version = {
  version: DIST_PKG.version,
  publishTimestamp: timestamp,
  source:
    sourceType === 'npm'
      ? { type: 'npm', registry: 'https://registry.npmjs.org/' }
      : { type: 'git', url: REPO_URL, commit, path: 'dist/dsh-zipfix' },
  engines: { dsh: '*' },
};

const index = {
  format: 1,
  title: { en: 'ZIP Filename Fixer', zh: 'ZIP 文件名修复器' },
  description: {
    en: 'Repair mojibake Chinese filenames in ZIP archives: encoding sniffing, CRC-verified extraction, a repaired ZIP with the UTF-8 filename flag set, and source-archive CRC pairing for irreversible U+FFFD damage. Includes an agent tool set and a sidebar upload panel.',
    zh: '修复 ZIP 压缩包里的中文文件名乱码：编码嗅探、逐条 CRC32 校验解压、生成置位 UTF-8 文件名标志的修复版 ZIP，并对不可逆的 U+FFFD 乱码按源包 (size, CRC32) 配对还原。含 agent 工具与侧边栏上传面板。',
  },
  metadata: {
    categories: {
      tools: { title: { en: 'Tools & Capabilities', zh: '工具与能力' } },
      ui: { title: { en: 'UI Enhancements', zh: '界面增强' } },
    },
    labels: {},
    sortKeys: {},
  },
  plugins: [
    {
      name: DIST_PKG.name,
      title: { en: 'ZIP Filename Fixer', zh: 'ZIP 中文文件名修复器' },
      description: {
        en: 'Repairs mojibake Chinese filenames inside ZIP archives and extracted folders: 5 agent tools plus a sidebar upload panel (detect encoding, download a repaired UTF-8-flagged ZIP, or extract with correct names). Never deletes or overwrites the originals.',
        zh: '修复 ZIP 压缩包与已解压目录里的中文文件名乱码：5 个 agent 工具 + 侧边栏上传面板（体检编码、下载置位 UTF-8 标志的修复版 ZIP、或按正确文件名解压）。绝不删除、绝不覆盖原文件。',
      },
      icon: 'dist/dsh-zipfix/icon.svg',
      author: 'zhibo0502',
      homepage: `${REPO_URL}#readme`,
      repository: { url: REPO_URL, directory: 'dist/dsh-zipfix' },
      metadata: {
        category: 'tools',
        keywords: ['dsh-plugin', 'deepseek-harness', 'zip', 'filename', 'gbk', 'mojibake', 'chinese'],
        labels: [],
        sortKeys: {},
      },
      versions: [version],
    },
  ],
};

fs.writeFileSync(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(
  `已生成 plugin-index.json：${DIST_PKG.name}@${DIST_PKG.version}（${sourceType} 来源）` +
    `${sourceType === 'git' ? `，commit ${commit}` : ''}`,
);
