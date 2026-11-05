/**
 * 修复操作核心（对应交接文档 §5 方法论与 §6.5 ALG-3 ~ ALG-7）。
 *
 * 所有会落盘的操作都遵守三条安全红线：
 * 1. 永不删除、永不覆盖源 ZIP / 源文件；
 * 2. 改名前后记录 size（可选再加 SHA-256）并复核；
 * 3. 目标同名时自动加 `_fixed` 序号后缀，绝不静默覆盖。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  crc32,
  extractEntry,
  fileCrc32,
  formatCrc,
  openZipCatalog,
  verifyFixedZip,
  writeFixedZip,
} from './zip.js';
import {
  classifyName,
  detectRedundantRoot,
  sanitizeEntryName,
  sanitizePathSegment,
  sniffZipEncoding,
  summarizeForms,
  suspicionMarkers,
  tryReverseName,
} from './detect.js';
import { decodeUtf8Replacement, encodeText, hasFffd, countFffd } from './encoding.js';
import { buildReport, timestamp, writeReportFiles } from './report.js';

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
}

async function pathExists(target) {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

async function isDirectory(target) {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function splitName(name) {
  const isDir = name.endsWith('/');
  const body = isDir ? name.slice(0, -1) : name;
  const slash = body.lastIndexOf('/');
  const dirPart = slash >= 0 ? body.slice(0, slash + 1) : '';
  const file = slash >= 0 ? body.slice(slash + 1) : body;
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  return { dirPart, stem, ext, isDir };
}

/** 在名字主干后追加后缀（保留扩展名与目录部分；目录保留末尾 '/'）。 */
function addSuffix(name, suffix) {
  const { dirPart, stem, ext, isDir } = splitName(name);
  return isDir ? `${dirPart}${stem}${suffix}/` : `${dirPart}${stem}${suffix}${ext}`;
}

/** 多级相对路径的冲突处理（用于解压落盘；目录允许合并）。 */
async function uniqueNestedPath(root, relative, { suffix = '_fixed' } = {}) {
  const { dirPart, stem, ext, isDir } = splitName(relative);
  let name = isDir ? `${dirPart}${stem}` : `${dirPart}${stem}${ext}`;
  let attempt = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const target = path.join(root, name);
    const exists = await pathExists(target);
    if (!exists) return { relative: isDir ? `${name}/` : name, target, existingDirectory: false };
    if (isDir && (await isDirectory(target))) return { relative: `${name}/`, target, existingDirectory: true };
    attempt++;
    if (attempt > 1000) throw new Error(`无法为 ${relative} 找到不冲突的名字`);
    const tag = attempt === 2 ? suffix : `${suffix}_${attempt - 1}`;
    name = `${dirPart}${stem}${tag}${isDir ? '' : ext}`;
  }
}
async function uniqueTargetPath(dir, desiredSegment, { isDir = false, suffix = '_fixed' } = {}) {
  let candidate = desiredSegment;
  let attempt = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const target = path.join(dir, candidate);
    const exists = await pathExists(target);
    if (!exists) return { name: candidate, target, existingDirectory: false };
    if (isDir && (await isDirectory(target))) return { name: candidate, target, existingDirectory: true };
    attempt++;
    if (attempt > 1000) throw new Error(`无法为 ${desiredSegment} 找到不冲突的名字`);
    const tag = attempt === 2 ? suffix : `${suffix}_${attempt - 1}`;
    candidate = isDir ? `${desiredSegment}${tag}` : addSuffix(desiredSegment, tag);
  }
}

/** 单个路径段的安全化（用于已解压目录改名）。 */
export function sanitizeSegment(name) {
  return sanitizePathSegment(name);
}

/** 条目在「读取方未声明编码」时的显示形态，用于报告与人工核对。 */
export function mojibakeDisplay(entry) {
  if (entry.utf8Flag) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(entry.nameBytes);
    } catch {
      return decodeUtf8Replacement(entry.nameBytes);
    }
  }
  return decodeUtf8Replacement(entry.nameBytes);
}

/* ------------------------------------------------------------------ *
 * 形态 A：已解压目录批量改名（ALG-5）
 * ------------------------------------------------------------------ */

/** 审计报告固定写入被处理目录下的这个子目录，避免污染用户文件列表。 */
export const REPORTS_DIR_NAME = '_zipfix-reports';
/** 旧版本直接写在目标目录里的报告文件名前缀（扫描/配对时一并跳过）。 */
const LEGACY_REPORT_FILE = /^zipfix-(?:fix-zip|rename-dir|match-source)-/;

/** 报告子目录的绝对路径。 */
export function reportsDirectory(baseDir) {
  return path.join(baseDir, REPORTS_DIR_NAME);
}

/** 递归收集目录项（自底向上：先深后浅），保证父目录改名时子项已处理完。 */
async function collectTree(root, { recursive = true } = {}) {
  const files = [];
  const dirs = [];
  async function walk(current, relative) {
    const children = await fsp.readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (child.isDirectory() && child.name === REPORTS_DIR_NAME) continue; // 跳过本插件自己的报告目录
      if (child.isFile() && LEGACY_REPORT_FILE.test(child.name)) continue; // 跳过旧版报告文件
      const abs = path.join(current, child.name);
      const rel = relative === '' ? child.name : `${relative}/${child.name}`;
      if (child.isDirectory()) {
        if (recursive) await walk(abs, rel);
        dirs.push({ abs, rel, name: child.name, depth: rel.split('/').length });
      } else if (child.isFile()) {
        files.push({ abs, rel, name: child.name, depth: rel.split('/').length });
      }
    }
  }
  await walk(root, '');
  // 深度大的先处理；同深度按名字稳定排序，保证报告可复现
  files.sort((a, b) => b.depth - a.depth || a.rel.localeCompare(b.rel));
  dirs.sort((a, b) => b.depth - a.depth || a.rel.localeCompare(b.rel));
  return { files, dirs };
}

/**
 * 用「旧绝对路径 → 新绝对路径」映射把原始路径解析成改名完成后的最终路径。
 * 逐段前进：旧路径用于查映射，新路径用于拼接（改名只改名字，不改父目录层级）。
 * @param {string} root 未被改名的根目录
 * @param {string} originalAbs 改名前的绝对路径
 * @param {Map<string, string>} renameMap 旧绝对路径 → 改名目标绝对路径
 * @returns {string} 最终绝对路径
 */
function resolveFinalPath(root, originalAbs, renameMap) {
  const relative = path.relative(root, originalAbs);
  if (relative === '' || relative.startsWith('..')) return originalAbs;
  let currentOld = root;
  let currentNew = root;
  for (const segment of relative.split(path.sep)) {
    currentOld = path.join(currentOld, segment);
    const mapped = renameMap.get(currentOld);
    currentNew = mapped === undefined ? path.join(currentNew, segment) : path.join(currentNew, path.basename(mapped));
  }
  return currentNew;
}

/**
 * 对已解压目录做形态 A 批量改名（cp437/latin-1 → GBK）。
 * @param {object} options
 * @param {string} options.root 目录绝对路径
 * @param {boolean} [options.dryRun] 默认 true：只出计划不动文件
 * @param {boolean} [options.recursive] 默认 true
 * @param {boolean} [options.verifyHashes] 是否计算 SHA-256（默认 false，仅记录 size）
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} 结构化报告
 */
export async function renameDirectory({ root, dryRun = true, recursive = true, verifyHashes = false, signal }) {
  const startedAt = new Date();
  if (!(await isDirectory(root))) throw new Error(`目录不存在或不是目录：${root}`);
  const { files, dirs } = await collectTree(root, { recursive });
  const candidates = [...files, ...dirs].sort((a, b) => b.depth - a.depth || a.rel.localeCompare(b.rel));
  const rows = [];
  const failures = [];
  const skipped = [];
  let renamed = 0;

  // 先做计划（必须整体规划完再动手，便于报告与 dry-run）
  const plans = [];
  for (const item of candidates) {
    throwIfAborted(signal);
    const classified = classifyName(item.name);
    if (classified.form === 'irreversible') {
      failures.push({ original: item.rel, reason: `含 ${countFffd(item.name)} 个 U+FFFD，字节已销毁，需找源包或内容反推` });
      continue;
    }
    if (classified.form === 'double') {
      failures.push({ original: item.rel, reason: '二次损坏（锟斤拷型），基本只能靠源包还原' });
      continue;
    }
    if (classified.form === 'A' || classified.form === 'A2') {
      const safeName = sanitizeSegment(classified.fixed);
      plans.push({
        item,
        from: item.name,
        to: safeName,
        basis: `${classified.chain}（形态 ${classified.form}）`,
        markers: classified.markers ?? [],
      });
      continue;
    }
    if (classified.form === 'unknown') {
      skipped.push({ original: item.rel, reason: '无法自动识别编码，保持原名' });
    }
  }

  /** 旧绝对路径 → 改名目标绝对路径（成功改名后记录，用于回填最终路径）。 */
  const renameMap = new Map();

  if (!dryRun) {
    for (const plan of plans) {
      throwIfAborted(signal);
      const source = plan.item.abs;
      const dir = path.dirname(source);
      let before;
      try {
        before = await fsp.stat(source);
      } catch (error) {
        failures.push({ original: plan.item.rel, reason: `读取源状态失败：${error.message}` });
        continue;
      }
      const isDir = before.isDirectory();
      let resolved;
      try {
        resolved = await uniqueTargetPath(dir, plan.to, { isDir });
      } catch (error) {
        failures.push({ original: plan.item.rel, reason: error.message });
        continue;
      }
      if (resolved.target === source) continue;
      let sha256Before;
      if (verifyHashes && !isDir) {
        try {
          sha256Before = (await fileCrc32(source, { signal })).sha256;
        } catch (error) {
          failures.push({ original: plan.item.rel, reason: `计算 SHA-256 失败：${error.message}` });
          continue;
        }
      }
      try {
        await fsp.rename(source, resolved.target);
      } catch (error) {
        failures.push({ original: plan.item.rel, reason: `改名失败：${error.message}` });
        continue;
      }
      let after;
      try {
        after = await fsp.stat(resolved.target);
      } catch (error) {
        failures.push({ original: plan.item.rel, reason: `改名后复核失败：${error.message}` });
        continue;
      }
      let verify = 'size 一致';
      const noteParts = [];
      if (plan.markers.length > 0) noteParts.push(`可疑痕迹：${plan.markers.join('、')}`);
      if (resolved.existingDirectory) noteParts.push('目标目录已存在，已合并');
      if (verifyHashes && sha256Before) {
        const sha256After = (await fileCrc32(resolved.target, { signal })).sha256;
        if (sha256After !== sha256Before) {
          failures.push({ original: plan.item.rel, reason: '改名后 SHA-256 不一致（已回滚）' });
          await fsp.rename(resolved.target, source).catch(() => {});
          continue;
        }
        verify = 'SHA-256 一致';
      } else if (after.size !== before.size) {
        failures.push({ original: plan.item.rel, reason: '改名后 size 不一致' });
        continue;
      }
      renamed++;
      renameMap.set(source, resolved.target);
      rows.push({
        action: isDir ? '改目录名' : '改文件名',
        original: plan.item.rel,
        abs: source,
        basis: plan.basis,
        verify,
        note: noteParts.join('；'),
      });
    }
  } else {
    for (const plan of plans) {
      let before = null;
      try {
        before = await fsp.stat(plan.item.abs);
      } catch {
        /* dry-run 只做展示，状态读取失败不阻断计划 */
      }
      const isDir = before?.isDirectory() ?? false;
      let resolved = null;
      try {
        resolved = await uniqueTargetPath(path.dirname(plan.item.abs), plan.to, { isDir });
      } catch {
        /* 冲突探测失败时退回未加后缀的计划名 */
      }
      const target = resolved?.target ?? path.join(path.dirname(plan.item.abs), plan.to);
      renameMap.set(plan.item.abs, target);
      rows.push({
        action: resolved?.existingDirectory ? '改名（目标目录已存在，将合并）' : '改名（计划）',
        original: plan.item.rel,
        abs: plan.item.abs,
        basis: plan.basis,
        verify: 'dry-run 未执行',
        note: plan.markers.length > 0 ? `可疑痕迹：${plan.markers.join('、')}` : '',
      });
    }
  }

  // 统一回填最终路径：嵌套条目在改名当刻父目录仍是乱码名，报告必须给最终结果
  for (const row of rows) {
    row.fixed = path.relative(root, resolveFinalPath(root, row.abs, renameMap)).replace(/\\/g, '/');
    delete row.abs;
  }

  const stats = {
    scanned: candidates.length,
    planned: plans.length,
    renamed,
    failed: failures.length,
    skipped: skipped.length,
  };
  const generatedAt = startedAt.toISOString();
  const report = buildReport({
    title: 'ZIP 中文文件名修复报告（已解压目录）',
    generatedAt,
    meta: [
      { label: '目录', value: root },
      { label: '模式', value: dryRun ? 'dry-run（只报告，未改动任何文件）' : '执行改名' },
    ],
    summary: [
      { label: '扫描项', value: stats.scanned },
      { label: '可还原（形态 A）', value: stats.planned },
      { label: '已改名', value: stats.renamed },
      { label: '失败', value: stats.failed },
      { label: '无法识别', value: stats.skipped },
    ],
    rows: rows.slice(0, 5000),
    failures,
    notes: [
      '形态 A 无损还原原理：原始字节 = 乱码字符串.encode(cp437 或 latin-1)，正确名字 = 原始字节.decode(gbk)。',
      'U+FFFD 是字节级信息丢失（多对一映射），不存在通用算法；请使用 zipfix_match_source 按 (size, CRC32) 配对源包，或使用 zipfix_verify_names 做内容反推验证。',
      ...(skipped.length > 0 ? [`${skipped.length} 个名字无法自动识别编码，已在下方「失败 / 待人工」中列出原始路径，建议人工确认。`] : []),
    ],
  });
  for (const item of skipped) failures.push({ original: item.original, reason: item.reason });

  let reportPaths = null;
  if (!dryRun) {
    reportPaths = await writeReportFiles(reportsDirectory(root), 'rename-dir', report);
  }

  return {
    ok: true,
    kind: 'directory',
    root,
    dryRun,
    stats,
    rows: rows.slice(0, 50),
    failures: failures.slice(0, 50),
    report: reportPaths,
    generatedAt,
    summary: dryRun
      ? `dry-run：扫描 ${stats.scanned} 项，可还原 ${stats.planned} 项，待人工 ${stats.failed + stats.skipped} 项（未改动任何文件）`
      : `已改名 ${stats.renamed} 项，失败 ${stats.failed} 项，无法识别 ${stats.skipped} 项`,
  };
}

/* ------------------------------------------------------------------ *
 * 形态 B 最优解：源包 CRC 配对（ALG-6）
 * ------------------------------------------------------------------ */

/** 递归列出目录下所有普通文件。 */
async function listFiles(root, { recursive = true } = {}) {
  const result = [];
  async function walk(current, relative) {
    const children = await fsp.readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (child.isDirectory() && child.name === REPORTS_DIR_NAME) continue; // 跳过本插件自己的报告目录
      if (child.isFile() && LEGACY_REPORT_FILE.test(child.name)) continue; // 跳过旧版报告文件
      const abs = path.join(current, child.name);
      const rel = relative === '' ? child.name : `${relative}/${child.name}`;
      if (child.isDirectory()) {
        if (recursive) await walk(abs, rel);
      } else if (child.isFile()) {
        result.push({ abs, rel, name: child.name });
      }
    }
  }
  await walk(root, '');
  return result;
}

/**
 * 用源 ZIP 的 (size, CRC32) 精确配对已解压目录中的受损文件并改名。
 * 只有「唯一命中」才改名；0 个或多个命中一律进入待人工清单。
 *
 * @param {object} options
 * @param {string} options.directory 受损目录
 * @param {string} options.sourceZip 源 ZIP
 * @param {string} [options.encoding] 强制源 ZIP 条目名编码
 * @param {boolean} [options.dryRun] 默认 true
 * @param {boolean} [options.recursive] 默认 true
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>}
 */
export async function matchSource({
  directory,
  sourceZip,
  encoding,
  dryRun = true,
  recursive = true,
  signal,
}) {
  const startedAt = new Date();
  if (!(await isDirectory(directory))) throw new Error(`目录不存在或不是目录：${directory}`);
  let stat;
  try {
    stat = await fsp.stat(sourceZip);
  } catch (error) {
    throw new Error(`源 ZIP 不存在或无法访问：${sourceZip}（${error.code ?? error.message}）`);
  }
  if (!stat.isFile()) throw new Error(`源 ZIP 不存在或不是文件：${sourceZip}`);

  const catalog = openZipCatalog(sourceZip);
  try {
    const sniffed = sniffZipEncoding(catalog.entries, { encoding });
    /** @type {Map<string, Array<{name: string, entry: object}>>} */
    const byContent = new Map();
    for (const { entry, name } of sniffed.names) {
      if (entry.isDirectory) continue;
      const key = `${entry.uncompressedSize}:${formatCrc(entry.crc)}`;
      const bucket = byContent.get(key);
      const item = { name, entry };
      if (bucket === undefined) byContent.set(key, [item]);
      else bucket.push(item);
    }

    const files = await listFiles(directory, { recursive });
    const rows = [];
    const failures = [];
    const unmatched = [];
    let renamed = 0;

    for (const file of files) {
      throwIfAborted(signal);
      const local = await fileCrc32(file.abs, { signal });
      const key = `${local.size}:${formatCrc(local.crc)}`;
      const bucket = byContent.get(key) ?? [];
      const display = file.rel;
      if (bucket.length === 0) {
        unmatched.push({ path: display, size: local.size, crc: formatCrc(local.crc) });
        continue;
      }
      if (bucket.length > 1) {
        failures.push({
          original: display,
          reason: `源 ZIP 中有 ${bucket.length} 个条目具有相同 (size, CRC32)，不猜名字，请人工确认`,
        });
        continue;
      }
      const hit = bucket[0];
      const sanitized = sanitizeEntryName(hit.name);
      if (!sanitized.safe) {
        failures.push({ original: display, reason: `源条目名不安全（${sanitized.reason}）：${hit.name}` });
        continue;
      }
      const baseName = path.posix.basename(sanitized.name);
      if (baseName === file.name) {
        rows.push({
          action: '无需改名',
          original: display,
          fixed: display,
          basis: `(size, CRC32) 唯一命中源条目 ${hit.name}`,
          verify: `SHA-256 ${local.sha256.slice(0, 12)}…`,
          note: '名字已与源条目一致',
        });
        continue;
      }
      let resolved;
      try {
        resolved = await uniqueTargetPath(path.dirname(file.abs), baseName);
      } catch (error) {
        failures.push({ original: display, reason: error.message });
        continue;
      }
      const finalName = resolved.name;
      const target = resolved.target;
      if (!dryRun) {
        try {
          await fsp.rename(file.abs, target);
        } catch (error) {
          failures.push({ original: display, reason: `改名失败：${error.message}` });
          continue;
        }
        const after = await fsp.stat(target);
        if (after.size !== local.size) {
          failures.push({ original: display, reason: '改名后 size 不一致，疑似被外部改动' });
          continue;
        }
        const afterCheck = await fileCrc32(target, { signal });
        if (afterCheck.sha256 !== local.sha256) {
          failures.push({ original: display, reason: '改名后 SHA-256 不一致' });
          continue;
        }
        renamed++;
      }
      rows.push({
        action: dryRun ? '改名（计划）' : '改名',
        original: display,
        fixed: path.join(path.relative(directory, path.dirname(file.abs)), finalName).replace(/\\/g, '/'),
        basis: `(size=${local.size}, CRC32=${formatCrc(local.crc)}) 唯一命中源条目「${hit.name}」`,
        verify: dryRun ? 'dry-run 未执行' : 'SHA-256 一致',
        note: '',
      });
    }

    for (const item of unmatched) {
      failures.push({
        original: item.path,
        reason: `源 ZIP 中找不到 (size=${item.size}, CRC32=${item.crc}) 的条目，无法配对`,
      });
    }

    const generatedAt = startedAt.toISOString();
    const report = buildReport({
      title: 'ZIP 中文文件名修复报告（源包 CRC 配对）',
      generatedAt,
      meta: [
        { label: '受损目录', value: directory },
        { label: '源 ZIP', value: sourceZip },
        { label: '源 ZIP 条目名编码', value: `${sniffed.encoding ?? 'ascii'}（${sniffed.method}，置信度 ${sniffed.confidence}）` },
        { label: '模式', value: dryRun ? 'dry-run（只报告，未改动任何文件）' : '执行改名' },
      ],
      summary: [
        { label: '目录文件数', value: files.length },
        { label: '唯一配对成功', value: rows.filter((row) => row.action !== '无需改名').length },
        { label: '已改名', value: renamed },
        { label: '未配对', value: unmatched.length },
        { label: '待人工', value: failures.length },
      ],
      rows: rows.slice(0, 5000),
      failures,
      notes: [
        '这是形态 B（含 U+FFFD）的最优修复路径：(文件大小, CRC32) 唯一命中源 ZIP 中央目录条目，数学上可证。',
        '改名前后均记录 SHA-256 并复核，内容零改动。',
      ],
    });
    const reportPaths = dryRun ? null : await writeReportFiles(reportsDirectory(directory), 'match-source', report);

    return {
      ok: true,
      kind: 'directory',
      directory,
      sourceZip,
      sourceEncoding: sniffed.encoding,
      sourceMethod: sniffed.method,
      sourceConfidence: sniffed.confidence,
      dryRun,
      stats: {
        scanned: files.length,
        matched: rows.filter((row) => row.action !== '无需改名').length,
        renamed,
        unmatched: unmatched.length,
        failed: failures.length,
      },
      rows: rows.slice(0, 50),
      failures: failures.slice(0, 50),
      report: reportPaths,
      generatedAt,
      summary: dryRun
        ? `dry-run：扫描 ${files.length} 个文件，唯一配对 ${rows.length} 个，未配对 ${unmatched.length} 个，待人工 ${failures.length} 个（未改动任何文件）`
        : `已改名 ${renamed} 个文件，未配对 ${unmatched.length} 个，待人工 ${failures.length} 个`,
    };
  } finally {
    catalog.close();
  }
}

/* ------------------------------------------------------------------ *
 * ZIP 修复：解压 + 修复版 ZIP（ALG-3 / ALG-4）
 * ------------------------------------------------------------------ */

/**
 * 修复一个 ZIP：按正确编码解码条目名，无损解压到同级目录，并可选生成修复版 ZIP。
  
 * @param {object} options
 * @param {string} options.zipPath ZIP 绝对路径
 * @param {string} [options.outputDir] 输出目录，默认与 ZIP 同级
 * @param {string} [options.encoding] 强制编码（utf-8/gbk/gb18030/big5）
 * @param {boolean} [options.extract] 默认 true
 * @param {boolean} [options.buildFixedZip] 默认 false：是否额外生成修复版 ZIP
 * @param {boolean} [options.stripRoot] 默认 true：剥离与 ZIP 同名的冗余顶层目录
 * @param {boolean} [options.dryRun] 默认 true
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>}
 */
export async function fixZipArchive({
  zipPath,
  outputDir,
  encoding,
  extract = true,
  buildFixedZip = false,
  stripRoot = true,
  dryRun = true,
  force = false,
  displayName,
  signal,
}) {
  const startedAt = new Date();
  let stat;
  try {
    stat = await fsp.stat(zipPath);
  } catch (error) {
    throw new Error(`ZIP 不存在或无法访问：${zipPath}（${error.code ?? error.message}）`);
  }
  if (!stat.isFile()) throw new Error(`ZIP 不存在或不是文件：${zipPath}`);
  const catalog = openZipCatalog(zipPath);
  try {
    const sniffed = sniffZipEncoding(catalog.entries, { encoding });
    const names = sniffed.names;
    const outDir = outputDir ?? path.dirname(zipPath);
    // 冗余顶层目录按「原始压缩包名」判定：上传到临时目录的 ZIP 也保留原始文件名语义
    const rootPrefix = stripRoot ? detectRedundantRoot(names, displayName ?? zipPath) : '';

    const decodedForms = names.map((item) => ({ name: item.name, form: classifyName(item.name).form }));
    const forms = summarizeForms(decodedForms);
    const lossy = names.filter((item) => item.lossy).length;
    const irreversible = names
      .filter((item) => hasFffd(item.name))
      .map((item) => ({ name: item.name, fffd: countFffd(item.name), original: mojibakeDisplay(item.entry) }));

    // 条目计划：
    // - extractName：剥离冗余顶层目录后的落盘相对路径（null 表示该条目只进修复版 ZIP）
    // - fixedName  ：保持原包结构的修复版 ZIP 条目名（只做安全化与去重）
    const plans = [];
    const failures = [];
    const seenExtract = new Map();
    const seenFixed = new Map();
    const dedupe = (candidate, seen, original, label) => {
      const count = (seen.get(candidate) ?? 0) + 1;
      seen.set(candidate, count);
      if (count === 1) return candidate;
      const renamed = addSuffix(candidate, `_${count}`);
      failures.push({ original, reason: `${label}重复，已改名 ${renamed} 以免覆盖` });
      return renamed;
    };
    for (const { entry, name } of names) {
      throwIfAborted(signal);
      const original = mojibakeDisplay(entry);
      if (!entry.supported) {
        failures.push({ original, reason: entry.encrypted ? '条目已加密，无法解压' : `不支持的压缩方式（method=${entry.method}）` });
        continue;
      }
      const sanitizedFixed = sanitizeEntryName(name);
      if (!sanitizedFixed.safe) {
        failures.push({ original, reason: `条目名不安全：${sanitizedFixed.reason}` });
        continue;
      }
      const fixedName = dedupe(sanitizedFixed.name, seenFixed, original, '修复版 ZIP 条目名');
      let extractName = fixedName;
      let skipExtract = false;
      if (rootPrefix !== '' && (fixedName === rootPrefix || fixedName.startsWith(rootPrefix))) {
        extractName = fixedName.slice(rootPrefix.length);
        if (extractName.length === 0) skipExtract = true;
      }
      if (!skipExtract) {
        const sanitizedExtract = sanitizeEntryName(extractName);
        if (!sanitizedExtract.safe) {
          failures.push({ original, reason: `解压路径不安全：${sanitizedExtract.reason}` });
          skipExtract = true;
        } else {
          extractName = dedupe(sanitizedExtract.name, seenExtract, original, '解压目标名');
        }
      }
      plans.push({
        entry,
        original,
        extractName: skipExtract ? null : extractName,
        fixedName,
        lossy: name.includes('\uFFFD'),
      });
    }

    const status =
      sniffed.method === 'declared-utf8'
        ? 'no-fix-needed'
        : sniffed.method === 'ascii'
          ? 'no-fix-needed'
          : sniffed.encoding === 'utf-8'
            ? 'flag-missing-utf8'
            : sniffed.method === 'undecodable'
              ? 'unknown'
              : irreversible.length > 0
                ? 'mixed'
                : 'reversible';

    const fileCount = catalog.entries.filter((entry) => !entry.isDirectory).length;
    const dirCount = catalog.entries.filter((entry) => entry.isDirectory).length;
    const entriesSummary = {
      total: catalog.entries.length,
      files: fileCount,
      directories: dirCount,
      nonAscii: sniffed.nonAsciiEntries,
      declaredUtf8: sniffed.declaredUtf8Entries,
      lossy,
    };

    // 「无需修复」必须做到不产生任何改动（交接文档 T2）：除非显式 force，
    // 不建目录、不解压、不写修复版 ZIP、也不写报告文件。
    if (status === 'no-fix-needed' && !force) {
      return {
        ok: true,
        kind: 'zip',
        zipPath,
        zipSize: stat.size,
        outputDir: outDir,
        dryRun,
        encoding: sniffed.encoding,
        method: sniffed.method,
        confidence: sniffed.confidence,
        scores: sniffed.scores,
        status,
        entries: entriesSummary,
        forms,
        stripRoot: rootPrefix,
        applied: {
          extractedFiles: 0,
          extractedDirectories: 0,
          extractionFailures: 0,
          fixedZipPath: null,
          fixedZip: null,
          outputDir: outDir,
          report: null,
        },
        rows: [],
        failures: failures.slice(0, 50),
        irreversible: [],
        warnings: sniffed.warnings.slice(0, 20),
        generatedAt: startedAt.toISOString(),
        summary: `文件名编码已合规（${sniffed.method}），未产生任何改动。`,
      };
    }

    const applied = {
      extractedFiles: 0,
      extractedDirectories: 0,
      extractionFailures: 0,
      fixedZipPath: null,
      fixedZip: null,
      outputDir: outDir,
      report: null,
    };
    const rows = [];

    if (!dryRun && extract) {
      await fsp.mkdir(outDir, { recursive: true });
      for (const plan of plans) {
        throwIfAborted(signal);
        if (plan.extractName === null) continue; // 冗余根目录本身：只进修复版 ZIP
        const target = path.join(outDir, plan.extractName);
        if (plan.extractName.endsWith('/')) {
          await fsp.mkdir(target, { recursive: true });
          applied.extractedDirectories++;
          rows.push({
            action: '解压目录',
            original: plan.original,
            fixed: plan.extractName,
            basis: `${sniffed.encoding}${sniffed.method === 'forced' ? '（强制）' : ''}`,
            verify: '已创建',
            note: '',
          });
          continue;
        }
        let resolved;
        try {
          resolved = await uniqueNestedPath(outDir, plan.extractName);
        } catch (error) {
          applied.extractionFailures++;
          failures.push({ original: plan.original, reason: error.message });
          continue;
        }
        const finalName = resolved.relative;
        const finalPath = resolved.target;
        try {
          const result = await extractEntry(catalog, plan.entry, finalPath, { signal });
          applied.extractedFiles++;
          rows.push({
            action: '解压',
            original: plan.original,
            fixed: finalName,
            basis: `${sniffed.encoding}${sniffed.method === 'forced' ? '（强制）' : ''}`,
            verify: `size=${result.size}，CRC32=${formatCrc(result.crc)} 一致`,
            note: finalName === plan.extractName ? '' : '目标同名，已加后缀',
          });
        } catch (error) {
          applied.extractionFailures++;
          failures.push({ original: plan.original, reason: `解压失败：${error.message}` });
        }
      }
    } else if (dryRun) {
      for (const plan of plans.slice(0, 5000)) {
        if (plan.extractName === null) continue;
        rows.push({
          action: plan.extractName.endsWith('/') ? '解压目录（计划）' : '解压（计划）',
          original: plan.original,
          fixed: plan.extractName,
          basis: `${sniffed.encoding}${sniffed.method === 'forced' ? '（强制）' : ''}`,
          verify: 'dry-run 未执行',
          note: plan.extractName.endsWith('/') ? '' : '将逐条校验 CRC32',
        });
      }
      if (buildFixedZip) {
        const stem = path.basename(zipPath).replace(/\.zip$/i, '');
        rows.unshift({
          action: '生成修复版 ZIP（计划）',
          original: path.basename(zipPath),
          fixed: `${stem}-文件名已修复.zip`,
          basis: '全部条目置位 UTF-8 标志 0x0800 + UTF-8 文件名',
          verify: 'dry-run 未执行',
          note: '将逐条重新压缩并回读自检',
        });
      }
    }

    if (!dryRun && buildFixedZip) {
      const stem = path.basename(zipPath).replace(/\.zip$/i, '');
      const desired = `${stem}-文件名已修复.zip`;
      const resolvedDest = await uniqueNestedPath(outDir, desired, { suffix: '_fixed' });
      const destPath = resolvedDest.target;
      const fixedZipName = resolvedDest.relative;
      const totalUncompressed = catalog.entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
      try {
        await writeFixedZip({
          sourceCatalog: catalog,
          destPath,
          plans: plans.map((plan) => ({ entry: plan.entry, name: plan.fixedName })),
          signal,
        });
        const verification = await verifyFixedZip(destPath, {
          full: totalUncompressed <= 512 * 1024 * 1024,
          signal,
        });
        applied.fixedZipPath = destPath;
        applied.fixedZip = verification;
        rows.push({
          action: '生成修复版 ZIP',
          original: path.basename(zipPath),
          fixed: fixedZipName,
          basis: '全部条目置位 UTF-8 标志 0x0800 + UTF-8 文件名',
          verify: `回读 ${verification.entries} 条目，UTF-8 标志 ${verification.allUtf8Flag ? '全部置位' : '有缺失'}，${verification.fullChecked ? '逐条 CRC32 校验通过' : '结构校验通过（体积较大，跳过全量解压校验）'}`,
          note: '',
        });
      } catch (error) {
        failures.push({ original: `${path.basename(zipPath)} → 修复版 ZIP`, reason: `生成失败：${error.message}` });
      }
    }

    const generatedAt = startedAt.toISOString();
    const report = buildReport({
      title: 'ZIP 中文文件名修复报告（压缩包）',
      generatedAt,
      meta: [
        { label: 'ZIP', value: zipPath },
        { label: 'ZIP 大小', value: `${stat.size} 字节` },
        { label: '条目名编码', value: `${sniffed.encoding ?? '未知'}（${sniffed.method}，置信度 ${sniffed.confidence}）` },
        { label: '输出目录', value: outDir },
        { label: '模式', value: dryRun ? 'dry-run（只报告，未改动任何文件）' : '解压/重建' },
      ],
      summary: [
        { label: '条目总数', value: catalog.entries.length },
        { label: '文件 / 目录', value: `${fileCount} / ${dirCount}` },
        { label: '非 ASCII 条目', value: sniffed.nonAsciiEntries },
        { label: '可逆还原', value: forms.reversibleA + forms.reversibleA2 },
        { label: '含 U+FFFD（不可逆）', value: forms.irreversible },
        { label: '剥离冗余顶层目录', value: rootPrefix === '' ? '无' : rootPrefix.slice(0, -1) },
        { label: '判定', value: status },
      ],
      rows: rows.slice(0, 5000),
      failures,
      notes: [
        `编码评分：${Object.entries(sniffed.scores).map(([key, value]) => `${key}=${value}`).join('，') || '（无）'}`,
        '修复版 ZIP 显式置位通用位 bit 11（0x0800）并用 UTF-8 写文件名，Windows 资源管理器 / 7-Zip 无需参数即可正确显示。',
        ...sniffed.warnings,
        ...(irreversible.length > 0
          ? ['检测到 U+FFFD：字节已被替换字符覆盖，压缩包内无法还原。请保留源文件，使用 zipfix_match_source 或 zipfix_verify_names。']
          : []),
      ],
    });

    if (!dryRun) {
      applied.report = await writeReportFiles(reportsDirectory(outDir), 'fix-zip', report);
    }

    const forcedNoFix = status === 'no-fix-needed' && force && !dryRun;
    const statusText =
      status === 'no-fix-needed'
        ? forcedNoFix
          ? '文件名编码已合规，已按 force:true 强制处理'
          : '文件名编码已合规，无需修复'
        : status === 'flag-missing-utf8'
          ? '名字本身是 UTF-8，但缺少 0x0800 标志位，重建 ZIP 即可'
          : status === 'unknown'
            ? '无法识别编码，建议指定 encoding 或人工处理'
            : status === 'mixed'
              ? `部分条目可逆还原，另有 ${forms.irreversible} 个条目含 U+FFFD 不可逆`
              : '检测到 GBK/GB18030/Big5 文件名，可无损还原';

    return {
      ok: true,
      kind: 'zip',
      zipPath,
      zipSize: stat.size,
      outputDir: outDir,
      dryRun,
      encoding: sniffed.encoding,
      method: sniffed.method,
      confidence: sniffed.confidence,
      scores: sniffed.scores,
      status,
      entries: entriesSummary,
      forms,
      stripRoot: rootPrefix,
      applied,
      rows: rows.slice(0, 50),
      failures: failures.slice(0, 50),
      irreversible: irreversible.slice(0, 50),
      warnings: sniffed.warnings.slice(0, 20),
      forced: forcedNoFix,
      generatedAt,
      summary: `${statusText}。${dryRun ? 'dry-run：未改动任何文件。' : `已解压 ${applied.extractedFiles} 个文件 / ${applied.extractedDirectories} 个目录，失败 ${applied.extractionFailures} 个。${applied.fixedZipPath ? '已生成修复版 ZIP。' : ''}`}`,
    };
  } finally {
    catalog.close();
  }
}

/* ------------------------------------------------------------------ *
 * ALG-7：内容反推 + 指纹验证
 * ------------------------------------------------------------------ */

/**
 * 编码指纹：候选名按 GBK 编码后再按 UTF-8 替换解码。
 * 与交接文档 verify_candidate 的 Python 实现一致（已实测 U+FFFD 语义相同）。
 * @param {string} candidate 候选正确名字
 * @returns {string} 指纹；候选含 GBK 不可编码字符时抛错
 */
export function fingerprint(candidate) {
  return decodeUtf8Replacement(encodeText(candidate, 'gbk'));
}

/** 把连续 U+FFFD 折叠成单个，用于宽松比对（不同读取器的替换粒度可能不同）。 */
export function normalizeFffdRuns(text) {
  return text.replace(/\uFFFD+/g, '\uFFFD');
}

/**
 * 验证一个候选名是否就是「产生当前乱码」的原始名字。
 * @param {string} candidate 候选正确名字
 * @param {string} actualMojibake 当前乱码名字
 * @returns {{candidate: string, match: 'exact'|'normalized'|'none'|'unencodable', fingerprint: string|null}}
 */
export function verifyCandidateName(candidate, actualMojibake) {
  let fp;
  try {
    fp = fingerprint(candidate);
  } catch (error) {
    return { candidate, match: 'unencodable', fingerprint: null, reason: error.message };
  }
  if (fp === actualMojibake) return { candidate, match: 'exact', fingerprint: fp };
  if (normalizeFffdRuns(fp) === normalizeFffdRuns(actualMojibake)) {
    return { candidate, match: 'normalized', fingerprint: fp };
  }
  return { candidate, match: 'none', fingerprint: fp };
}

const XML_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

function decodeXmlEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES.get(body) ?? match;
  });
}

function uniqueNonEmpty(texts) {
  const seen = new Set();
  const out = [];
  for (const raw of texts) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= 30) break;
  }
  return out;
}

function extractOoxmlParts(catalog, partPaths) {
  const results = [];
  for (const partPath of partPaths) {
    const entry = catalog.entries.find(
      (item) => item.nameBytes.toString('latin1') === partPath || item.nameBytes.toString('utf8') === partPath,
    );
    if (entry === undefined) continue;
    try {
      results.push({ partPath, xml: catalog.readEntryBuffer(entry, { maxBytes: 16 * 1024 * 1024 }).toString('utf8') });
    } catch {
      /* 单个部件损坏不影响整体 */
    }
  }
  return results;
}

/**
 * 从文档内部抽取「标题类」候选文本（ALG-7 Step 1）。
 * 支持 .docx / .xlsx / .pptx（OOXML）与 .pdf（启发式）。
 * @param {string} filePath 文件路径
 * @returns {Promise<{kind: string, titles: string[], sources: string[], warnings: string[]}>}
 */
export async function extractDocumentTitles(filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error(`不是文件：${filePath}`);
  const ext = path.extname(filePath).toLowerCase();
  const warnings = [];
  const titles = [];
  const sources = [];

  if (ext === '.pdf') {
    const handle = await fsp.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, 262144));
      await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.toString('latin1');
      const matches = [...text.matchAll(/\/Title\s*\(((?:\\.|[^()\\])*)\)/g)];
      for (const match of matches.slice(0, 10)) {
        const value = match[1].replace(/\\([()\\])/g, '$1').trim();
        if (value.length > 0) {
          titles.push(value);
          sources.push('/Info /Title');
        }
      }
      if (titles.length === 0) warnings.push('PDF 未找到 /Title 元数据（可能需要专用解析器）');
    } finally {
      await handle.close();
    }
    return { kind: 'pdf', titles: uniqueNonEmpty(titles), sources: [...new Set(sources)], warnings };
  }

  if (ext !== '.docx' && ext !== '.xlsx' && ext !== '.pptx') {
    throw new Error(`不支持的内容反推格式：${ext || '(无扩展名)'}（支持 .docx/.xlsx/.pptx/.pdf）`);
  }

  const catalog = openZipCatalog(filePath);
  try {
    const appParts = extractOoxmlParts(catalog, ['docProps/app.xml']);
    for (const { xml } of appParts) {
      const block = xml.match(/<TitlesOfParts>([\s\S]*?)<\/TitlesOfParts>/);
      if (block) {
        const parts = [...block[1].matchAll(/<vt:lpstr>([\s\S]*?)<\/vt:lpstr>/g)].map((m) => decodeXmlEntities(m[1]));
        for (const part of parts) {
          titles.push(part);
          sources.push('docProps/app.xml <TitlesOfParts>');
        }
      }
    }
    const coreParts = extractOoxmlParts(catalog, ['docProps/core.xml']);
    for (const { xml } of coreParts) {
      const title = xml.match(/<dc:title>([\s\S]*?)<\/dc:title>/);
      if (title) {
        titles.push(decodeXmlEntities(title[1]));
        sources.push('docProps/core.xml <dc:title>');
      }
    }
    if (ext === '.docx') {
      const docParts = extractOoxmlParts(catalog, ['word/document.xml']);
      for (const { xml } of docParts) {
        const paragraphs = xml
          .replace(/<\/w:p>/g, '\n')
          .split('\n')
          .map((chunk) => decodeXmlEntities(chunk.replace(/<[^>]+>/g, '')).trim())
          .filter((text) => text.length > 0);
        for (const paragraph of paragraphs.slice(0, 40)) {
          titles.push(paragraph);
          sources.push('word/document.xml 正文');
        }
      }
    }
    if (ext === '.xlsx') {
      const sharedParts = extractOoxmlParts(catalog, ['xl/sharedStrings.xml']);
      for (const { xml } of sharedParts) {
        const items = [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
          .map((match) => decodeXmlEntities(match[1]))
          .filter((text) => text.trim().length > 0);
        for (const item of items.slice(0, 40)) {
          titles.push(item);
          sources.push('xl/sharedStrings.xml');
        }
      }
    }
    if (ext === '.pptx') {
      const slideParts = catalog.entries
        .map((entry) => entry.nameBytes.toString('utf8'))
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .slice(0, 10);
      for (const slide of slideParts) {
        const parts = extractOoxmlParts(catalog, [slide]);
        for (const { xml } of parts) {
          const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXmlEntities(match[1]));
          if (texts.length > 0) {
            titles.push(texts[0]);
            sources.push(slide);
          }
        }
      }
    }
    return {
      kind: ext.slice(1),
      titles: uniqueNonEmpty(titles),
      sources: [...new Set(sources)],
      warnings,
    };
  } finally {
    catalog.close();
  }
}

/**
 * ALG-7：抽取文档标题 → 生成候选名 → 指纹验证。只输出「已验证」或「待确认」，不改名。
 * @param {object} options
 * @param {string} options.mojibakeName 当前乱码名字（含 U+FFFD 也可）
 * @param {string[]} [options.candidates] 显式候选名
 * @param {string} [options.documentPath] 文档路径（自动抽取标题生成候选）
 * @returns {Promise<object>}
 */
export async function verifyNames({ mojibakeName, candidates = [], documentPath }) {
  const extMatch = mojibakeName.match(/(\.[A-Za-z0-9]{1,8})$/);
  const ext = extMatch ? extMatch[1] : '';
  const stem = ext ? mojibakeName.slice(0, -ext.length) : mojibakeName;
  const generated = [];
  const warnings = [];
  let extraction;

  if (documentPath) {
    extraction = await extractDocumentTitles(documentPath);
    warnings.push(...extraction.warnings);
    for (const title of extraction.titles) {
      const sanitized = sanitizeSegment(title);
      if (sanitized.length === 0) continue;
      generated.push(`${sanitized}${ext}`);
      // 常见前缀变体：附件序号 / 书名号 / 去空格
      generated.push(`${sanitized.replace(/\s+/g, '')}${ext}`);
      for (const prefix of ['附件1：', '附件2：', '附件1-', '附件2-']) generated.push(`${prefix}${sanitized}${ext}`);
      if (title.includes('“') || title.includes('”')) {
        const centered = title.replace(/[“”]/g, '').trim();
        if (centered !== title) generated.push(`${centered}${ext}`);
      }
    }
  }

  const pool = [...new Set([...candidates, ...generated])].filter((item) => item.trim().length > 0);
  const results = pool.map((candidate) => verifyCandidateName(candidate, mojibakeName));
  const verified = results.filter((item) => item.match === 'exact' || item.match === 'normalized');
  return {
    ok: true,
    mojibakeName,
    mojibakeLength: [...stem].length,
    fffdCount: countFffd(mojibakeName),
    extension: ext,
    document: extraction
      ? { kind: extraction.kind, titles: extraction.titles.slice(0, 30), sources: extraction.sources, warnings: extraction.warnings }
      : null,
    candidates: results,
    verified,
    warnings: [
      ...warnings,
      ...(verified.length === 0
        ? ['没有任何候选通过指纹验证：请补充候选名，或改用源包 CRC 配对（zipfix_match_source）。']
        : []),
    ],
    summary:
      verified.length > 0
        ? `已验证 ${verified.length} 个候选名与乱码指纹完全吻合（可安全改名）。`
        : `候选 ${results.length} 个，无一通过指纹验证；不得擅自改名。`,
  };
}

export { classifyName, tryReverseName, suspicionMarkers, crc32 };
