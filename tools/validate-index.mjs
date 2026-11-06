#!/usr/bin/env node
/**
 * 用 DSH 官方的 format 1 校验器校验 `plugin-index.json`，并核对索引与 dist 包是否一致。
 *
 * 校验内容：
 * - 官方 parseMarketIndex 全量校验（字段、URL、SemVer、commit、路径、icon 解析等）；
 * - 索引里的 name/version 与 dist/dsh-zipfix/package.json 一致；
 * - Git 来源的 path 指向仓库内真实存在的 dist 目录，commit 为 40 位小写 SHA；
 * - marketInstallTarget 生成的安装参数可打印出来，供人工核对；
 * - icon 若指向本仓库文件，必须真实存在。
 *
 * 用法：node tools/validate-index.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marketInstallTarget, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_URL = 'https://raw.githubusercontent.com/zhibo0502/dsh-zipfix/main/plugin-index.json';
const INDEX_FILE = path.join(REPO, 'plugin-index.json');
const DIST_DIR = path.join(REPO, 'dist', 'dsh-zipfix');

function fail(reason) {
  console.error(`✗ plugin-index.json 校验失败：${reason}`);
  process.exit(1);
}

if (!fs.existsSync(INDEX_FILE)) fail('缺少 plugin-index.json（先运行 node tools/write-market-index.mjs）');
if (!fs.existsSync(path.join(DIST_DIR, 'package.json'))) fail('缺少 dist/dsh-zipfix（先运行 node tools/build-dist.mjs）');

let index;
try {
  index = parseMarketIndex(JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')), INDEX_URL);
} catch (error) {
  fail(`${error.path ?? '?'} ${error.reason ?? error.message}`);
}

const distPackage = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'package.json'), 'utf8'));
let versions = 0;
for (const plugin of index.plugins) {
  if (plugin.name !== distPackage.name) fail(`插件名 ${plugin.name} 与 dist 包名 ${distPackage.name} 不一致`);
  for (const version of plugin.versions) {
    if (version.version !== distPackage.version) {
      fail(`索引版本 ${version.version} 与 dist 版本 ${distPackage.version} 不一致`);
    }
    if (version.source.type === 'git') {
      if (version.source.path !== 'dist/dsh-zipfix') fail(`Git 来源 path 应为 dist/dsh-zipfix，实际 ${version.source.path}`);
      if (!fs.existsSync(path.join(REPO, 'dist', 'dsh-zipfix', 'package.json'))) fail('Git 来源指向的 dist 目录不存在');
    }
    const target = marketInstallTarget(plugin.name, version);
    console.log(`✓ ${plugin.name}@${version.version}`);
    console.log(`  安装参数：${target.spec}`);
    versions++;
  }
  if (plugin.repository?.directory !== undefined) {
    const directory = path.join(REPO, ...plugin.repository.directory.split('/'));
    if (!fs.existsSync(directory)) fail(`repository.directory 不存在：${plugin.repository.directory}`);
  }
  if (plugin.icon !== undefined && !plugin.icon.startsWith('data:')) {
    const parsed = new URL(plugin.icon);
    const marker = '/main/';
    const position = parsed.pathname.indexOf(marker);
    if (position >= 0) {
      const relative = decodeURIComponent(parsed.pathname.slice(position + marker.length));
      if (!fs.existsSync(path.join(REPO, ...relative.split('/')))) fail(`icon 指向仓库文件但不存在：${relative}`);
    }
  }
}
if (versions === 0) fail('索引没有版本条目');
console.log(`✓ plugin-index.json 通过官方 format 1 校验（${index.plugins.length} 个插件 / ${versions} 个版本）`);
