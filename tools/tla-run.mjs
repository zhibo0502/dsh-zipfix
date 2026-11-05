#!/usr/bin/env node
/**
 * tools/tla-run.mjs
 * ---------------------------------------------------------------------------
 * 用 TLC 校验 dsh-zipfix 的形式化规格（spec/ 目录下的 TLA+ 模型）。
 *
 * 设计要点：
 *  - Node 22+ ESM，零 npm 依赖（仅 node: 标准库 + 全局 fetch）。
 *  - java 定位：环境变量 TLA_JAVA（可执行文件路径）优先，否则使用 PATH 中的 java。
 *  - tla2tools.jar 定位：环境变量 TLA2TOOLS_JAR 优先；否则下载固定版本
 *    tla2tools.jar（GitHub release）到 os.tmpdir() 下的缓存目录，并用硬编码
 *    SHA-256 校验完整性。
 *  - 对 spec/ 下每个 .cfg 运行：
 *        java -cp <jar> tlc2.TLC -config <name>.cfg <name>.tla
 *    工作目录固定为 spec/；TLC 的元数据目录（states/）重定向到系统临时目录，
 *    避免在仓库里留下任何构建产物。
 *  - 断言：退出码 0 且输出包含
 *        "Model checking completed. No error has been found."
 *    成功后打印 states / distinct states / diameter 摘要；失败时打印 TLC
 *    输出尾部并以非零码退出。
 *
 * 用法：
 *   node tools/tla-run.mjs                 # 运行 spec/ 下全部 .cfg
 *   node tools/tla-run.mjs --spec FixSafety # 只运行指定规格
 *   node tools/tla-run.mjs --list           # 只列出可运行的规格
 *
 * 环境变量：
 *   TLA_JAVA         java 可执行文件路径（未设置则用 PATH 中的 java）
 *   TLA2TOOLS_JAR    tla2tools.jar 路径（未设置则自动下载并校验固定版本）
 * ---------------------------------------------------------------------------
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SPEC_DIR = path.join(REPO_ROOT, 'spec');

/** 固定版本的 tla2tools.jar（发布资产不可变，哈希可复现）。 */
const TLA2TOOLS_VERSION = 'v1.7.1';
const TLA2TOOLS_URL = `https://github.com/tlaplus/tlaplus/releases/download/${TLA2TOOLS_VERSION}/tla2tools.jar`;
const TLA2TOOLS_SHA256 = 'd532ba31aafe17afba1130f92410d9257454ff7393d1eb2fe032f0c07f352da5';
const TLA2TOOLS_BYTES = 2274805;

const SUCCESS_MARKER = 'Model checking completed. No error has been found.';
const CACHE_DIR = path.join(os.tmpdir(), 'dsh-zipfix-tla');
const PINNED_JAR = path.join(CACHE_DIR, `tla2tools-${TLA2TOOLS_VERSION}.jar`);
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const color = (() => {
  const enabled = process.stdout.isTTY && !process.env.NO_COLOR;
  const wrap = (code) => (text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
  return { green: wrap('32'), red: wrap('31'), yellow: wrap('33'), dim: wrap('2'), bold: wrap('1') };
})();

function die(message) {
  console.error(`\n${color.red('✗')} ${message}\n`);
  process.exit(1);
}

function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex').toLowerCase();
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/* ------------------------------------------------------------------ *
 * java / tla2tools.jar 定位
 * ------------------------------------------------------------------ */

function resolveJava() {
  const explicit = process.env.TLA_JAVA?.trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      die(`TLA_JAVA 指向的 java 不存在：${explicit}`);
    }
    return { command: explicit, source: 'TLA_JAVA' };
  }
  const probe = spawnSync('java', ['-version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error || probe.status !== 0) {
    die(
      '未找到 java。\n' +
        '  本机未安装 Java 时，可下载便携版 Temurin JRE 后用 TLA_JAVA 指定：\n' +
        '    PowerShell:\n' +
        '      Invoke-WebRequest -Uri "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse" -OutFile "$env:TEMP\\temurin-jre.zip"\n' +
        '      Expand-Archive "$env:TEMP\\temurin-jre.zip" -DestinationPath "$env:TEMP\\temurin-jre"\n' +
        '      $env:TLA_JAVA = (Get-ChildItem "$env:TEMP\\temurin-jre" -Recurse -Filter java.exe | Select-Object -First 1).FullName\n' +
        '  或直接安装 JRE/JDK 21+ 并确保 java 在 PATH 中。',
    );
  }
  return { command: 'java', source: 'PATH' };
}

async function downloadPinnedJar() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmpPath = `${PINNED_JAR}.${process.pid}.download`;
  console.log(color.dim(`  下载 ${TLA2TOOLS_URL}`));
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(TLA2TOOLS_URL, {
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000),
        headers: { 'user-agent': 'dsh-zipfix-tla-runner' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(tmpPath, buffer);
      const actual = sha256File(tmpPath);
      if (actual !== TLA2TOOLS_SHA256) {
        fs.rmSync(tmpPath, { force: true });
        die(
          `下载的 tla2tools.jar SHA-256 校验失败：\n` +
            `  期望 ${TLA2TOOLS_SHA256}\n  实际 ${actual}\n` +
            `  已删除下载文件；请检查网络代理或改用 TLA2TOOLS_JAR 指定本地 jar。`,
        );
      }
      fs.rmSync(PINNED_JAR, { force: true });
      fs.renameSync(tmpPath, PINNED_JAR);
      console.log(
        color.dim(`  已缓存到 ${PINNED_JAR}（${buffer.length} 字节，SHA-256 校验通过）`),
      );
      return PINNED_JAR;
    } catch (error) {
      lastError = error;
      fs.rmSync(tmpPath, { force: true });
      if (attempt < 3) {
        console.log(color.yellow(`  下载失败（第 ${attempt} 次）：${error.message}，重试…`));
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
  }
  die(
    `无法下载 tla2tools.jar：${lastError?.message ?? 'unknown error'}\n` +
      `  可手动下载 ${TLA2TOOLS_URL} 并用 TLA2TOOLS_JAR 指向该文件。`,
  );
}

async function resolveJar() {
  const explicit = process.env.TLA2TOOLS_JAR?.trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      die(`TLA2TOOLS_JAR 指向的 jar 不存在：${explicit}`);
    }
    const actual = sha256File(explicit);
    if (actual !== TLA2TOOLS_SHA256) {
      console.warn(
        color.yellow(
          `⚠ TLA2TOOLS_JAR 的 SHA-256 与固定版本 ${TLA2TOOLS_VERSION} 不一致（继续使用）：\n` +
            `    ${explicit}\n    实际 ${actual}`,
        ),
      );
    }
    return { path: explicit, source: 'TLA2TOOLS_JAR' };
  }
  if (fs.existsSync(PINNED_JAR)) {
    const actual = sha256File(PINNED_JAR);
    if (actual === TLA2TOOLS_SHA256 && fs.statSync(PINNED_JAR).size === TLA2TOOLS_BYTES) {
      return { path: PINNED_JAR, source: 'cache' };
    }
    console.warn(color.yellow('⚠ 缓存 jar 校验失败，重新下载…'));
    fs.rmSync(PINNED_JAR, { force: true });
  }
  const jarPath = await downloadPinnedJar();
  return { path: jarPath, source: 'download' };
}

/* ------------------------------------------------------------------ *
 * 规格发现与 TLC 执行
 * ------------------------------------------------------------------ */

function discoverSpecs() {
  if (!fs.existsSync(SPEC_DIR)) die(`spec 目录不存在：${SPEC_DIR}`);
  return fs
    .readdirSync(SPEC_DIR)
    .filter((file) => file.endsWith('.cfg'))
    .sort()
    .map((cfgFile) => {
      const name = cfgFile.slice(0, -'.cfg'.length);
      const tlaFile = `${name}.tla`;
      return {
        name,
        cfgFile,
        tlaFile,
        cfgPath: path.join(SPEC_DIR, cfgFile),
        tlaPath: path.join(SPEC_DIR, tlaFile),
      };
    });
}

function selectSpecs(all, selector) {
  const normalized = selector.replace(/\.(cfg|tla)$/i, '');
  const matched = all.filter((spec) => spec.name === normalized);
  if (matched.length === 0) {
    die(
      `未找到规格 ${selector}。可用规格：${all.map((spec) => spec.name).join(', ') || '（无）'}`,
    );
  }
  return matched;
}

function parseStats(output) {
  const statesMatch = /(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue\./.exec(
    output,
  );
  const depthMatch = /The depth of the complete state graph search is (\d+)\./.exec(output);
  return {
    generated: statesMatch ? Number(statesMatch[1]) : null,
    distinct: statesMatch ? Number(statesMatch[2]) : null,
    leftOnQueue: statesMatch ? Number(statesMatch[3]) : null,
    diameter: depthMatch ? Number(depthMatch[1]) : null,
  };
}

function tailLines(text, count) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

function runSpec({ java, jar, spec }) {
  if (!fs.existsSync(spec.tlaPath)) {
    return {
      spec,
      ok: false,
      output: '',
      error: `缺少 ${spec.tlaFile}（有 ${spec.cfgFile} 但没有同名 .tla）`,
      stats: {},
      durationMs: 0,
    };
  }
  // TLC 的元数据（states/ 等）放到系统临时目录，绝不在仓库内落盘。
  const metaDir = path.join(CACHE_DIR, 'meta', spec.name);
  fs.rmSync(metaDir, { recursive: true, force: true });
  fs.mkdirSync(metaDir, { recursive: true });

  const args = [
    '-cp',
    jar.path,
    'tlc2.TLC',
    '-metadir',
    metaDir,
    '-config',
    spec.cfgFile,
    spec.tlaFile,
  ];
  const started = Date.now();
  const result = spawnSync(java.command, args, {
    cwd: SPEC_DIR, // 需求：工作目录固定为 spec/
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: RUN_TIMEOUT_MS,
    env: process.env,
  });
  const durationMs = Date.now() - started;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.error) {
    return { spec, ok: false, output, error: `无法启动 java：${result.error.message}`, stats: {}, durationMs };
  }
  if (result.signal === 'SIGTERM' && result.status === null) {
    return { spec, ok: false, output, error: `TLC 超时（>${RUN_TIMEOUT_MS / 1000}s）被终止`, stats: {}, durationMs };
  }
  const stats = parseStats(output);
  const success = result.status === 0 && output.includes(SUCCESS_MARKER);
  let error = null;
  if (!success) {
    const violation = /Error: (Invariant .*? is violated[^\n]*)/.exec(output);
    const tlcError = /Error: ([^\n]+)/.exec(output);
    error =
      violation?.[1] ??
      tlcError?.[1] ??
      `TLC 退出码 ${result.status}，且输出未包含成功标记`;
  }
  return { spec, ok: success, output, error, stats, durationMs };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function printUsage() {
  const script = path.relative(process.cwd(), fileURLToPath(import.meta.url));
  console.log(`用法：node ${script} [选项]

选项：
  --spec <name>   只运行指定规格（如 FixSafety 或 FixSafety.cfg）
  --list          只列出 spec/ 下发现的规格，不运行
  -h, --help      显示本帮助

环境变量：
  TLA_JAVA        java 可执行文件路径（默认使用 PATH 中的 java）
  TLA2TOOLS_JAR   tla2tools.jar 路径（默认自动下载 ${TLA2TOOLS_VERSION} 并校验 SHA-256）`);
}

async function main() {
  const argv = process.argv.slice(2);
  let selector = null;
  let listOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      printUsage();
      return;
    }
    if (arg === '--list') {
      listOnly = true;
      continue;
    }
    if (arg === '--spec') {
      selector = argv[++i];
      if (!selector) die('--spec 需要一个规格名');
      continue;
    }
    if (arg.startsWith('--spec=')) {
      selector = arg.slice('--spec='.length);
      continue;
    }
    die(`未知参数：${arg}（用 --help 查看用法）`);
  }

  const all = discoverSpecs();
  if (all.length === 0) die(`spec/ 下没有找到任何 .cfg：${SPEC_DIR}`);
  if (listOnly) {
    console.log(`spec/ 下发现的规格（${all.length} 个）：`);
    for (const spec of all) console.log(`  - ${spec.name}（${spec.cfgFile} + ${spec.tlaFile}）`);
    return;
  }

  const selected = selector ? selectSpecs(all, selector) : all;

  console.log(color.bold('dsh-zipfix TLA+ 形式化验证（TLC）'));
  const java = resolveJava();
  const jar = await resolveJar();
  console.log(`  java    : ${java.command}（来源：${java.source}）`);
  console.log(`  jar     : ${jar.path}（来源：${jar.source}）`);
  console.log(`  spec    : ${SPEC_DIR}`);
  console.log('');

  const results = [];
  for (const spec of selected) {
    console.log(color.bold(`▶ ${spec.name}`));
    const result = runSpec({ java, jar, spec });
    results.push(result);
    if (result.ok) {
      const { generated, distinct, diameter } = result.stats;
      console.log(
        `  ${color.green('[OK] NO ERROR')}  states: ${generated ?? '?'} generated / ${distinct ?? '?'} distinct` +
          ` | diameter: ${diameter ?? '?'} | ${formatSeconds(result.durationMs)}`,
      );
      console.log(color.dim(`       ${SUCCESS_MARKER}`));
    } else {
      console.log(`  ${color.red('[FAIL]')} ${result.error}（${formatSeconds(result.durationMs)}）`);
      console.log(color.dim('  ---- TLC 输出尾部（末 60 行）----'));
      console.log(tailLines(result.output, 60));
      console.log(color.dim('  ---- 输出结束 ----'));
    }
    console.log('');
  }

  const failed = results.filter((result) => !result.ok);
  console.log(color.bold('结果汇总'));
  for (const result of results) {
    if (result.ok) {
      const { generated, distinct, diameter } = result.stats;
      console.log(
        `  ${color.green('PASS')} ${result.spec.name.padEnd(12)} states=${generated}/${distinct} diameter=${diameter}`,
      );
    } else {
      console.log(`  ${color.red('FAIL')} ${result.spec.name.padEnd(12)} ${result.error}`);
    }
  }
  console.log('');
  if (failed.length > 0) {
    console.error(color.red(`✗ ${failed.length} 个规格未通过（共 ${results.length} 个）。`));
    process.exit(1);
  }
  console.log(color.green(`✓ 全部 ${results.length} 个规格通过：Model checking completed. No error has been found.`));
}

main().catch((error) => {
  console.error(`\n${color.red('✗')} 运行失败：${error?.stack ?? error}`);
  process.exit(1);
});
