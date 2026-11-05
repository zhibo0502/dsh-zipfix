/**
 * dsh-zipfix 自测（Node 内置 assert，无第三方依赖）。
 *
 * 运行：
 *   node test/run-tests.mjs
 *
 * 流程：先用 Python 生成独立夹具（make_fixtures.py），再把夹具复制到临时目录执行
 * 真实解压/改名，避免污染仓库内的夹具。任何一步失败都会以非 0 退出。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openZipCatalog, writeFixedZip, verifyFixedZip, fileCrc32 } from '../lib/zip.js';
import { sniffZipEncoding, classifyName, tryReverseName } from '../lib/detect.js';
import {
  extractDocumentTitles,
  fingerprint,
  fixZipArchive,
  matchSource,
  renameDirectory,
  verifyCandidateName,
  verifyNames,
} from '../lib/fix.js';
import { decodeCp437, encodeText, decodeUtf8Replacement } from '../lib/encoding.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(here);
const fixturesDir = path.join(here, 'fixtures');

/* ------------------------------------------------------------------ *
 * 夹具生成
 * ------------------------------------------------------------------ */

function findPython() {
  // 只依赖 PATH / 环境变量，避免在公开源码中留下本机绝对路径
  const candidates = [
    process.env.ZIPFIX_PYTHON,
    'python',
    'python3',
    'py',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import zipfile,zlib,struct'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  throw new Error('找不到可用的 Python 3（可用环境变量 ZIPFIX_PYTHON 指定）');
}

function buildFixtures() {
  const python = findPython();
  const result = spawnSync(python, [path.join(here, 'make_fixtures.py'), fixturesDir], {
    encoding: 'utf8',
    cwd: here,
  });
  if (result.status !== 0) {
    throw new Error(`夹具生成失败：\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf8'));
}

/* ------------------------------------------------------------------ *
 * 迷你测试框架
 * ------------------------------------------------------------------ */

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

async function countFiles(root) {
  let count = 0;
  async function walk(current) {
    const children = await fsp.readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (child.isDirectory()) await walk(path.join(current, child.name));
      else count++;
    }
  }
  await walk(root);
  return count;
}

/** 统计「解压产物」（排除报告目录与修复版 ZIP 这些操作副产物）。 */
async function countExtracted(root) {
  let count = 0;
  const children = await fsp.readdir(root, { withFileTypes: true });
  for (const child of children) {
    if (child.isDirectory()) {
      if (child.name === '_zipfix-reports') continue;
      count += await countFiles(path.join(root, child.name));
    } else if (!/^zipfix-.*\.(md|csv)$/.test(child.name) && !child.name.endsWith('.zip')) count++;
  }
  return count;
}

/** 极简 CSV 解析（足够读本插件报告：逗号分隔、双引号转义、CRLF）。 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (ch !== '\r') field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

const manifest = buildFixtures();
const F = manifest.fixtures;
const case1Zip = path.join(fixturesDir, F.case1.zip);
const case3Zip = path.join(fixturesDir, F.case3.zip);
const case3Damaged = path.join(fixturesDir, F.case3.damaged_dir);
const case2Damaged = path.join(fixturesDir, F.case2.damaged_dir);
const formADir = path.join(fixturesDir, F.formA.dir);
const formA2Dir = path.join(fixturesDir, F.formA2.dir);

let workRoot;

test('夹具：案例 1 条目数与 GBK 原始字节正确', async () => {
  assert.equal(F.case1.entries, 62, '案例 1 应为 62 条目');
  const catalog = openZipCatalog(case1Zip);
  try {
    assert.equal(catalog.entries.length, 62);
    assert.ok(catalog.entries.every((entry) => (entry.flags & 0x0800) === 0), '案例 1 所有条目 flag 应为 0');
    // 用完整根目录名核对原始字节与 CP437 呈现（避免硬编码易漂移的字节片段）
    const expectedRoot = '示例区示例镇示范幼儿园智能化工程-二审资料/';
    const expectedBytes = Buffer.from(encodeText(expectedRoot, 'gbk'));
    assert.deepEqual(catalog.entries[0].nameBytes, expectedBytes);
    assert.equal(decodeCp437(catalog.entries[0].nameBytes), decodeCp437(expectedBytes));
    assert.ok(decodeUtf8Replacement(catalog.entries[0].nameBytes).includes('\uFFFD'));
  } finally {
    catalog.close();
  }
});

test('嗅探：案例 1 判定 gbk 且全部为可逆形态', async () => {
  const catalog = openZipCatalog(case1Zip);
  try {
    const sniffed = sniffZipEncoding(catalog.entries);
    assert.equal(sniffed.encoding, 'gbk');
    assert.equal(sniffed.method, 'sniffed');
    assert.equal(sniffed.confidence, 'high');
    assert.ok(sniffed.scores.gbk >= 9000, `gbk 得分应接近 9675，实际 ${sniffed.scores.gbk}`);
    assert.ok(sniffed.names.every((item) => !item.lossy));
    const forms = sniffed.names.map((item) => classifyName(item.name).form);
    assert.ok(forms.every((form) => form === 'clean' || form === 'ascii'), '解码后应全部正常');
  } finally {
    catalog.close();
  }
});

test('嗅探：合规 UTF-8 ZIP 判为无需修复', async () => {
  const catalog = openZipCatalog(path.join(fixturesDir, F.alreadyUtf8.zip));
  try {
    const sniffed = sniffZipEncoding(catalog.entries);
    assert.equal(sniffed.method, 'declared-utf8');
    const result = await fixZipArchive({ zipPath: path.join(fixturesDir, F.alreadyUtf8.zip), extract: false, dryRun: true });
    assert.equal(result.status, 'no-fix-needed');
  } finally {
    catalog.close();
  }
});

test('嗅探：纯 ASCII ZIP 判为无需修复', async () => {
  const result = await fixZipArchive({ zipPath: path.join(fixturesDir, F.ascii.zip), extract: false, dryRun: true });
  assert.equal(result.status, 'no-fix-needed');
  assert.equal(result.encoding, 'ascii');
});

test('无需修复：合规 ZIP 执行落盘也不产生任何改动（T2）', async () => {
  const zipPath = path.join(fixturesDir, F.alreadyUtf8.zip);
  const outputDir = path.join(workRoot, 'no-fix-out');
  const result = await fixZipArchive({ zipPath, outputDir, dryRun: false, extract: true, buildFixedZip: true });
  assert.equal(result.status, 'no-fix-needed');
  assert.equal(result.applied.extractedFiles, 0);
  assert.equal(result.applied.fixedZipPath, null);
  assert.equal(result.applied.report, null);
  assert.equal(fs.existsSync(outputDir), false, '「无需修复」不得创建输出目录');
});

test('force 语义：强制处理合规 ZIP 时文案不自相矛盾（OBS-6）', async () => {
  const zipPath = path.join(fixturesDir, F.ascii.zip);
  const outputDir = path.join(workRoot, 'force-out');
  const result = await fixZipArchive({ zipPath, outputDir, dryRun: false, extract: true, force: true });
  assert.equal(result.status, 'no-fix-needed');
  assert.equal(result.forced, true);
  assert.match(result.summary, /已按 force:true 强制处理/);
  assert.ok(result.applied.extractedFiles > 0, 'force 时应真实解压');
});

test('嗅探：flag=0x0008 的 GBK ZIP 正确识别（案例 3）', async () => {
  const catalog = openZipCatalog(case3Zip);
  try {
    const sniffed = sniffZipEncoding(catalog.entries);
    assert.equal(sniffed.encoding, 'gbk');
    assert.equal(catalog.entries.every((entry) => (entry.flags & 0x0800) === 0), true);
    assert.equal(catalog.entries[0].flags & 0x0008, 0x0008);
  } finally {
    catalog.close();
  }
});

test('解压：案例 1 dry-run 给出完整计划但不落盘', async () => {
  const outputDir = path.join(workRoot, 'dry-run-case1');
  const result = await fixZipArchive({
    zipPath: path.join(workRoot, 'fixtures', F.case1.zip),
    outputDir,
    dryRun: true,
    extract: true,
    buildFixedZip: true,
  });
  assert.equal(result.status, 'reversible');
  assert.equal(result.stripRoot, `${F.case1.strip_root}/`);
  assert.equal(result.entries.total, 62);
  assert.equal(result.entries.files, 50);
  assert.equal(result.entries.directories, 12);
  assert.equal(result.forms.reversibleA + result.forms.clean + result.forms.ascii, 62);
  assert.equal(fs.existsSync(outputDir), false, 'dry-run 不应创建输出目录');
  // OBS-5：dry-run 计划应预告将生成的修复版 ZIP
  assert.ok(
    result.rows.some((row) => row.action.includes('生成修复版 ZIP（计划）')),
    'dry-run 计划应包含修复版 ZIP 预告',
  );
});

test('displayName：临时文件名的上传包也能识别冗余顶层目录（UI 上传流）', async () => {
  const tempCopy = path.join(workRoot, 'upload-source.zip');
  await fsp.copyFile(path.join(fixturesDir, F.case1.zip), tempCopy);
  const result = await fixZipArchive({
    zipPath: tempCopy,
    displayName: F.case1.zip,
    dryRun: true,
    extract: false,
  });
  assert.equal(result.stripRoot, `${F.case1.strip_root}/`, '应使用原始压缩包名判定冗余顶层目录');
});

test('解压：案例 1 落盘 + 剥离顶层目录 + 逐条 CRC32 + 修复版 ZIP', async () => {
  const zipPath = path.join(workRoot, 'fixtures', F.case1.zip);
  const outputDir = path.join(workRoot, 'case1-out');
  const result = await fixZipArchive({
    zipPath,
    outputDir,
    dryRun: false,
    extract: true,
    buildFixedZip: true,
  });
  assert.equal(result.applied.extractionFailures, 0);
  assert.equal(result.applied.extractedFiles, 50);
  assert.equal(result.applied.extractedDirectories, 11); // 12 个目录条目中含被剥离的冗余根目录
  assert.equal(result.entries.directories, 12);
  assert.equal(await countExtracted(outputDir), 50);
  const topLevel = fs.readdirSync(outputDir).filter((name) => !name.startsWith('zipfix-') && !name.endsWith('.zip'));
  assert.ok(topLevel.includes('01-立项批复'), `应剥离冗余顶层目录，实际顶层：${topLevel.slice(0, 3).join(',')}…`);
  assert.ok(!topLevel.includes(F.case1.strip_root), '不应保留与 ZIP 同名的冗余顶层目录');
  // OBS-3：审计报告写入 _zipfix-reports/ 子目录，不污染用户文件列表
  assert.ok(fs.existsSync(path.join(outputDir, '_zipfix-reports')), '报告应写入 _zipfix-reports 子目录');
  assert.deepEqual(
    fs.readdirSync(outputDir).filter((name) => /^zipfix-.*\.(md|csv)$/.test(name)),
    [],
    '输出目录顶层不应散落报告文件',
  );

  assert.ok(result.applied.fixedZipPath !== null);
  assert.equal(result.applied.fixedZip.allUtf8Flag, true);
  assert.equal(result.applied.fixedZip.fullChecked, true);
  assert.ok(result.applied.report !== null);

  // 用独立路径复核解压内容 CRC32
  const catalog = openZipCatalog(zipPath);
  try {
    const sample = catalog.entries.find((entry) => !entry.isDirectory);
    const expected = catalog.readEntryBuffer(sample);
    const relative = sniffZipEncoding(catalog.entries).names.find((item) => item.entry.index === sample.index).name;
    const stripped = relative.startsWith(`${F.case1.strip_root}/`) ? relative.slice(F.case1.strip_root.length + 1) : relative;
    const actual = await fsp.readFile(path.join(outputDir, stripped));
    assert.deepEqual(actual, expected, '解压内容应与 ZIP 内数据完全一致');
  } finally {
    catalog.close();
  }

  // 修复版 ZIP 回读：全部 0x0800，且能按 UTF-8 读出正确名字（保留原包顶层目录结构）
  const fixed = openZipCatalog(result.applied.fixedZipPath);
  try {
    assert.equal(fixed.entries.length, 62, '修复版 ZIP 应保留全部 62 个条目（含顶层目录）');
    assert.ok(fixed.entries.every((entry) => (entry.flags & 0x0800) !== 0));
    const names = fixed.entries.map((entry) => entry.nameBytes.toString('utf8'));
    assert.ok(
      names.includes(`${F.case1.strip_root}/01-立项批复/`),
      `修复版 ZIP 顶层目录应为中文，实际：${names.slice(0, 3).join(',')}`,
    );
  } finally {
    fixed.close();
  }
});

test('安全：重复解压不覆盖已有文件，自动加 _fixed 后缀', async () => {
  const zipPath = path.join(workRoot, 'fixtures', F.case1.zip);
  const outputDir = path.join(workRoot, 'case1-dup');
  await fixZipArchive({ zipPath, outputDir, dryRun: false, extract: true });
  const filesBefore = await countExtracted(outputDir);
  await fixZipArchive({ zipPath, outputDir, dryRun: false, extract: true });
  const filesAfter = await countExtracted(outputDir);
  assert.equal(filesBefore, 50);
  assert.equal(filesAfter, filesBefore * 2, '第二次解压应全部落到 _fixed 文件，不覆盖');
});

test('特殊字符：全角引号/书名号/括号名字正确落盘', async () => {
  const zipPath = path.join(workRoot, 'fixtures', F.specialChars.zip);
  const outputDir = path.join(workRoot, 'special-out');
  const result = await fixZipArchive({ zipPath, outputDir, dryRun: false, extract: true });
  assert.equal(result.applied.extractionFailures, 0);
  const names = fs.readdirSync(path.join(outputDir, '资料'));
  assert.ok(names.some((name) => name.includes('“示例项目”')), `全角引号应保留，实际：${names.join(' | ')}`);
  assert.ok(names.some((name) => name.includes('《验收报告》')), '书名号应保留');
});

test('源包配对：案例 3 dry-run 唯一命中 3 个且不改名', async () => {
  const damaged = path.join(workRoot, 'fixtures', F.case3.damaged_dir);
  const before = fs.readdirSync(damaged).sort();
  const result = await matchSource({
    directory: damaged,
    sourceZip: path.join(workRoot, 'fixtures', F.case3.zip),
    dryRun: true,
  });
  assert.equal(result.stats.matched, 3);
  assert.equal(result.stats.renamed, 0);
  assert.deepEqual(fs.readdirSync(damaged).sort(), before, 'dry-run 不应改名');
});

test('源包配对：案例 3 落盘改名 3/3 且 SHA-256 复核通过', async () => {
  const damaged = path.join(workRoot, 'fixtures', F.case3.damaged_dir);
  const result = await matchSource({
    directory: damaged,
    sourceZip: path.join(workRoot, 'fixtures', F.case3.zip),
    dryRun: false,
  });
  assert.equal(result.stats.matched, 3);
  assert.equal(result.stats.renamed, 3);
  const names = fs.readdirSync(damaged);
  for (const pair of F.case3.pairs) assert.ok(names.includes(pair.name), `应改名回「${pair.name}」`);
  for (const pair of F.case3.pairs) {
    const { size, crc } = await fileCrc32(path.join(damaged, pair.name));
    assert.equal(size, pair.size);
    assert.equal(crc.toString(16).toUpperCase().padStart(8, '0'), pair.crc32);
  }
  assert.ok(result.report !== null);
});

test('不可逆：案例 2（纯 U+FFFD、无源包）不猜名字', async () => {
  const damaged = path.join(workRoot, 'fixtures', F.case2.damaged_dir);
  const listing = async () =>
    (await fsp.readdir(damaged)).filter((name) => !/^zipfix-/.test(name) && name !== '_zipfix-reports').sort();
  const before = await listing();
  const result = await renameDirectory({ root: damaged, dryRun: false });
  assert.equal(result.stats.renamed, 0, '含 U+FFFD 的名字不得自动改名');
  assert.equal(result.stats.failed, 2);
  assert.deepEqual(await listing(), before);
});

test('形态 A：CP437 乱码目录 dry-run 只出计划', async () => {
  const dir = path.join(workRoot, 'fixtures', F.formA.dir);
  const before = fs.readdirSync(dir).sort();
  const result = await renameDirectory({ root: dir, dryRun: true });
  assert.equal(result.stats.planned, 4, '3 个顶层 + 1 个嵌套文件');
  assert.equal(result.stats.renamed, 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test('形态 A：CP437 乱码目录批量改名（含嵌套子项）', async () => {
  const dir = path.join(workRoot, 'fixtures', F.formA.dir);
  const result = await renameDirectory({ root: dir, dryRun: false });
  assert.equal(result.stats.renamed, 4, '3 个顶层 + 1 个嵌套文件');
  assert.equal(result.stats.failed, 0);
  const names = fs.readdirSync(dir);
  for (const item of F.formA.expect) assert.ok(names.includes(item.fixed), `应还原为「${item.fixed}」，实际 ${names.join(' | ')}`);
  const rootName = F.formA.expect[0].fixed;
  const nested = fs.readdirSync(path.join(dir, rootName));
  assert.ok(nested.includes('结算书-终稿.xlsx'), '嵌套文件也应还原');
});

test('形态 A2：Latin-1 乱码目录批量改名', async () => {
  const dir = path.join(workRoot, 'fixtures', F.formA2.dir);
  const result = await renameDirectory({ root: dir, dryRun: false });
  assert.equal(result.stats.renamed, 2);
  const names = fs.readdirSync(dir);
  for (const item of F.formA2.expect) assert.ok(names.includes(item.fixed), `应还原为「${item.fixed}」`);
});

test('审计报告：rename_dir 的「新名字」列是最终路径（OBS-1）', async () => {
  const dir = path.join(workRoot, 'obs1-formA');
  await fsp.cp(path.join(fixturesDir, F.formA.dir), dir, { recursive: true });
  const result = await renameDirectory({ root: dir, dryRun: false });
  assert.ok(result.report?.csvPath, '应生成 CSV 报告');
  const csv = parseCsv(await fsp.readFile(result.report.csvPath, 'utf8'));
  const header = csv[0];
  const fixedIndex = header.indexOf('新名字');
  assert.ok(fixedIndex >= 0, `CSV 表头应含「新名字」：${header.join(',')}`);
  const dataRows = csv.slice(1).filter((row) => row.length > fixedIndex && row[fixedIndex].length > 0);
  assert.ok(dataRows.length > 0, '报告应有明细行');
  for (const row of dataRows) {
    const fixedPath = row[fixedIndex];
    assert.equal(
      fs.existsSync(path.join(dir, ...fixedPath.split('/'))),
      true,
      `报告中的新名字应指向真实存在的最终路径：${fixedPath}`,
    );
  }
});

test('审计报告：match_source 不把自己的报告当用户文件（OBS-3）', async () => {
  const dir = path.join(workRoot, 'obs3-damaged');
  await fsp.cp(path.join(fixturesDir, F.case3.damaged_dir), dir, { recursive: true });
  const zip = path.join(workRoot, 'fixtures', F.case3.zip);
  const first = await matchSource({ directory: dir, sourceZip: zip, dryRun: false });
  assert.equal(first.stats.renamed, 3);
  assert.ok(fs.existsSync(path.join(dir, '_zipfix-reports')), '报告应写入 _zipfix-reports 子目录');
  const second = await matchSource({ directory: dir, sourceZip: zip, dryRun: false });
  assert.equal(second.stats.scanned, 3, `第二次扫描不应包含报告文件（实际 ${second.stats.scanned}）`);
  assert.equal(second.stats.unmatched, 0);
});

test('错误信息：不存在路径给出中文可读错误（OBS-4）', async () => {
  await assert.rejects(
    () => fixZipArchive({ zipPath: path.join(workRoot, 'nope.zip'), dryRun: true }),
    /ZIP 不存在或无法访问/,
  );
  await assert.rejects(
    () => matchSource({ directory: workRoot, sourceZip: path.join(workRoot, 'nope.zip'), dryRun: true }),
    /源 ZIP 不存在或无法访问/,
  );
  await assert.rejects(
    () => renameDirectory({ root: path.join(workRoot, 'no-such-dir'), dryRun: true }),
    /目录不存在或不是目录/,
  );
});

test('指纹：GBK 编码指纹与 Python 结果逐字符一致', async () => {
  const expected = F.case2.damaged[0];
  const actual = fingerprint(F.case2.names[0]);
  assert.equal(actual, expected);
  const verified = verifyCandidateName(F.case2.names[0], expected);
  assert.equal(verified.match, 'exact');
  const wrong = verifyCandidateName('附件1：“示例项目”运维费用汇总表.xlsx', expected);
  assert.equal(wrong.match, 'none');
});

test('指纹：非 GBK 可编码字符（emoji）判为 unencodable', async () => {
  const result = verifyCandidateName('方案😀.docx', F.case2.damaged[0]);
  assert.equal(result.match, 'unencodable');
});

test('内容反推：xlsx 抽取内部标题', async () => {
  const result = await extractDocumentTitles(path.join(fixturesDir, F.xlsxTitles.document));
  assert.equal(result.kind, 'xlsx');
  for (const expected of F.xlsxTitles.expect_titles_contain) {
    assert.ok(result.titles.some((title) => title.includes(expected)), `应抽取到「${expected}」，实际：${result.titles.join(' | ')}`);
  }
});

test('内容反推 + 指纹验证：docx 自动生成候选并通过验证', async () => {
  const damaged = path.join(workRoot, 'fixtures', F.verifyDocx.dir);
  const [damagedName] = fs.readdirSync(damaged);
  const result = await verifyNames({
    mojibakeName: damagedName,
    documentPath: path.join(fixturesDir, F.verifyDocx.document),
  });
  assert.ok(result.document.titles.length > 0, '应抽取到文档标题');
  const verifiedNames = result.verified.map((item) => item.candidate);
  assert.ok(verifiedNames.includes(F.verifyDocx.correct_name), `应验证出「${F.verifyDocx.correct_name}」，实际：${verifiedNames.join(' | ')}`);
  assert.equal(fs.readdirSync(damaged)[0], damagedName, 'verify_names 不得改名');
});

test('ZIP64：强制 ZIP64 重建后回读正常', async () => {
  const source = openZipCatalog(path.join(fixturesDir, F.ascii.zip));
  const dest = path.join(workRoot, 'zip64-test.zip');
  try {
    await writeFixedZip({
      sourceCatalog: source,
      destPath: dest,
      plans: source.entries.map((entry) => ({ entry, name: entry.nameBytes.toString('utf8') })),
      forceZip64: true,
    });
  } finally {
    source.close();
  }
  const verification = await verifyFixedZip(dest, { full: true });
  assert.equal(verification.entries, source.entries.length);
  assert.equal(verification.allUtf8Flag, true);
  assert.equal(verification.zip64, true);
  const catalog = openZipCatalog(dest);
  try {
    assert.equal(catalog.zip64, true);
    const names = catalog.entries.map((entry) => entry.nameBytes.toString('utf8'));
    assert.ok(names.includes('readme.txt'));
  } finally {
    catalog.close();
  }
});

test('约束：写入目标已存在时绝不覆盖（wx 独占）', async () => {
  const source = openZipCatalog(path.join(fixturesDir, F.ascii.zip));
  const dest = path.join(workRoot, 'dup-target.zip');
  const plans = source.entries.map((entry) => ({ entry, name: entry.nameBytes.toString('utf8') }));
  try {
    await writeFixedZip({ sourceCatalog: source, destPath: dest, plans });
    await assert.rejects(() => writeFixedZip({ sourceCatalog: source, destPath: dest, plans }), /EEXIST/);
  } finally {
    source.close();
  }
});

test('编码原语：GBK 编码表与 CP437 表自洽', async () => {
  const chinese = '示例区示例镇';
  const bytes = encodeText(chinese, 'gbk');
  assert.equal(bytes.toString('hex'), 'cabec0fdc7f8cabec0fdd5f2');
  assert.equal(decodeCp437(bytes), '╩╛└²╟°╩╛└²╒≥');
  assert.deepEqual(tryReverseName('╩╛└²╟°╩╛└²╒≥').fixed, '示例区示例镇');
});

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */

async function main() {
  workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'zipfix-test-'));
  await fsp.cp(fixturesDir, path.join(workRoot, 'fixtures'), { recursive: true });

  let passed = 0;
  const failures = [];
  for (const item of tests) {
    try {
      await item.fn();
      passed++;
      console.log(`  PASS  ${item.name}`);
    } catch (error) {
      failures.push({ name: item.name, error });
      console.log(`  FAIL  ${item.name}`);
    }
  }
  console.log('');
  console.log(`工作目录：${workRoot}`);
  console.log(`结果：${passed}/${tests.length} 通过，${failures.length} 失败`);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`\n=== FAIL: ${failure.name} ===`);
      console.error(failure.error?.stack ?? String(failure.error));
    }
    process.exitCode = 1;
  } else {
    await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
