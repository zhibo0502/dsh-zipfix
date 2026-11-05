/**
 * 修复报告生成（Markdown + CSV）。
 *
 * 报告是「可审计」要求的载体：每条改动都记录 原名字 → 新名字 → 依据 → 校验结果，
 * 失败项单独列出，绝不静默丢弃。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

/** 报告列定义（顺序即表格列顺序）。 */
const COLUMNS = [
  { key: 'action', label: '操作' },
  { key: 'original', label: '原名字' },
  { key: 'fixed', label: '新名字' },
  { key: 'basis', label: '依据' },
  { key: 'verify', label: '校验' },
  { key: 'note', label: '备注' },
];

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function markdownCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * 构造报告文本（不落盘）。
 * @param {object} report
 * @param {string} report.title 标题
 * @param {string[]} [report.meta] 头部元信息行
 * @param {Array<{label: string, value: string|number}>} [report.summary] 摘要键值
 * @param {Array<object>} [report.rows] 明细行
 * @param {Array<object>} [report.failures] 失败行
 * @param {Array<string>} [report.notes] 说明与警告
 * @returns {{markdown: string, csv: string}}
 */
export function buildReport({ title, generatedAt, meta = [], summary = [], rows = [], failures = [], notes = [] }) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  if (generatedAt) lines.push(`- 生成时间：${generatedAt}`);
  for (const item of meta) lines.push(`- ${item.label}：${item.value}`);
  lines.push('');
  if (summary.length > 0) {
    lines.push('## 摘要');
    lines.push('');
    lines.push('| 项目 | 值 |');
    lines.push('| --- | --- |');
    for (const item of summary) lines.push(`| ${markdownCell(item.label)} | ${markdownCell(item.value)} |`);
    lines.push('');
  }
  if (rows.length > 0) {
    lines.push('## 明细');
    lines.push('');
    lines.push(`| ${COLUMNS.map((column) => column.label).join(' | ')} |`);
    lines.push(`| ${COLUMNS.map(() => '---').join(' | ')} |`);
    for (const row of rows) {
      lines.push(`| ${COLUMNS.map((column) => markdownCell(row[column.key])).join(' | ')} |`);
    }
    lines.push('');
  }
  if (failures.length > 0) {
    lines.push('## 失败 / 待人工');
    lines.push('');
    lines.push('| 名字 | 原因 |');
    lines.push('| --- | --- |');
    for (const failure of failures) {
      lines.push(`| ${markdownCell(failure.original ?? failure.path ?? '')} | ${markdownCell(failure.reason ?? '')} |`);
    }
    lines.push('');
  }
  if (notes.length > 0) {
    lines.push('## 说明');
    lines.push('');
    for (const note of notes) lines.push(`- ${note}`);
    lines.push('');
  }
  const csvLines = [];
  csvLines.push(COLUMNS.map((column) => csvCell(column.label)).join(','));
  for (const row of rows) csvLines.push(COLUMNS.map((column) => csvCell(row[column.key])).join(','));
  for (const failure of failures) {
    const row = { action: '待人工', original: failure.original ?? failure.path ?? '', fixed: '', basis: '', verify: '失败', note: failure.reason ?? '' };
    csvLines.push(COLUMNS.map((column) => csvCell(row[column.key])).join(','));
  }
  return { markdown: `${lines.join('\n')}\n`, csv: `${csvLines.join('\r\n')}\r\n` };
}

/** 时间戳：YYYYMMDD_HHMMSS（本地时区）。 */
export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * 把报告写到目录下；目标已存在时追加序号，绝不覆盖。
 * @param {string} dir 输出目录
 * @param {string} stem 文件名主干（不含时间戳与扩展名）
 * @param {{markdown: string, csv: string}} report 报告内容
 * @returns {Promise<{markdownPath: string, csvPath: string}>}
 */
export async function writeReportFiles(dir, stem, report) {
  await fsp.mkdir(dir, { recursive: true });
  let attempt = 1;
  let base = path.join(dir, `zipfix-${stem}-${timestamp()}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const markdownPath = `${base}.md`;
    const csvPath = `${base}.csv`;
    try {
      await fsp.writeFile(markdownPath, report.markdown, { flag: 'wx' });
      try {
        await fsp.writeFile(csvPath, report.csv, { flag: 'wx' });
      } catch (error) {
        await fsp.rm(markdownPath, { force: true }).catch(() => {});
        throw error;
      }
      return { markdownPath, csvPath };
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        attempt++;
        base = path.join(dir, `zipfix-${stem}-${timestamp()}_${attempt}`);
        continue;
      }
      throw error;
    }
  }
}
