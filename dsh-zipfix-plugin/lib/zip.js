/**
 * ZIP 容器读写（纯 Node 标准库，无第三方依赖）。
 *
 * 与常见库不同，本实现**保留中央目录里的文件名字节**（`entry.nameBytes`），
 * 不先行解码——这正是编码嗅探与无损还原的前提（见 ALG-1）。
 *
 * 支持：
 * - 读取 ZIP64（EOCD64 / ZIP64 扩展字段），条目数或体积超 4GB 不溢出；
 * - 提取时流式解压，逐条校验 uncompressedSize 与 CRC32；
 * - 重建「修复版 ZIP」时显式置位 UTF-8 文件名标志 0x0800，并在取值后回填
 *   本地文件头（不使用数据描述符），使 Windows 资源管理器 / 7-Zip 直接识别；
 * - 写入时以 `wx` 打开目标文件，绝不覆盖已有文件。
 *
 * 安全：所有输出路径由调用方保证唯一；本模块不删除任何源文件。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** ZIP 通用位标记：文件名是 UTF-8（bit 11）。 */
export const ZIP_UTF8_FLAG = 0x0800;
/** ZIP 通用位标记：数据描述符（bit 3）。 */
export const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
/** ZIP 通用位标记：加密（bit 0）。 */
export const ZIP_ENCRYPTED_FLAG = 0x0001;
/** 压缩方式：存储。 */
export const METHOD_STORE = 0;
/** 压缩方式：deflate。 */
export const METHOD_DEFLATE = 8;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const U32_MAX = 0xffffffff;

/** 计算（或增量续算）CRC32。 */
export function crc32(buf, previous = 0) {
  return zlib.crc32(buf, previous) >>> 0;
}

/** CRC32 的 8 位大写十六进制形式。 */
export function formatCrc(value) {
  return (value >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

function readAt(fd, position, length) {
  if (length === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, position + read);
    if (n <= 0) throw new Error(`读取 ZIP 失败：偏移 ${position + read} 处提前结束`);
    read += n;
  }
  return buf;
}

function u16(buf, offset) {
  return buf.readUInt16LE(offset);
}

function u32(buf, offset) {
  return buf.readUInt32LE(offset);
}

function u64(buf, offset) {
  return Number(buf.readBigUInt64LE(offset));
}

/** 遍历扩展字段，返回 id → 数据 的映射（同 id 取第一个）。 */
function parseExtraFields(extra) {
  const fields = new Map();
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = u16(extra, pos);
    const size = u16(extra, pos + 2);
    if (pos + 4 + size > extra.length) break;
    if (!fields.has(id)) fields.set(id, extra.subarray(pos + 4, pos + 4 + size));
    pos += 4 + size;
  }
  return fields;
}

/**
 * 解析一个 ZIP 文件，返回中央目录条目（保留原始文件名字节）。
 * @param {string} zipPath ZIP 文件绝对路径
 * @returns {ZipCatalog}
 */
export class ZipCatalog {
  /** @type {number} */
  #fd;
  /** @type {string} */
  path;
  /** @type {number} */
  size;
  /** @type {Array<object>} */
  entries = [];
  /** @type {string} */
  comment = '';
  /** @type {boolean} */
  zip64 = false;
  /** @type {string[]} */
  warnings = [];
  #closed = false;

  /**
   * @param {string} zipPath 绝对路径
   */
  constructor(zipPath) {
    this.path = zipPath;
    this.#fd = fs.openSync(zipPath, 'r');
    try {
      const stat = fs.fstatSync(this.#fd);
      if (!stat.isFile()) throw new Error(`不是普通文件：${zipPath}`);
      this.size = stat.size;
      this.#parse();
    } catch (error) {
      try {
        fs.closeSync(this.#fd);
      } catch {
        /* ignore */
      }
      this.#closed = true;
      throw error;
    }
  }

  get fd() {
    if (this.#closed) throw new Error('ZIP 句柄已关闭');
    return this.#fd;
  }

  #parse() {
    const size = this.size;
    if (size < 22) throw new Error('不是 ZIP 文件：文件长度不足 22 字节');
    const tailLength = Math.min(size, 66_000 + 22);
    const tailStart = size - tailLength;
    const tail = readAt(this.#fd, tailStart, tailLength);

    let eocdInTail = -1;
    let fallback = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
      const commentLength = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLength === tail.length) {
        eocdInTail = i;
        break;
      }
      if (fallback < 0 && i + 22 + commentLength <= tail.length) fallback = i;
    }
    if (eocdInTail < 0) eocdInTail = fallback;
    if (eocdInTail < 0) throw new Error('不是 ZIP 文件：找不到中央目录结尾记录（EOCD）');

    const eocdPos = tailStart + eocdInTail;
    let entriesTotal = u16(tail, eocdInTail + 10);
    let cdSize = u32(tail, eocdInTail + 12);
    let cdOffset = u32(tail, eocdInTail + 16);
    this.comment = tail.subarray(eocdInTail + 22, eocdInTail + 22 + u16(tail, eocdInTail + 20)).toString('utf8');

    const needsZip64 =
      entriesTotal === 0xffff || cdSize === U32_MAX || cdOffset === U32_MAX;
    if (needsZip64) {
      const locatorPos = eocdInTail - 20;
      let zip64Offset = -1;
      if (locatorPos >= 0 && u32(tail, locatorPos) === SIG_EOCD64_LOCATOR) {
        zip64Offset = u64(tail, locatorPos + 8);
      }
      if (zip64Offset < 0 || zip64Offset + 56 > size) {
        throw new Error('ZIP64 结构中缺少定位记录，无法解析中央目录');
      }
      const rec = readAt(this.#fd, zip64Offset, 56);
      if (u32(rec, 0) !== SIG_EOCD64) throw new Error('ZIP64 结尾记录签名错误');
      entriesTotal = u64(rec, 32);
      cdSize = u64(rec, 40);
      cdOffset = u64(rec, 48);
      this.zip64 = true;
    }

    if (cdOffset + cdSize > size) {
      throw new Error(`ZIP 中央目录越界（offset=${cdOffset}, size=${cdSize}, file=${size}）`);
    }

    const cd = readAt(this.#fd, cdOffset, cdSize);
    let pos = 0;
    let index = 0;
    while (pos + 46 <= cd.length) {
      if (u32(cd, pos) !== SIG_CENTRAL) break;
      const flags = u16(cd, pos + 8);
      const method = u16(cd, pos + 10);
      const modTime = u16(cd, pos + 12);
      const modDate = u16(cd, pos + 14);
      const crc = u32(cd, pos + 16);
      let compressedSize = u32(cd, pos + 20);
      let uncompressedSize = u32(cd, pos + 24);
      const nameLength = u16(cd, pos + 28);
      const extraLength = u16(cd, pos + 30);
      const commentLength = u16(cd, pos + 32);
      const diskStart = u16(cd, pos + 34);
      const internalAttr = u16(cd, pos + 36);
      const externalAttr = u32(cd, pos + 38);
      let localHeaderOffset = u32(cd, pos + 42);
      const nameStart = pos + 46;
      const extraStart = nameStart + nameLength;
      const extraEnd = extraStart + extraLength;
      if (extraEnd > cd.length) throw new Error('ZIP 中央目录条目越界');
      const nameBytes = Buffer.from(cd.subarray(nameStart, extraStart));
      const extra = cd.subarray(extraStart, extraEnd);

      if (
        uncompressedSize === U32_MAX ||
        compressedSize === U32_MAX ||
        localHeaderOffset === U32_MAX ||
        diskStart === 0xffff
      ) {
        const z = parseExtraFields(extra).get(ZIP64_EXTRA_ID);
        if (z) {
          let q = 0;
          if (uncompressedSize === U32_MAX && q + 8 <= z.length) {
            uncompressedSize = u64(z, q);
            q += 8;
          }
          if (compressedSize === U32_MAX && q + 8 <= z.length) {
            compressedSize = u64(z, q);
            q += 8;
          }
          if (localHeaderOffset === U32_MAX && q + 8 <= z.length) {
            localHeaderOffset = u64(z, q);
            q += 8;
          }
        }
      }

      if (diskStart !== 0) this.warnings.push(`条目 ${index} 位于分卷磁盘 ${diskStart}，不支持分卷 ZIP`);

      const isDirectory =
        (nameLength > 0 && nameBytes[nameBytes.length - 1] === 0x2f) ||
        ((externalAttr >>> 16) & 0x10) !== 0;

      this.entries.push({
        index,
        nameBytes,
        flags,
        method,
        modTime,
        modDate,
        crc,
        compressedSize,
        uncompressedSize,
        diskStart,
        internalAttr,
        externalAttr,
        localHeaderOffset,
        versionMadeBy: u16(cd, pos + 4),
        versionNeeded: u16(cd, pos + 6),
        isDirectory,
        encrypted: (flags & ZIP_ENCRYPTED_FLAG) !== 0,
        utf8Flag: (flags & ZIP_UTF8_FLAG) !== 0,
        dataDescriptor: (flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0,
      });
      pos = extraEnd + commentLength;
      index++;
    }

    if (entriesTotal !== 0 && this.entries.length !== entriesTotal) {
      this.warnings.push(
        `中央目录声明 ${entriesTotal} 个条目，实际解析 ${this.entries.length} 个（ZIP 可能损坏）`,
      );
    }
    // 加密与不支持的压缩方式不在这里抛错：扫描仍应能列出条目，具体操作时再报错。
    for (const entry of this.entries) {
      entry.supported = !entry.encrypted && (entry.method === METHOD_STORE || entry.method === METHOD_DEFLATE);
    }
    if (this.entries.some((e) => e.encrypted)) this.warnings.push('ZIP 含加密条目，相关条目无法解压');
    if (this.entries.some((e) => !e.supported && !e.encrypted)) {
      this.warnings.push('ZIP 含不支持的压缩方式条目，相关条目无法解压');
    }
  }

  /** 关闭底层文件句柄（可重复调用）。 */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      fs.closeSync(this.#fd);
    } catch {
      /* ignore */
    }
  }

  /** 计算条目数据区在文件中的起始偏移。 */
  entryDataOffset(entry) {
    const header = readAt(this.fd, entry.localHeaderOffset, 30);
    if (u32(header, 0) !== SIG_LOCAL) {
      throw new Error(`条目「${entry.index}」本地文件头签名错误，ZIP 可能损坏`);
    }
    const nameLength = u16(header, 26);
    const extraLength = u16(header, 28);
    return entry.localHeaderOffset + 30 + nameLength + extraLength;
  }

  /**
   * 读取一个条目的完整内容（仅用于小文件，如 OOXML 元数据）。
   * @param {object} entry 条目
   * @param {{maxBytes?: number}} [options] 上限，默认 32 MiB
   * @returns {Buffer} 解压后的内容
   */
  readEntryBuffer(entry, { maxBytes = 32 * 1024 * 1024 } = {}) {
    if (entry.uncompressedSize > maxBytes) {
      throw new Error(`条目解压后 ${entry.uncompressedSize} 字节，超过读取上限 ${maxBytes}`);
    }
    const dataOffset = this.entryDataOffset(entry);
    const compressed = readAt(this.fd, dataOffset, entry.compressedSize);
    let data;
    if (entry.method === METHOD_STORE) data = compressed;
    else data = zlib.inflateRawSync(compressed, { maxOutputLength: maxBytes });
    if (data.length !== entry.uncompressedSize) {
      throw new Error(`条目数据长度不符：期望 ${entry.uncompressedSize}，实际 ${data.length}`);
    }
    if (crc32(data) !== entry.crc) throw new Error('条目 CRC32 校验失败');
    return data;
  }

  /** 为条目创建只读压缩数据流（调用方负责 pipeline 消费）。 */
  createEntryStream(entry) {
    if (entry.compressedSize === 0) return null;
    const dataOffset = this.entryDataOffset(entry);
    return fs.createReadStream(null, {
      fd: this.fd,
      start: dataOffset,
      end: dataOffset + entry.compressedSize - 1,
      autoClose: false,
    });
  }
}

/**
 * 打开 ZIP 目录（解析中央目录，不读取条目内容）。
 * @param {string} zipPath ZIP 绝对路径
 * @returns {ZipCatalog}
 */
export function openZipCatalog(zipPath) {
  return new ZipCatalog(zipPath);
}

/* ------------------------------------------------------------------ *
 * 流式校验与提取
 * ------------------------------------------------------------------ */

class IntegrityTransform extends Transform {
  constructor(entry) {
    super();
    this.entry = entry;
    this.size = 0;
    this.crc = 0;
    this.hash = crypto.createHash('sha256');
  }

  _transform(chunk, _enc, callback) {
    this.size += chunk.length;
    this.crc = crc32(chunk, this.crc);
    this.hash.update(chunk);
    callback(null, chunk);
  }

  finish() {
    if (this.size !== this.entry.uncompressedSize) {
      throw new Error(
        `条目大小校验失败：中央目录 ${this.entry.uncompressedSize} 字节，实际 ${this.size} 字节`,
      );
    }
    if (this.crc !== this.entry.crc) {
      throw new Error(
        `条目 CRC32 校验失败：中央目录 ${formatCrc(this.entry.crc)}，实际 ${formatCrc(this.crc)}`,
      );
    }
    return { size: this.size, crc: this.crc, sha256: this.hash.digest('hex') };
  }
}

/** 丢弃数据但保持流式消费的 Writable。 */
class NullSink extends Writable {
  _write(_chunk, _enc, callback) {
    callback();
  }
}

/** 直接写入 fd 并统计字节数的 Writable。 */
class FdSink extends Writable {
  constructor(fd) {
    super();
    this.fd = fd;
    this.count = 0;
  }

  _write(chunk, _enc, callback) {
    try {
      fs.writeSync(this.fd, chunk);
      this.count += chunk.length;
      callback();
    } catch (error) {
      callback(error);
    }
  }
}

/**
 * 提取单个条目到文件，并校验大小与 CRC32。
 * 目标文件以独占方式创建（`wx`），绝不覆盖。
 * @param {ZipCatalog} catalog 目录
 * @param {object} entry 条目
 * @param {string} outPath 目标文件路径（必须不存在）
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{size: number, crc: number, sha256: string}>}
 */
export async function extractEntry(catalog, entry, outPath, { signal } = {}) {
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  if (entry.compressedSize === 0) {
    await fsp.writeFile(outPath, Buffer.alloc(0), { flag: 'wx' });
    if (entry.uncompressedSize !== 0 || entry.crc !== 0) throw new Error('空条目的大小/CRC 与中央目录不符');
    return { size: 0, crc: 0, sha256: crypto.createHash('sha256').digest('hex') };
  }
  const source = catalog.createEntryStream(entry);
  const integrity = new IntegrityTransform(entry);
  const stages = [source];
  if (entry.method === METHOD_DEFLATE) stages.push(zlib.createInflateRaw());
  stages.push(integrity, fs.createWriteStream(outPath, { flags: 'wx' }));
  try {
    await pipeline(stages, signal === undefined ? {} : { signal });
  } catch (error) {
    await fsp.rm(outPath, { force: true }).catch(() => {});
    throw error;
  }
  try {
    return integrity.finish();
  } catch (error) {
    await fsp.rm(outPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 流式读取并校验单个条目（不落盘）。
 * @param {ZipCatalog} catalog 目录
 * @param {object} entry 条目
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{size: number, crc: number, sha256: string}>}
 */
export async function verifyEntry(catalog, entry, { signal } = {}) {
  if (entry.compressedSize === 0) {
    if (entry.uncompressedSize !== 0 || entry.crc !== 0) throw new Error('空条目的大小/CRC 与中央目录不符');
    return { size: 0, crc: 0, sha256: crypto.createHash('sha256').digest('hex') };
  }
  const source = catalog.createEntryStream(entry);
  const integrity = new IntegrityTransform(entry);
  const stages = [source];
  if (entry.method === METHOD_DEFLATE) stages.push(zlib.createInflateRaw());
  stages.push(integrity, new NullSink());
  await pipeline(stages, signal === undefined ? {} : { signal });
  return integrity.finish();
}

/* ------------------------------------------------------------------ *
 * 写出「修复版 ZIP」
 * ------------------------------------------------------------------ */

function dosDateTime(modTime, modDate) {
  // 原样保留源条目的 DOS 时间戳（本地时区语义由源数据决定）
  return { modTime, modDate };
}

function buildLocalHeader({
  versionNeeded,
  flags,
  method,
  modTime,
  modDate,
  nameBytes,
  extra,
}) {
  const header = Buffer.alloc(30 + nameBytes.length + extra.length);
  header.writeUInt32LE(SIG_LOCAL, 0);
  header.writeUInt16LE(versionNeeded, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(modTime, 10);
  header.writeUInt16LE(modDate, 12);
  header.writeUInt32LE(0, 14); // crc32，稍后回填
  header.writeUInt32LE(0, 18); // compressed size，稍后回填
  header.writeUInt32LE(0, 22); // uncompressed size，稍后回填
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(extra.length, 28);
  nameBytes.copy(header, 30);
  extra.copy(header, 30 + nameBytes.length);
  return header;
}

function buildZip64LocalExtra(uncompressedSize, compressedSize) {
  const extra = Buffer.alloc(4 + 16);
  extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(BigInt(uncompressedSize), 4);
  extra.writeBigUInt64LE(BigInt(compressedSize), 12);
  return extra;
}

function buildCentralHeader(record) {
  const { nameBytes, extra } = record;
  const header = Buffer.alloc(46 + nameBytes.length + extra.length);
  header.writeUInt32LE(SIG_CENTRAL, 0);
  header.writeUInt16LE(record.versionMadeBy, 4);
  header.writeUInt16LE(record.versionNeeded, 6);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
  header.writeUInt16LE(record.method, 10);
  header.writeUInt16LE(record.modTime, 12);
  header.writeUInt16LE(record.modDate, 14);
  header.writeUInt32LE(record.crc >>> 0, 16);
  // ZIP64 记录必须与本地文件头保持一致：本地头写了 0xFFFFFFFF 占位，
  // 中央目录同样占位并在扩展字段里给出 8 字节真值。
  header.writeUInt32LE(record.zip64 ? U32_MAX : record.compressedSize, 20);
  header.writeUInt32LE(record.zip64 ? U32_MAX : record.uncompressedSize, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt16LE(record.commentLength ?? 0, 32);
  header.writeUInt16LE(0, 34); // disk start
  header.writeUInt16LE(record.internalAttr, 36);
  header.writeUInt32LE(record.externalAttr >>> 0, 38);
  header.writeUInt32LE(record.zip64 && record.localHeaderOffset > U32_MAX - 1 ? U32_MAX : record.localHeaderOffset, 42);
  nameBytes.copy(header, 46);
  extra.copy(header, 46 + nameBytes.length);
  return header;
}

function buildZip64CentralExtra(record) {
  const parts = [];
  const usize = Buffer.alloc(8);
  usize.writeBigUInt64LE(BigInt(record.uncompressedSize));
  parts.push(usize);
  const csize = Buffer.alloc(8);
  csize.writeBigUInt64LE(BigInt(record.compressedSize));
  parts.push(csize);
  if (record.localHeaderOffset > U32_MAX - 1) {
    const offsetPart = Buffer.alloc(8);
    offsetPart.writeBigUInt64LE(BigInt(record.localHeaderOffset));
    parts.push(offsetPart);
  }
  const payload = Buffer.concat(parts);
  const extra = Buffer.alloc(4 + payload.length);
  extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
  extra.writeUInt16LE(payload.length, 2);
  payload.copy(extra, 4);
  return extra;
}

/**
 * 写出「修复版 ZIP」：所有条目置位 UTF-8 文件名标志 0x0800，
 * 文件名按 UTF-8 编码，逐条重新压缩并校验源数据 CRC32。
 *
 * @param {object} options
 * @param {ZipCatalog} options.sourceCatalog 源 ZIP
 * @param {string} options.destPath 目标 ZIP（必须不存在）
 * @param {Array<{entry: object, name: string}>} options.plans 条目 → 修正后名字
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.forceZip64] 测试用：强制 ZIP64 结构
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<{entries: number, compressedBytes: number, zip64: boolean}>}
 */
export async function writeFixedZip({
  sourceCatalog,
  destPath,
  plans,
  signal,
  forceZip64 = false,
  onProgress,
}) {
  const fd = fs.openSync(destPath, 'wx');
  let offset = 0;
  const records = [];
  const write = (buffer) => {
    fs.writeSync(fd, buffer);
    offset += buffer.length;
  };
  try {
    for (const [index, plan] of plans.entries()) {
      if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
      const entry = plan.entry;
      const name = plan.name;
      if (!entry.isDirectory && !entry.supported) {
        throw new Error(
          `条目 #${entry.index} ${entry.encrypted ? '已加密' : `压缩方式 ${entry.method} 不受支持`}，无法重建修复版 ZIP`,
        );
      }
      const nameBytes = Buffer.from(name, 'utf8');
      const isDirectory = name.endsWith('/');
      const zip64 = forceZip64 || entry.uncompressedSize > 0xf0000000;
      const versionNeeded = zip64 ? 45 : 20;

      if (isDirectory) {
        const extra = zip64 ? buildZip64LocalExtra(0, 0) : Buffer.alloc(0);
        const localOffset = offset;
        write(
          buildLocalHeader({
            versionNeeded,
            flags: ZIP_UTF8_FLAG,
            method: METHOD_STORE,
            modTime: entry.modTime,
            modDate: entry.modDate,
            nameBytes,
            extra,
          }),
        );
        records.push({
          nameBytes,
          versionMadeBy: entry.versionMadeBy,
          versionNeeded,
          method: METHOD_STORE,
          modTime: entry.modTime,
          modDate: entry.modDate,
          crc: 0,
          compressedSize: 0,
          uncompressedSize: 0,
          localHeaderOffset: localOffset,
          internalAttr: entry.internalAttr,
          externalAttr: entry.externalAttr,
          zip64,
        });
        if (zip64) {
          // ZIP64 目录条目的本地文件头同样用 0xFFFFFFFF 占位，真值在扩展字段里
          const sizes = Buffer.alloc(8);
          sizes.writeUInt32LE(U32_MAX, 0);
          sizes.writeUInt32LE(U32_MAX, 4);
          fs.writeSync(fd, sizes, 0, 8, localOffset + 18);
        }
      } else {
        const extra = zip64 ? buildZip64LocalExtra(0, 0) : Buffer.alloc(0);
        const localOffset = offset;
        write(
          buildLocalHeader({
            versionNeeded,
            flags: ZIP_UTF8_FLAG,
            method: entry.method,
            modTime: entry.modTime,
            modDate: entry.modDate,
            nameBytes,
            extra,
          }),
        );

        const integrity = new IntegrityTransform(entry);
        const sink = new FdSink(fd);
        const stages = [];
        const source = sourceCatalog.createEntryStream(entry);
        if (source) stages.push(source);
        if (entry.method === METHOD_DEFLATE) stages.push(zlib.createInflateRaw());
        if (stages.length > 0) {
          stages.push(integrity);
          if (entry.method === METHOD_DEFLATE) stages.push(zlib.createDeflateRaw({ level: 6 }));
          stages.push(sink);
          await pipeline(stages, signal === undefined ? {} : { signal });
        }
        const { size, crc } = integrity.finish();
        const compressedSize = sink.count;
        offset += compressedSize;

        // 回填本地文件头（不使用数据描述符，flag 保持 0x0800）
        if (!zip64 && (size > U32_MAX - 1 || compressedSize > U32_MAX - 1)) {
          throw new Error('条目超过 4GB 但未启用 ZIP64，请重试');
        }
        const header = Buffer.alloc(16);
        header.writeUInt32LE(crc, 0);
        header.writeUInt32LE(zip64 ? U32_MAX : compressedSize, 4);
        header.writeUInt32LE(zip64 ? U32_MAX : size, 8);
        header.writeUInt16LE(ZIP_UTF8_FLAG, 12);
        header.writeUInt16LE(versionNeeded, 14);
        // flags 位于 +6，crc 位于 +14，尺寸位于 +18/+22
        fs.writeSync(fd, header.subarray(0, 4), 0, 4, localOffset + 14);
        fs.writeSync(fd, header.subarray(4, 8), 0, 4, localOffset + 18);
        fs.writeSync(fd, header.subarray(8, 12), 0, 4, localOffset + 22);
        fs.writeSync(fd, header.subarray(12, 14), 0, 2, localOffset + 6);
        fs.writeSync(fd, header.subarray(14, 16), 0, 2, localOffset + 4);
        if (zip64) {
          const extraStart = localOffset + 30 + nameBytes.length;
          const usizeBuf = Buffer.alloc(8);
          usizeBuf.writeBigUInt64LE(BigInt(size));
          const csizeBuf = Buffer.alloc(8);
          csizeBuf.writeBigUInt64LE(BigInt(compressedSize));
          fs.writeSync(fd, usizeBuf, 0, 8, extraStart + 4);
          fs.writeSync(fd, csizeBuf, 0, 8, extraStart + 12);
        }
        records.push({
          nameBytes,
          versionMadeBy: entry.versionMadeBy,
          versionNeeded,
          method: entry.method,
          modTime: entry.modTime,
          modDate: entry.modDate,
          crc,
          compressedSize,
          uncompressedSize: size,
          localHeaderOffset: localOffset,
          internalAttr: entry.internalAttr,
          externalAttr: entry.externalAttr,
          zip64,
        });
      }
      if (onProgress) onProgress(index + 1, plans.length);
    }

    const cdOffset = offset;
    for (const record of records) {
      if (record.zip64) record.extra = buildZip64CentralExtra(record);
      else record.extra = Buffer.alloc(0);
      write(buildCentralHeader(record));
    }
    const cdSize = offset - cdOffset;

    const needsZip64 =
      forceZip64 ||
      records.length > 0xfffe ||
      cdOffset > U32_MAX - 1 ||
      cdSize > U32_MAX - 1 ||
      records.some(
        (r) =>
          r.uncompressedSize > U32_MAX - 1 ||
          r.compressedSize > U32_MAX - 1 ||
          r.localHeaderOffset > U32_MAX - 1,
      );

    if (needsZip64) {
      const zip64EocdOffset = offset;
      const eocd64 = Buffer.alloc(56);
      eocd64.writeUInt32LE(SIG_EOCD64, 0);
      eocd64.writeBigUInt64LE(44n, 4);
      eocd64.writeUInt16LE(45, 12);
      eocd64.writeUInt16LE(45, 14);
      eocd64.writeUInt32LE(0, 16);
      eocd64.writeUInt32LE(0, 20);
      eocd64.writeBigUInt64LE(BigInt(records.length), 24);
      eocd64.writeBigUInt64LE(BigInt(records.length), 32);
      eocd64.writeBigUInt64LE(BigInt(cdSize), 40);
      eocd64.writeBigUInt64LE(BigInt(cdOffset), 48);
      write(eocd64);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(SIG_EOCD64_LOCATOR, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
      locator.writeUInt32LE(1, 16);
      write(locator);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(SIG_EOCD, 0);
      eocd.writeUInt16LE(0, 4);
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(0xffff, 8);
      eocd.writeUInt16LE(0xffff, 10);
      eocd.writeUInt32LE(U32_MAX, 12);
      eocd.writeUInt32LE(U32_MAX, 16);
      eocd.writeUInt16LE(0, 20);
      write(eocd);
    } else {
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(SIG_EOCD, 0);
      eocd.writeUInt16LE(0, 4);
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(records.length, 8);
      eocd.writeUInt16LE(records.length, 10);
      eocd.writeUInt32LE(cdSize, 12);
      eocd.writeUInt32LE(cdOffset, 16);
      eocd.writeUInt16LE(0, 20);
      write(eocd);
    }

    return { entries: records.length, compressedBytes: offset, zip64: needsZip64 };
  } catch (error) {
    fs.closeSync(fd);
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/* ------------------------------------------------------------------ *
 * 回读自检
 * ------------------------------------------------------------------ */

/**
 * 回读校验修复版 ZIP。
 * @param {string} zipPath ZIP 路径
 * @param {{full?: boolean, signal?: AbortSignal}} [options] full=true 时逐条解压校验 CRC
 * @returns {Promise<{entries: number, allUtf8Flag: boolean, zip64: boolean, fullChecked: boolean, warnings: string[]}>}
 */
export async function verifyFixedZip(zipPath, { full = true, signal } = {}) {
  const catalog = openZipCatalog(zipPath);
  try {
    const allUtf8Flag = catalog.entries.every((entry) => (entry.flags & ZIP_UTF8_FLAG) !== 0);
    if (full) {
      for (const entry of catalog.entries) {
        if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
        if (entry.isDirectory) continue;
        await verifyEntry(catalog, entry, { signal });
      }
    }
    return {
      entries: catalog.entries.length,
      allUtf8Flag,
      zip64: catalog.zip64,
      fullChecked: full,
      warnings: [...catalog.warnings],
    };
  } finally {
    catalog.close();
  }
}

/** 计算磁盘文件的 CRC32 与大小（流式）。 */
export async function fileCrc32(filePath, { signal } = {}) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error(`不是普通文件：${filePath}`);
  const hash = crypto.createHash('sha256');
  let crc = 0;
  let size = 0;
  const stream = fs.createReadStream(filePath);
  const collector = new Transform({
    transform(chunk, _enc, callback) {
      size += chunk.length;
      crc = crc32(chunk, crc);
      hash.update(chunk);
      callback();
    },
  });
  await pipeline(stream, collector, new NullSink(), signal === undefined ? {} : { signal });
  return { size, crc: crc >>> 0, sha256: hash.digest('hex') };
}
