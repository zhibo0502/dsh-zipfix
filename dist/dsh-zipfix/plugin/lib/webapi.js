/**
 * dsh-zipfix 的 HTTP API（供侧边栏 UI 包 dsh-zipfix-ui 调用）。
 *
 * 这条通道只做「浏览器 ↔ 本机 Host」的搬运，修复逻辑一律复用 lib/fix.js 的
 * 同一套操作（与 5 个 agent 工具完全同源），因此 UI 与 agent 两条调用路径行为一致。
 *
 * 安全设计（面向 127.0.0.1 本地服务）：
 * - 路由前缀独立为 `/zipfix-api`，不与 `/api` 网关或 SPA 回退冲突；
 * - 变更类请求必须带 `x-zipfix-token`（或 URL token）；token 只能由同源页面
 *   GET `/zipfix-api/token` 读取，跨站因 CORS 无法读取响应体，构成 CSRF 防护；
 * - 校验 `Origin`（若浏览器发送）必须在允许集合内；
 * - 上传按流式落盘并限制体积（默认 2 GiB），校验 ZIP 魔数；
 * - 下载/报告只允许访问本进程登记过的任务目录，不接受任意路径；
 * - 任务目录位于系统临时目录，24 小时后自动清理（下载后也可显式清理）。
 *
 * 注意：该模块不注册任何东西；调用方负责 webServer.register 与 disposer 生命周期。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fixZipArchive } from './fix.js';

/** HTTP 前缀。 */
export const WEB_API_PREFIX = '/zipfix-api';
/** 上传体积上限（2 GiB，与 ZIP64 能力匹配）。 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
/** JSON 请求体上限。 */
const MAX_JSON_BYTES = 1024 * 1024;
/** 任务保留时长。 */
const TASK_TTL_MS = 24 * 60 * 60 * 1000;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

/** 读取 JSON 请求体（带上限）。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '无效的 JSON 请求体');
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 上传文件名的安全化：只保留 basename，去掉非法字符，保证 .zip 后缀。 */
function sanitizeUploadName(raw) {
  let name = String(raw ?? '').replace(/\\/g, '/');
  name = name.slice(name.lastIndexOf('/') + 1);
  name = name.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
  if (name.length === 0) name = 'upload.zip';
  if (!/\.zip$/i.test(name)) name = `${name}.zip`;
  return name.length > 180 ? `${name.slice(0, 170)}.zip` : name;
}

/** RFC 5987 附件文件名（兼容中文）。 */
function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function readHeadBytes(filePath, length) {
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    const read = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** 把一次 fixZipArchive 结果裁剪成 UI 需要的形状（避免把整份报告塞进响应）。 */
function toScanPayload(result) {
  return {
    status: result.status,
    summary: result.summary,
    encoding: result.encoding,
    method: result.method,
    confidence: result.confidence,
    scores: result.scores,
    zipSize: result.zipSize,
    entries: result.entries,
    forms: result.forms,
    stripRoot: result.stripRoot,
    samples: result.rows.slice(0, 12).map((row) => ({
      action: row.action,
      original: row.original,
      fixed: row.fixed,
      basis: row.basis,
      verify: row.verify,
    })),
    irreversible: result.irreversible.slice(0, 12),
    failures: result.failures.slice(0, 12),
    warnings: result.warnings.slice(0, 12),
  };
}

function toFixPayload(result) {
  return {
    status: result.status,
    summary: result.summary,
    forced: result.forced === true,
    extractedFiles: result.applied.extractedFiles,
    extractedDirectories: result.applied.extractedDirectories,
    extractionFailures: result.applied.extractionFailures,
    fixedZip: result.applied.fixedZip
      ? {
          entries: result.applied.fixedZip.entries,
          allUtf8Flag: result.applied.fixedZip.allUtf8Flag,
          fullChecked: result.applied.fixedZip.fullChecked,
        }
      : null,
    irreversible: result.irreversible.length,
    rows: result.rows.slice(0, 8).map((row) => ({
      action: row.action,
      original: row.original,
      fixed: row.fixed,
      verify: row.verify,
    })),
    failures: result.failures.slice(0, 8),
  };
}

/**
 * 安装 ZIP 修复的侧边栏 HTTP API。
 * @param {object} ctx Host 插件上下文
 * @returns {() => void} 释放函数（注销路由、清理任务目录）
 */
export function installZipfixWebApi(ctx) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    ctx.logger?.warn?.('zipfix-ui: webServer service unavailable; sidebar API disabled');
    return () => {};
  }
  // 宿主连接认证：所有路由先过 connection.requestRejection（Host/Origin 围栏 + 浏览器会话认证）。
  // 拿不到 connection 或检查抛错时一律拒绝，绝不退化到「只检查 Host/Origin/回环」。
  const connection = ctx.get('connection');

  const tempRoot = path.join(os.tmpdir(), 'dsh-zipfix-web');
  const tasks = new Map();
  const token = crypto.randomBytes(24).toString('hex');
  let lastSweep = 0;

  let origin = '';
  try {
    origin = webServer.getOrigin();
  } catch {
    origin = '';
  }
  const allowedOrigins = new Set();
  const allowedHosts = new Set();
  if (origin !== '') {
    allowedOrigins.add(origin);
    try {
      const parsed = new URL(origin);
      const port = parsed.port;
      allowedOrigins.add(`http://127.0.0.1:${port}`);
      allowedOrigins.add(`http://localhost:${port}`);
      allowedHosts.add(`127.0.0.1:${port}`);
      allowedHosts.add(`localhost:${port}`);
      allowedHosts.add(parsed.host.toLowerCase());
    } catch {
      /* origin 不可解析时只保留原值 */
    }
  }

  function sweep() {
    const now = Date.now();
    if (now - lastSweep < 5 * 60 * 1000) return;
    lastSweep = now;
    for (const [id, task] of tasks) {
      if (now - task.createdAt > TASK_TTL_MS) {
        tasks.delete(id);
        void fsp.rm(task.dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  function taskOrThrow(taskId) {
    const task = typeof taskId === 'string' ? tasks.get(taskId) : undefined;
    if (task === undefined) throw new HttpError(404, '任务不存在或已过期，请重新上传');
    return task;
  }

  function assertOrigin(req) {
    const header = req.headers.origin;
    if (typeof header !== 'string' || header.length === 0) return; // 同源 GET/本地工具通常不带 Origin
    if (!allowedOrigins.has(header)) throw new HttpError(403, '请求来源不被允许');
  }

  /**
   * 宿主认证准入：交给 DSH 的 connection 服务判断 Host/Origin 围栏与浏览器会话。
   * 失败关闭（fail closed）：没有 connection 服务、检查抛错、或返回 401/403 都拒绝。
   */
  function assertAdmitted(req) {
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      throw new HttpError(403, '宿主认证服务不可用，已拒绝该请求');
    }
    let rejection;
    try {
      rejection = connection.requestRejection(req);
    } catch (error) {
      throw new HttpError(403, `宿主认证检查失败，已拒绝该请求：${error?.message ?? error}`);
    }
    if (rejection === undefined) return;
    if (rejection === 401) throw new HttpError(401, '需要已认证的 DSH 页面会话');
    throw new HttpError(403, '请求未通过宿主 Host/Origin 围栏');
  }

  /** 校验 Host 头，抵御 DNS rebinding：只接受本机绑定的 loopback 主机名。 */
  function assertHost(req) {
    const header = req.headers.host;
    if (typeof header !== 'string' || header.length === 0) throw new HttpError(403, '缺少 Host 头');
    if (allowedHosts.size === 0) return; // 拿不到绑定地址时退化为 Origin/token 防护
    if (!allowedHosts.has(header.toLowerCase())) throw new HttpError(403, '请求 Host 不被允许');
  }

  function assertToken(req, url) {
    const header = req.headers['x-zipfix-token'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (provided === token) return;
    if (url.searchParams.get('token') === token) return;
    throw new HttpError(403, '缺少或无效的访问令牌');
  }

  async function handleUpload(req, res, url) {
    sweep();
    const name = sanitizeUploadName(url.searchParams.get('name'));
    const encoding = url.searchParams.get('encoding') ?? undefined;
    const id = crypto.randomUUID();
    const dir = path.join(tempRoot, `task-${id}`);
    await fsp.mkdir(dir, { recursive: true });
    const sourcePath = path.join(dir, 'source.zip');
    const controller = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) controller.abort();
    });

    let bytes = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_UPLOAD_BYTES) {
          callback(new HttpError(413, `压缩包超过上限（${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MiB）`));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(req, limit, fs.createWriteStream(sourcePath), { signal: controller.signal });
    } catch (error) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (error instanceof HttpError) throw error;
      if (controller.signal.aborted) throw new HttpError(499, '上传已取消');
      throw new HttpError(400, `上传失败：${error.message}`);
    }

    const head = readHeadBytes(sourcePath, 4);
    if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(400, '这不是一个 ZIP 压缩包（缺少 PK 魔数）');
    }

    const task = {
      id,
      dir,
      sourcePath,
      name,
      size: bytes,
      createdAt: Date.now(),
      fixedPath: null,
      fixedName: null,
      report: null,
    };
    tasks.set(id, task);

    let scan;
    try {
      scan = await fixZipArchive({
        zipPath: sourcePath,
        dryRun: true,
        extract: false,
        buildFixedZip: false,
        displayName: name,
        ...(encoding ? { encoding } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      tasks.delete(id);
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw new HttpError(400, `ZIP 解析失败：${error.message}`);
    }

    finished = true;
    sendJson(res, 200, {
      ok: true,
      taskId: id,
      name,
      size: bytes,
      scan: toScanPayload(scan),
    });
  }

  async function handleFix(req, res, body) {
    const task = taskOrThrow(body.taskId);
    const version = (task.fixVersion ?? 0) + 1;
    task.fixVersion = version;
    const outputDir = path.join(task.dir, `fixed-${version}`);
    await fsp.mkdir(outputDir, { recursive: true });
    const controller = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) controller.abort();
    });
    let result;
    try {
      result = await fixZipArchive({
        zipPath: task.sourcePath,
        outputDir,
        dryRun: false,
        extract: false,
        buildFixedZip: true,
        stripRoot: body.stripRoot !== false,
        force: body.force === true,
        displayName: task.name,
        ...(body.encoding ? { encoding: body.encoding } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new HttpError(499, '操作已取消');
      throw new HttpError(500, `生成修复版 ZIP 失败：${error.message}`);
    }
    finished = true;
    if (result.applied.fixedZipPath) {
      task.fixedPath = result.applied.fixedZipPath;
      task.fixedName = path.basename(result.applied.fixedZipPath);
      task.report = result.applied.report ?? null;
      sendJson(res, 200, {
        ok: true,
        taskId: task.id,
        result: toFixPayload(result),
        downloadUrl: `${WEB_API_PREFIX}/download?task=${task.id}&token=${token}`,
        reportUrl: task.report ? `${WEB_API_PREFIX}/report?task=${task.id}&format=md&token=${token}` : null,
        csvUrl: task.report ? `${WEB_API_PREFIX}/report?task=${task.id}&format=csv&token=${token}` : null,
      });
      return;
    }
    // 判定「无需修复」且未 force：不产生文件，但把判定原样带回
    task.report = result.applied.report ?? null;
    sendJson(res, 200, {
      ok: true,
      taskId: task.id,
      result: toFixPayload(result),
      downloadUrl: null,
      reportUrl: task.report ? `${WEB_API_PREFIX}/report?task=${task.id}&format=md&token=${token}` : null,
      csvUrl: null,
    });
  }

  async function handleExtract(req, res, body) {
    const task = taskOrThrow(body.taskId);
    const outputDir = String(body.outputDir ?? '').trim();
    if (outputDir.length === 0) throw new HttpError(400, '请先选择输出目录');
    if (!path.isAbsolute(outputDir)) throw new HttpError(400, '输出目录必须是绝对路径');
    const controller = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) controller.abort();
    });
    let result;
    try {
      result = await fixZipArchive({
        zipPath: task.sourcePath,
        outputDir,
        dryRun: false,
        extract: true,
        buildFixedZip: false,
        stripRoot: body.stripRoot !== false,
        force: body.force === true,
        displayName: task.name,
        ...(body.encoding ? { encoding: body.encoding } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new HttpError(499, '操作已取消');
      throw new HttpError(500, `解压失败：${error.message}`);
    }
    finished = true;
    sendJson(res, 200, {
      ok: true,
      taskId: task.id,
      result: toFixPayload(result),
      extract: {
        outputDir: result.outputDir,
        files: result.applied.extractedFiles,
        directories: result.applied.extractedDirectories,
        failures: result.applied.extractionFailures,
        reportMarkdown: result.applied.report?.markdownPath ?? null,
      },
    });
  }

  async function handleDownload(req, res, url) {
    const task = taskOrThrow(url.searchParams.get('task'));
    if (!task.fixedPath) throw new HttpError(404, '还没有生成修复版 ZIP');
    const stat = await fsp.stat(task.fixedPath);
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': stat.size,
      'content-disposition': contentDisposition(task.fixedName ?? 'zipfix-fixed.zip'),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    await pipeline(fs.createReadStream(task.fixedPath), res);
  }

  async function handleReport(req, res, url) {
    const task = taskOrThrow(url.searchParams.get('task'));
    const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'md';
    const filePath = format === 'csv' ? task.report?.csvPath : task.report?.markdownPath;
    if (!filePath) throw new HttpError(404, '还没有可用的审计报告');
    const text = await fsp.readFile(filePath, 'utf8');
    sendText(res, 200, text, format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8');
  }

  async function handleCleanup(req, res, body) {
    const taskId = body.taskId;
    const task = typeof taskId === 'string' ? tasks.get(taskId) : undefined;
    if (task === undefined) {
      sendJson(res, 200, { ok: true, removed: false });
      return;
    }
    tasks.delete(task.id);
    await fsp.rm(task.dir, { recursive: true, force: true }).catch(() => {});
    sendJson(res, 200, { ok: true, removed: true });
  }

  async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (!url.pathname.startsWith(WEB_API_PREFIX)) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      assertAdmitted(req);
      assertOrigin(req);
      assertHost(req);
      const route = url.pathname.slice(WEB_API_PREFIX.length) || '/';
      const method = (req.method ?? 'GET').toUpperCase();

      if (method === 'GET' && (route === '/token' || route === '/health')) {
        sendJson(res, 200, {
          ok: true,
          token,
          origin,
          maxUploadBytes: MAX_UPLOAD_BYTES,
          taskTtlMs: TASK_TTL_MS,
          version: '0.1.2',
        });
        return;
      }

      assertToken(req, url);

      // 自检：告诉页面「侧边栏 UI 是否已注册进客户端模块图」，便于排查未刷新页面等情况
      if (method === 'GET' && route === '/selfcheck') {
        let clientRegistered = false;
        let mentions = [];
        try {
          const clientModules = ctx.get('clientModules');
          const graph = clientModules?.graph?.();
          if (graph !== undefined) {
            const serialized = JSON.stringify(graph);
            clientRegistered = /dsh-zipfix(?:-ui)?\/client\.js/u.test(serialized);
            mentions = [...new Set(serialized.match(/[^"\\]*dsh-zipfix(?:-ui)?[^"\\]*/g) ?? [])].slice(0, 20);
          }
        } catch {
          clientRegistered = false;
        }
        sendJson(res, 200, {
          ok: true,
          hostApi: true,
          clientRegistered,
          clientId: 'dsh-zipfix-ui',
          mentions,
          hint: clientRegistered
            ? '客户端模块已注册；若侧边栏仍未出现，请刷新页面。'
            : '客户端模块尚未注册；请重新加载 dsh-zipfix-ui 插件或重启 Harness。',
        });
        return;
      }

      if (method === 'POST' && route === '/upload') {
        await handleUpload(req, res, url);
        return;
      }
      if (method === 'POST' && route === '/fix') {
        const body = await readJsonBody(req);
        await handleFix(req, res, body);
        return;
      }
      if (method === 'POST' && route === '/extract') {
        const body = await readJsonBody(req);
        await handleExtract(req, res, body);
        return;
      }
      if (method === 'POST' && route === '/cleanup') {
        const body = await readJsonBody(req);
        await handleCleanup(req, res, body);
        return;
      }
      if (method === 'GET' && route === '/download') {
        await handleDownload(req, res, url);
        return;
      }
      if (method === 'GET' && route === '/report') {
        await handleReport(req, res, url);
        return;
      }
      sendJson(res, 404, { ok: false, error: `unknown endpoint ${method} ${route}` });
    } catch (error) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) ctx.logger?.warn?.(`zipfix-ui: ${methodHint(req)} failed: ${error?.message ?? error}`);
      sendJson(res, status, { ok: false, error: error?.message ?? String(error) });
    }
  }

  function methodHint(req) {
    return `${req.method ?? '?'} ${req.url ?? '?'}`;
  }

  const dispose = webServer.register({
    kind: 'prefix',
    path: WEB_API_PREFIX,
    handler,
  });

  return () => {
    try {
      dispose();
    } catch {
      /* ignore */
    }
    for (const task of tasks.values()) {
      void fsp.rm(task.dir, { recursive: true, force: true }).catch(() => {});
    }
    tasks.clear();
  };
}
