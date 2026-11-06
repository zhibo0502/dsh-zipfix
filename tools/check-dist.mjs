#!/usr/bin/env node
/**
 * 发布包（dist/dsh-zipfix）冒烟检查：
 * - Host 入口能被 Node 正常导入；
 * - apply() 用假 ctx 跑通：5 个工具都注册、UI Host 半不抛错；
 * - 浏览器模块 id 等于包名（插件市场安装后客户端模块图才能对上）；
 * - package.json 的 dsh.bundle / dsh.client 声明齐全。
 *
 * 用法：node tools/check-dist.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(REPO, 'dist', 'dsh-zipfix');

function fail(reason) {
  console.error(`✗ dist 冒烟检查失败：${reason}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(DIST, 'package.json'))) fail('缺少 dist/dsh-zipfix（先运行 npm run build）');

const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'package.json'), 'utf8'));
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('package.json 缺少 dsh.bundle.patch');
if (manifest.dsh?.client?.platform !== 'web') fail('package.json 缺少 dsh.client（platform=web）');
if (!fs.existsSync(path.join(DIST, 'cordis.patch.yml'))) fail('缺少 cordis.patch.yml');

const client = fs.readFileSync(path.join(DIST, 'client.js'), 'utf8');
if (!client.includes(`id: '${manifest.name}'`)) fail(`client.js 的模块 id 必须等于包名 ${manifest.name}`);
if (client.includes("id: 'dsh-zipfix-ui'")) fail('client.js 仍保留旧模块 id dsh-zipfix-ui');

const entry = await import(pathToFileURL(path.join(DIST, 'index.js')).href);
if (entry.name !== manifest.name) fail(`Host 入口 name=${entry.name} 与包名不一致`);
if (!Array.isArray(entry.inject) || !entry.inject.includes('tools')) fail('Host 入口 inject 缺少 tools');
if (typeof entry.apply !== 'function') fail('Host 入口缺少 apply()');

const registered = [];
const disposers = [];
const fakeCtx = {
  tools: {
    register(definition) {
      registered.push(definition.name);
      return () => {};
    },
  },
  get() {
    return undefined;
  },
  effect(callback) {
    const disposer = callback();
    if (typeof disposer === 'function') disposers.push(disposer);
    return () => {};
  },
  logger: { warn() {}, info() {} },
};

try {
  entry.apply(fakeCtx);
} catch (error) {
  fail(`apply() 抛出异常：${error?.stack ?? error}`);
}

const expected = ['zipfix_scan', 'zipfix_fix_zip', 'zipfix_rename_dir', 'zipfix_match_source', 'zipfix_verify_names'];
for (const name of expected) {
  if (!registered.includes(name)) fail(`工具未注册：${name}`);
}
for (const dispose of disposers) {
  try {
    dispose();
  } catch {
    /* 释放失败不影响冒烟结论 */
  }
}
console.log(`✓ dist/dsh-zipfix@${manifest.version} 冒烟通过：${registered.length} 个工具注册，client id = ${manifest.name}`);
