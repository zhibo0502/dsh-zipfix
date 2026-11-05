/**
 * dsh-zipfix：ZIP 中文文件名乱码修复器的 Host 插件入口。
 *
 * 在 tools 服务上注册 5 个 agent 可调用工具：
 * - zipfix_scan          分类与体检（只读）
 * - zipfix_fix_zip       按正确编码解压 + 生成置位 UTF-8 标志的修复版 ZIP
 * - zipfix_rename_dir    已解压目录形态 A 批量改名（cp437/latin1 → GBK）
 * - zipfix_match_source  形态 B（U+FFFD）按 (size, CRC32) 与源包精确配对
 * - zipfix_verify_names  内容反推 + 编码指纹验证
 *
 * 设计约束：零第三方依赖（只用 Node 标准库），不删除/不覆盖任何源文件，
 * 所有写操作默认 dry-run，需显式传 dryRun=false 才落盘。
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { REPORTS_DIR_NAME, fixZipArchive, matchSource, renameDirectory, verifyNames } from './lib/fix.js';
import { classifyName } from './lib/detect.js';
import { displayWidth } from './lib/encoding.js';

export const name = 'dsh-zipfix';
export const inject = ['tools'];

/* ------------------------------------------------------------------ *
 * 工具输出辅助
 * ------------------------------------------------------------------ */

const MAX_TEXT = 6000;

function truncate(text, width) {
  const value = String(text ?? '');
  if (displayWidth(value) <= width) return value;
  let out = '';
  let used = 0;
  for (const ch of value) {
    const w = displayWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

function textContent(lines) {
  let text = lines.filter((line) => line !== undefined && line !== null && line !== '').join('\n');
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n…（输出已截断）`;
  return [{ type: 'text', text }];
}

function rowLines(rows, limit = 8) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const lines = ['', '示例：'];
  for (const row of rows.slice(0, limit)) {
    const original = truncate(row.original ?? '', 44);
    const fixed = truncate(row.fixed ?? '', 44);
    const verify = row.verify ? `｜${truncate(row.verify, 40)}` : '';
    lines.push(`  ${original} → ${fixed}${verify}`);
  }
  return lines;
}

function failureLines(failures, limit = 5) {
  if (!Array.isArray(failures) || failures.length === 0) return [];
  const lines = ['', '失败 / 待人工：'];
  for (const failure of failures.slice(0, limit)) {
    lines.push(`  ${truncate(failure.original ?? failure.path ?? '', 44)}：${truncate(failure.reason ?? '', 80)}`);
  }
  if (failures.length > limit) lines.push(`  …另有 ${failures.length - limit} 条，见报告`);
  return lines;
}

/**
 * 工具输出 schema：只强制校验 ok/summary 两个字段。
 * 其余字段随工具语义自由扩展（additionalProperties: true），
 * 避免为每个工具维护一份容易与实现漂移的完整 schema。
 */
function outputSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
    },
    required: ['ok', 'summary'],
  };
}

function defineTool({ name: toolName, description, parameters, schema, timeoutMs, execute, render }) {
  return {
    name: toolName,
    description,
    parameters,
    output: { schema, render },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    execute,
  };
}

/* ------------------------------------------------------------------ *
 * 路径解析：相对路径按当前会话的工作目录展开
 * ------------------------------------------------------------------ */

function createPathResolver(ctx) {
  return async function resolvePath(input, exec) {
    const raw = String(input ?? '').trim();
    if (raw.length === 0) throw new Error('路径不能为空');
    if (path.isAbsolute(raw)) return path.normalize(raw);
    let base = process.cwd();
    const directories = ctx.get('workingDirectory');
    if (exec?.agent && directories !== undefined) {
      try {
        base = await directories.ensure(exec.agent, exec.signal);
      } catch {
        base = process.cwd();
      }
    }
    return path.resolve(base, raw);
  };
}

/* ------------------------------------------------------------------ *
 * 只读扫描
 * ------------------------------------------------------------------ */

async function scanDirectory(root, { limit = 30 } = {}) {
  const forms = { ascii: 0, clean: 0, reversibleA: 0, reversibleA2: 0, irreversible: 0, double: 0, unknown: 0 };
  const reversible = [];
  const irreversible = [];
  const unknown = [];
  const doubleDamaged = [];
  let scanned = 0;

  async function walk(current) {
    const children = await fsp.readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (child.isDirectory() && child.name === REPORTS_DIR_NAME) continue; // 跳过本插件报告目录
      if (child.isFile() && /^zipfix-(?:fix-zip|rename-dir|match-source)-/.test(child.name)) continue;
      scanned++;
      const classified = classifyName(child.name);
      forms[classified.form === 'A' ? 'reversibleA' : classified.form === 'A2' ? 'reversibleA2' : classified.form]++;
      const display = path.join(path.relative(root, current), child.name).replace(/\\/g, '/');
      if (classified.form === 'A' || classified.form === 'A2') {
        if (reversible.length < limit) {
          reversible.push({ original: display, fixed: classified.fixed, basis: classified.chain });
        }
      } else if (classified.form === 'irreversible') {
        if (irreversible.length < limit) {
          irreversible.push({ original: display, fffd: classified.fffd ?? 0, fixed: null, basis: '含 U+FFFD，字节已销毁' });
        }
      } else if (classified.form === 'double') {
        if (doubleDamaged.length < limit) {
          doubleDamaged.push({ original: display, fffd: 0, fixed: null, basis: '二次损坏（锟斤拷型）' });
        }
      } else if (classified.form === 'unknown') {
        if (unknown.length < limit) unknown.push({ original: display, fixed: null, basis: '无法自动识别编码' });
      }
      if (child.isDirectory()) await walk(path.join(current, child.name));
    }
  }

  await walk(root);

  const total = forms.ascii + forms.clean + forms.reversibleA + forms.reversibleA2 + forms.irreversible + forms.double + forms.unknown;
  const verdict =
    forms.irreversible + forms.double > 0
      ? forms.reversibleA + forms.reversibleA2 > 0
        ? 'mixed'
        : 'irreversible'
      : forms.reversibleA + forms.reversibleA2 > 0
        ? 'reversible'
        : forms.unknown > 0
          ? 'unknown'
          : 'no-fix-needed';

  const nextSteps = [];
  if (forms.reversibleA + forms.reversibleA2 > 0) {
    nextSteps.push('可用 zipfix_rename_dir（先 dryRun=true 预览，再 dryRun=false 执行）无损批量改名。');
  }
  if (forms.irreversible + forms.double > 0) {
    nextSteps.push('含 U+FFFD 的名字不可逆：若源 ZIP 还在，用 zipfix_match_source 按 (size, CRC32) 精确配对还原。');
    nextSteps.push('无源包时用 zipfix_verify_names 从文档内部标题生成候选名并做编码指纹验证，只改「已验证」的名字。');
  }
  if (forms.unknown > 0) nextSteps.push('无法识别的名字请人工确认编码（可能为 Big5/Shift-JIS，可显式指定 encoding 重试）。');
  if (nextSteps.length === 0) nextSteps.push('目录内文件名编码正常，无需处理。');

  return {
    ok: true,
    kind: 'directory',
    path: root,
    verdict,
    scanning: '仅读取文件名，未读取文件内容，也未改动任何文件',
    forms,
    total,
    scanned,
    samples: [...reversible, ...irreversible, ...doubleDamaged, ...unknown].slice(0, limit),
    nextSteps,
    warnings: [],
    summary:
      verdict === 'no-fix-needed'
        ? `扫描 ${scanned} 项：文件名编码正常，无需修复`
        : verdict === 'reversible'
          ? `扫描 ${scanned} 项：${forms.reversibleA + forms.reversibleA2} 项可无损还原（形态 A）`
          : verdict === 'irreversible'
            ? `扫描 ${scanned} 项：${forms.irreversible + forms.double} 项字节已销毁（U+FFFD），需源包或内容反推`
            : verdict === 'mixed'
              ? `扫描 ${scanned} 项：${forms.reversibleA + forms.reversibleA2} 项可无损还原，${forms.irreversible + forms.double} 项不可逆`
              : `扫描 ${scanned} 项：${forms.unknown} 项无法自动识别编码`,
  };
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

/**
 * @param {object} ctx Cordis 插件上下文（inject: tools）
 */
export function apply(ctx) {
  const resolvePath = createPathResolver(ctx);

  /* ---------------- zipfix_scan ---------------- */
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'zipfix_scan',
        description:
          '诊断 ZIP 压缩包或已解压目录的中文文件名乱码（只读，不改任何文件）。' +
          '对 ZIP：读取中央目录原始文件名字节，按 utf-8/gbk/gb18030/big5 严格解码打分，给出编码判定、置信度、每个条目的修正后名字与「可逆/不可逆」结论。' +
          '对目录：递归分类文件名形态（A=CP437/Latin-1 误解码可无损反解；B=含 U+FFFD 字节已销毁不可逆；二次损坏等）。' +
          '修复任何文件前先调用本工具确认形态。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: {
              type: 'string',
              description: 'ZIP 文件或已解压目录的路径；相对路径按当前会话工作目录解析。',
            },
            encoding: {
              type: 'string',
              enum: ['auto', 'utf-8', 'gbk', 'gb18030', 'big5'],
              description: '强制指定 ZIP 条目名编码，默认 auto（嗅探）。嗅探置信度低时用它覆盖。',
            },
            limit: {
              type: 'integer',
              description: '样例条目上限，默认 30。',
            },
          },
          required: ['path'],
        },
        schema: outputSchema(),
        timeoutMs: 300000,
        async execute(args, exec) {
          const target = await resolvePath(args.path, exec);
          let stat;
          try {
            stat = await fsp.stat(target);
          } catch (error) {
            throw new Error(`路径不存在或无法访问：${target}（${error.message}）`);
          }
          const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 30;
          if (stat.isDirectory()) {
            const result = await scanDirectory(target, { limit });
            return { ...result, nextSteps: result.nextSteps.slice(0, 10) };
          }
          const result = await fixZipArchive({
            zipPath: target,
            encoding: args.encoding,
            extract: false,
            buildFixedZip: false,
            dryRun: true,
            signal: exec.signal,
          });
          const nextSteps = [];
          if (result.status === 'reversible' || result.status === 'mixed') {
            nextSteps.push('可用 zipfix_fix_zip（先 dryRun=true 预览）按正确文件名解压，并生成置位 UTF-8 标志的修复版 ZIP。');
          }
          if (result.status === 'flag-missing-utf8') {
            nextSteps.push('名字本身是 UTF-8，只是缺少 0x0800 标志位：用 zipfix_fix_zip 并设 buildFixedZip=true 重建即可。');
          }
          if (result.irreversible.length > 0) {
            nextSteps.push('压缩包内有条目名含 U+FFFD（信息已丢失），无法从包内还原。');
          }
          if (result.status === 'unknown') {
            nextSteps.push('编码无法识别：请显式指定 encoding（如 big5 / gb18030）后重试。');
          }
          if (nextSteps.length === 0) nextSteps.push('文件名编码已合规，无需修复。');
          // ZIP 视角的形态统计：条目是否需要按选中编码重新解码
          const reversible = result.encoding !== 'utf-8' && result.encoding !== 'ascii'
            ? result.entries.nonAscii - result.irreversible.length
            : 0;
          return {
            ok: true,
            kind: 'zip',
            path: target,
            zipSize: result.zipSize,
            verdict: result.status,
            encoding: result.encoding,
            method: result.method,
            confidence: result.confidence,
            scores: result.scores,
            entries: result.entries,
            forms: {
              reversible: Math.max(0, reversible),
              irreversible: result.irreversible.length,
              ascii: result.entries.total - result.entries.nonAscii,
              alreadyUtf8: result.entries.declaredUtf8,
            },
            stripRoot: result.stripRoot,
            samples: result.rows.slice(0, limit),
            irreversible: result.irreversible.slice(0, limit),
            failures: result.failures.slice(0, limit),
            nextSteps,
            warnings: result.warnings,
            summary: result.summary,
          };
        },
        render(args, value) {
          const lines = [`【ZIP 文件名体检】${value.summary}`, `路径：${value.path}`];
          if (value.kind === 'zip') {
            lines.push(
              `编码：${value.encoding ?? '未知'}（${value.method}，置信度 ${value.confidence}）｜条目 ${value.entries.total}（文件 ${value.entries.files} / 目录 ${value.entries.directories}）`,
            );
            if (value.stripRoot) lines.push(`冗余顶层目录：${value.stripRoot}`);
            lines.push(
              `形态：可逆=${value.forms.reversible}｜U+FFFD=${value.forms.irreversible}｜ASCII=${value.forms.ascii}｜已声明 UTF-8=${value.forms.alreadyUtf8}`,
            );
          } else {
            lines.push(
              `形态：可逆 A=${value.forms.reversibleA} A2=${value.forms.reversibleA2}｜U+FFFD=${value.forms.irreversible}｜二次损坏=${value.forms.double}｜正常=${value.forms.clean + value.forms.ascii}｜未知=${value.forms.unknown}`,
            );
          }
          lines.push(...rowLines(value.samples));
          lines.push(...failureLines(value.failures));
          if (value.nextSteps?.length) {
            lines.push('', '下一步：');
            for (const step of value.nextSteps) lines.push(`  • ${step}`);
          }
          return textContent(lines);
        },
      }),
    ),
  );

  /* ---------------- zipfix_fix_zip ---------------- */
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'zipfix_fix_zip',
        description:
          '按嗅探/指定的编码解码 ZIP 条目名，把内容无损解压成正确中文名，并可生成「修复版 ZIP」（全部条目置位 UTF-8 文件名标志 0x0800，Windows 资源管理器/7-Zip 直接正常显示）。' +
          '逐条校验解压后大小与 CRC32；永不删除源 ZIP、永不覆盖已有文件（重名自动加 _fixed 后缀）。默认 dryRun=true 只返回计划；确认后传 dryRun=false 才落盘。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            zipPath: { type: 'string', description: '待修复 ZIP 的路径。' },
            outputDir: {
              type: 'string',
              description: '输出目录，默认与源 ZIP 同级目录。',
            },
            encoding: {
              type: 'string',
              enum: ['auto', 'utf-8', 'gbk', 'gb18030', 'big5'],
              description: '强制指定条目名编码，默认 auto 嗅探。',
            },
            extract: { type: 'boolean', description: '是否按正确文件名解压，默认 true。' },
            buildFixedZip: { type: 'boolean', description: '是否额外生成修复版 ZIP（置位 0x0800），默认 false。' },
            stripRoot: {
              type: 'boolean',
              description: '是否剥离与 ZIP 同名的冗余顶层目录，默认 true。',
            },
            dryRun: { type: 'boolean', description: '默认 true：只出计划与报告，不改动任何文件；确认后传 false 执行。' },
            force: {
              type: 'boolean',
              description: '默认 false：判定「无需修复」时直接返回、不产生任何改动；传 true 才会强制解压/重建。',
            },
          },
          required: ['zipPath'],
        },
        schema: outputSchema(),
        timeoutMs: 900000,
        async execute(args, exec) {
          const zipPath = await resolvePath(args.zipPath, exec);
          const outputDir = args.outputDir === undefined ? undefined : await resolvePath(args.outputDir, exec);
          const result = await fixZipArchive({
            zipPath,
            outputDir,
            encoding: args.encoding,
            extract: args.extract !== false,
            buildFixedZip: args.buildFixedZip === true,
            stripRoot: args.stripRoot !== false,
            dryRun: args.dryRun !== false,
            force: args.force === true,
            signal: exec.signal,
          });
          const nextSteps = [];
          if (result.status === 'no-fix-needed') {
            if (result.forced === true) {
              nextSteps.push('已按 force:true 强制处理完毕（源文件未删除、未覆盖）；如需对比原始结构请以源 ZIP 为准。');
            } else {
              nextSteps.push('文件名编码已合规，无需处理；如需强制解压/重建，请显式传 force:true。');
            }
          } else if (result.dryRun) {
            nextSteps.push('确认计划无误后，用相同参数并设 dryRun=false 执行落盘。');
          }
          if (result.applied?.fixedZipPath) {
            nextSteps.push(`修复版 ZIP 已生成：${result.applied.fixedZipPath}（可直接转发，对方不会乱码）。`);
          }
          if (result.irreversible.length > 0) {
            nextSteps.push('存在 U+FFFD 条目：包内无法还原，如有源包请用 zipfix_match_source 配对。');
          }
          if (result.applied?.report) nextSteps.push(`审计报告：${result.applied.report.markdownPath}`);
          if (nextSteps.length === 0) nextSteps.push('无需进一步操作。');
          return { ...result, nextSteps };
        },
        render(args, value) {
          const lines = [`【ZIP 文件名修复】${value.summary}`, `ZIP：${value.zipPath}`];
          lines.push(`判定：${value.status ?? value.verdict ?? '未知'}｜编码：${value.encoding ?? '未知'}（${value.method}，置信度 ${value.confidence}）`);
          if (value.dryRun) lines.push('模式：dry-run（未改动任何文件）');
          else {
            lines.push(
              `已解压：${value.applied.extractedFiles} 个文件 / ${value.applied.extractedDirectories} 个目录；失败 ${value.applied.extractionFailures} 个`,
            );
            if (value.applied.fixedZipPath) {
              const verification = value.applied.fixedZip;
              lines.push(
                `修复版 ZIP：${value.applied.fixedZipPath}（回读 ${verification.entries} 条目，UTF-8 标志 ${verification.allUtf8Flag ? '全部置位' : '有缺失'}，${verification.fullChecked ? 'CRC32 全量校验通过' : '结构校验通过'}）`,
              );
            }
            if (value.applied.report) lines.push(`报告：${value.applied.report.markdownPath}`);
          }
          lines.push(...rowLines(value.rows, 6));
          lines.push(...failureLines(value.failures, 4));
          if (value.nextSteps?.length) {
            lines.push('', '下一步：');
            for (const step of value.nextSteps) lines.push(`  • ${step}`);
          }
          return textContent(lines);
        },
      }),
    ),
  );

  /* ---------------- zipfix_rename_dir ---------------- */
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'zipfix_rename_dir',
        description:
          '批量修复「已经解压坏」的目录里的文件名（形态 A：CP437 框线字符 / Latin-1 高位字符误解码）。' +
          '自底向上改名，源码串.encode(cp437|latin-1).decode(gbk) 无损还原；含 U+FFFD 的名字不猜、列入待人工。' +
          '永不覆盖同名文件；默认 dryRun=true 只出计划。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            root: { type: 'string', description: '已解压目录路径。' },
            dryRun: { type: 'boolean', description: '默认 true：只出计划；确认后传 false 执行改名。' },
            recursive: { type: 'boolean', description: '是否递归子目录，默认 true。' },
            verifyHashes: {
              type: 'boolean',
              description: '改名前后是否计算并复核 SHA-256（大目录会慢），默认 false（仅复核 size）。',
            },
          },
          required: ['root'],
        },
        schema: outputSchema(),
        timeoutMs: 900000,
        async execute(args, exec) {
          const root = await resolvePath(args.root, exec);
          const result = await renameDirectory({
            root,
            dryRun: args.dryRun !== false,
            recursive: args.recursive !== false,
            verifyHashes: args.verifyHashes === true,
            signal: exec.signal,
          });
          const nextSteps = [];
          if (result.dryRun && result.stats.planned > 0) nextSteps.push('确认计划后，用相同参数并设 dryRun=false 执行改名。');
          if (result.failures.length > 0) {
            nextSteps.push('含 U+FFFD 或无法识别的名字未改动：若有源 ZIP，用 zipfix_match_source 精确配对还原。');
          }
          if (result.report) nextSteps.push(`审计报告：${result.report.markdownPath}`);
          return { ...result, nextSteps };
        },
        render(args, value) {
          const lines = [`【目录文件名修复】${value.summary}`, `目录：${value.root}`];
          if (value.dryRun) lines.push('模式：dry-run（未改动任何文件）');
          lines.push(`扫描 ${value.stats.scanned} 项：可还原 ${value.stats.planned}，已改名 ${value.stats.renamed}，失败 ${value.stats.failed}，无法识别 ${value.stats.skipped}`);
          lines.push(...rowLines(value.rows, 8));
          lines.push(...failureLines(value.failures, 4));
          if (value.nextSteps?.length) {
            lines.push('', '下一步：');
            for (const step of value.nextSteps) lines.push(`  • ${step}`);
          }
          return textContent(lines);
        },
      }),
    ),
  );

  /* ---------------- zipfix_match_source ---------------- */
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'zipfix_match_source',
        description:
          '形态 B（文件名含 U+FFFD、字节已销毁）的最优修复路径：用源 ZIP 中央目录的 (解压后大小, CRC32) 与磁盘文件内容精确配对，唯一命中才改名，0 个或多个命中一律不猜。' +
          '改名前后记录并复核 SHA-256，内容零改动；默认 dryRun=true。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            directory: { type: 'string', description: '受损文件所在目录（可递归）。' },
            sourceZip: { type: 'string', description: '源 ZIP 路径（原始压缩包）。' },
            encoding: {
              type: 'string',
              enum: ['auto', 'utf-8', 'gbk', 'gb18030', 'big5'],
              description: '源 ZIP 条目名编码，默认 auto 嗅探。',
            },
            dryRun: { type: 'boolean', description: '默认 true：只出配对计划；确认后传 false 执行改名。' },
            recursive: { type: 'boolean', description: '是否递归子目录，默认 true。' },
          },
          required: ['directory', 'sourceZip'],
        },
        schema: outputSchema(),
        timeoutMs: 900000,
        async execute(args, exec) {
          const directory = await resolvePath(args.directory, exec);
          const sourceZip = await resolvePath(args.sourceZip, exec);
          const result = await matchSource({
            directory,
            sourceZip,
            encoding: args.encoding,
            dryRun: args.dryRun !== false,
            recursive: args.recursive !== false,
            signal: exec.signal,
          });
          const nextSteps = [];
          if (result.dryRun && result.stats.matched > 0) {
            nextSteps.push('确认配对结果后，用相同参数并设 dryRun=false 执行改名。');
          }
          if (result.stats.unmatched > 0) {
            nextSteps.push('未配对文件在源 ZIP 中没有 (size, CRC32) 相同的条目，需人工确认或改用 zipfix_verify_names。');
          }
          if (result.report) nextSteps.push(`审计报告：${result.report.markdownPath}`);
          return { ...result, nextSteps };
        },
        render(args, value) {
          const lines = [`【源包 CRC 配对】${value.summary}`, `目录：${value.directory}`, `源 ZIP：${value.sourceZip}（条目名编码 ${value.sourceEncoding ?? '未知'}）`];
          if (value.dryRun) lines.push('模式：dry-run（未改动任何文件）');
          lines.push(`扫描 ${value.stats.scanned} 个文件：唯一配对 ${value.stats.matched}，已改名 ${value.stats.renamed}，未配对 ${value.stats.unmatched}，待人工 ${value.stats.failed}`);
          lines.push(...rowLines(value.rows, 8));
          lines.push(...failureLines(value.failures, 4));
          if (value.nextSteps?.length) {
            lines.push('', '下一步：');
            for (const step of value.nextSteps) lines.push(`  • ${step}`);
          }
          return textContent(lines);
        },
      }),
    ),
  );

  /* ---------------- zipfix_verify_names ---------------- */
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'zipfix_verify_names',
        description:
          '形态 B 兜底：内容反推 + 编码指纹验证，不猜名字、不改文件。' +
          '给定当前乱码名与候选正确名，计算「候选名按 GBK 编码后再按 UTF-8 替换解码」的指纹，与乱码名逐字符比对：完全相等才算已验证。' +
          '可选 documentPath 自动从 .docx/.xlsx/.pptx/.pdf 内部抽取标题生成候选名（交接文档 ALG-7）。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mojibakeName: { type: 'string', description: '当前磁盘上的乱码文件名（含 U+FFFD 也可以）。' },
            candidates: {
              type: 'array',
              items: { type: 'string' },
              description: '候选正确文件名列表（可带扩展名）。',
            },
            documentPath: {
              type: 'string',
              description: '对应的文档文件路径，用于自动抽取标题生成候选名（.docx/.xlsx/.pptx/.pdf）。',
            },
          },
          required: ['mojibakeName'],
        },
        schema: outputSchema(),
        timeoutMs: 300000,
        async execute(args, exec) {
          const documentPath =
            args.documentPath === undefined ? undefined : await resolvePath(args.documentPath, exec);
          const result = await verifyNames({
            mojibakeName: String(args.mojibakeName ?? ''),
            candidates: Array.isArray(args.candidates) ? args.candidates.map(String) : [],
            documentPath,
          });
          const nextSteps = [];
          if (result.verified.length > 0) {
            nextSteps.push('指纹完全吻合，可用文件系统改名工具（或 zipfix_match_source 的等价操作）安全改名。');
          } else {
            nextSteps.push('无候选通过验证：请补充候选名，或提供源 ZIP 用 zipfix_match_source 做数学配对。');
          }
          return { ...result, nextSteps };
        },
        render(args, value) {
          const lines = [`【指纹验证】${value.summary}`, `乱码名：${value.mojibakeName}`];
          lines.push(`U+FFFD ${value.fffdCount} 个，扩展名 ${value.extension || '（无）'}`);
          if (value.document) {
            lines.push(`文档标题（${value.document.kind}）：${value.document.titles.slice(0, 5).join(' / ') || '（未抽取到）'}`);
          }
          if (value.candidates.length > 0) {
            lines.push('', '候选验证：');
            for (const item of value.candidates.slice(0, 10)) {
              const mark = item.match === 'exact' ? '✅ 完全吻合' : item.match === 'normalized' ? '✅ 吻合（U+FFFD 折叠后）' : item.match === 'unencodable' ? '⚠ 无法 GBK 编码' : '❌ 不吻合';
              lines.push(`  ${mark}：${truncate(item.candidate, 60)}`);
            }
          }
          if (value.nextSteps?.length) {
            lines.push('', '下一步：');
            for (const step of value.nextSteps) lines.push(`  • ${step}`);
          }
          return textContent(lines);
        },
      }),
    ),
  );
}
