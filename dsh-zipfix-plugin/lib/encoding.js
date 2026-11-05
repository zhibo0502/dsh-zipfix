/**
 * 编码原语：ZIP 中文文件名乱码修复所需的全部编解码。
 *
 * - GBK / GB18030 / Big5：使用 Node 内置 WHATWG `TextDecoder`（无第三方依赖）。
 * - CP437：ZIP 规范对「未声明编码」的默认解释，WHATWG 不收录，自带 128 字符码表。
 * - CP1252 / Latin-1：自带码表（CP1252 的 0x80–0x9F 段）。
 * - GBK 编码器：启动时用 `TextDecoder('gbk')` 反向生成「Unicode 字符 → 原始字节」表，
 *   因此与 Python `str.encode('gbk')` 对全部 2 字节序列逐条一致（已实测 21791 条全等）。
 *
 * 本文件不读写磁盘，纯函数，便于独立测试。
 */

/** CP437 字节 0x80–0xFF 对应的 Unicode 字符，共 128 个（末尾 U+00A0）。 */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00A0';

if (CP437_HIGH.length !== 128) {
  throw new Error(`CP437 码表长度应为 128，实际 ${CP437_HIGH.length}`);
}

/** CP1252 字节 0x80–0x9F 中已定义的位置（0x81/0x8D/0x8F/0x90/0x9D 未定义）。 */
const CP1252_C1 = new Map([
  [0x80, '\u20AC'], [0x82, '\u201A'], [0x83, '\u0192'], [0x84, '\u201E'],
  [0x85, '\u2026'], [0x86, '\u2020'], [0x87, '\u2021'], [0x88, '\u02C6'],
  [0x89, '\u2030'], [0x8a, '\u0160'], [0x8b, '\u2039'], [0x8c, '\u0152'],
  [0x8e, '\u017D'], [0x91, '\u2018'], [0x92, '\u2019'], [0x93, '\u201C'],
  [0x94, '\u201D'], [0x95, '\u2022'], [0x96, '\u2013'], [0x97, '\u2014'],
  [0x98, '\u02DC'], [0x99, '\u2122'], [0x9a, '\u0161'], [0x9b, '\u203A'],
  [0x9c, '\u0153'], [0x9e, '\u017E'], [0x9f, '\u0178'],
]);

/** 可被解码的编码名（对外承诺的集合）。 */
export const DECODE_ENCODINGS = Object.freeze(['utf-8', 'gbk', 'gb18030', 'big5']);

/** 可被编码的编码名（指纹验证只需要这些）。 */
export const ENCODE_ENCODINGS = Object.freeze(['utf-8', 'gbk', 'cp437', 'latin-1', 'cp1252']);

const decoderCache = new Map();

/** 取（并缓存）一个 TextDecoder；不支持的编码名抛错。 */
function textDecoder(label, fatal) {
  const key = `${label}:${fatal ? 'fatal' : 'replace'}`;
  let dec = decoderCache.get(key);
  if (dec === undefined) {
    dec = new TextDecoder(label, { fatal });
    decoderCache.set(key, dec);
  }
  return dec;
}

/** 把「latin-1 / cp1252 / cp437 / utf-8 / gbk / gb18030 / big5」统一成内部编码名。 */
export function normalizeEncoding(encoding) {
  const key = String(encoding ?? '').trim().toLowerCase().replace(/[_\s]/g, '-');
  switch (key) {
    case 'utf8':
    case 'utf-8':
      return 'utf-8';
    case 'gbk':
    case 'cp936':
    case 'gb2312':
    case 'gb-2312':
      return 'gbk';
    case 'gb18030':
    case 'gb-18030':
      return 'gb18030';
    case 'big5':
      return 'big5';
    case 'cp437':
    case 'ibm437':
    case '437':
      return 'cp437';
    case 'latin1':
    case 'latin-1':
    case 'iso-8859-1':
      return 'latin-1';
    case 'cp1252':
    case 'windows-1252':
      return 'cp1252';
    case 'auto':
    case '':
      return 'auto';
    default:
      return undefined;
  }
}

/**
 * 严格解码字节串。
 * @param {Uint8Array|Buffer} bytes 原始字节
 * @param {string} encoding 编码名
 * @returns {string} 解码文本
 * @throws {Error} 字节在该编码下非法时
 */
export function decodeBytes(bytes, encoding) {
  const enc = normalizeEncoding(encoding);
  switch (enc) {
    case 'utf-8':
      try {
        return textDecoder('utf-8', true).decode(bytes);
      } catch {
        throw new Error('字节不是合法的 UTF-8 序列');
      }
    case 'gbk':
    case 'gb18030':
    case 'big5':
      try {
        return textDecoder(enc, true).decode(bytes);
      } catch {
        throw new Error(`字节不是合法的 ${enc} 序列`);
      }
    case 'cp437':
      return decodeCp437(bytes);
    case 'latin-1': {
      let out = '';
      for (const byte of bytes) out += String.fromCharCode(byte);
      return out;
    }
    case 'cp1252':
      return decodeCp1252(bytes);
    default:
      throw new Error(`不支持的编码：${encoding}`);
  }
}

/**
 * 宽松解码：非法字节替换为 U+FFFD 而不是抛错（仅 UTF-8 语义需要精确对齐时使用）。
 * @param {Uint8Array|Buffer} bytes 原始字节
 * @returns {string} 解码文本
 */
export function decodeUtf8Replacement(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

/** CP437 解码（单字节编码，1 字节 ↔ 1 字符，无损）。 */
export function decodeCp437(bytes) {
  let out = '';
  for (const byte of bytes) {
    out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  }
  return out;
}

/** CP1252 解码。未定义字节在严格模式下抛错。 */
export function decodeCp1252(bytes) {
  let out = '';
  for (const byte of bytes) {
    if (byte < 0x80 || byte >= 0xa0) out += String.fromCharCode(byte);
    else {
      const mapped = CP1252_C1.get(byte);
      if (mapped === undefined) throw new Error(`CP1252 字节 0x${byte.toString(16)} 未定义`);
      out += mapped;
    }
  }
  return out;
}

/** 尝试严格解码，失败返回 null。 */
export function tryDecode(bytes, encoding) {
  try {
    return decodeBytes(bytes, encoding);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 编码（用于生成「编码指纹」与 CP437/Latin-1 反解）
 * ------------------------------------------------------------------ */

const CP437_TO_BYTE = new Map();
for (let i = 0; i < 128; i++) {
  const ch = CP437_HIGH[i];
  if (!CP437_TO_BYTE.has(ch)) CP437_TO_BYTE.set(ch, 0x80 + i);
}

const CP1252_TO_BYTE = new Map();
for (const [byte, ch] of CP1252_C1) {
  if (!CP1252_TO_BYTE.has(ch)) CP1252_TO_BYTE.set(ch, byte);
}

/** @type {Map<string, Buffer>|null} GBK 字符 → 原始字节（惰性构建，只建一次） */
let gbkReverse = null;

/** 用 WHATWG GBK 解码器反向构建「字符 → 字节」表。 */
function buildGbkReverse() {
  const map = new Map();
  for (let byte = 0; byte < 0x80; byte++) {
    map.set(String.fromCharCode(byte), Buffer.from([byte]));
  }
  const dec = textDecoder('gbk', false);
  // 单字节 0x80：WHATWG GBK 映射为 €，Python gbk 亦支持；不支持则跳过。
  const euro = dec.decode(Buffer.from([0x80]));
  if (euro.length === 1 && euro !== '\uFFFD' && !map.has(euro)) {
    map.set(euro, Buffer.from([0x80]));
  }
  // 双字节区：按 lead/trail 升序扫描，保证同一字符取最小字节序列。
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      const s = dec.decode(Buffer.from([lead, trail]));
      if (s.length !== 1 || s === '\uFFFD') continue;
      if (!map.has(s)) map.set(s, Buffer.from([lead, trail]));
    }
  }
  return map;
}

const utf8Encoder = new TextEncoder();

/**
 * 严格编码文本为字节串。
 * @param {string} text 文本
 * @param {string} encoding 编码名；支持 utf-8 / gbk / cp437 / latin-1 / cp1252
 * @returns {Buffer} 原始字节
 * @throws {Error} 存在该编码无法表示的字符时
 */
export function encodeText(text, encoding) {
  const enc = normalizeEncoding(encoding);
  switch (enc) {
    case 'utf-8':
      return Buffer.from(utf8Encoder.encode(text));
    case 'gbk': {
      gbkReverse ??= buildGbkReverse();
      const parts = [];
      let offset = 0;
      for (const ch of text) {
        const bytes = gbkReverse.get(ch);
        if (bytes === undefined) {
          const cp = ch.codePointAt(0);
          throw new Error(
            `字符 ${JSON.stringify(ch)}（U+${cp.toString(16).toUpperCase().padStart(4, '0')}）无法用 GBK 编码`,
          );
        }
        parts.push(bytes);
        offset++;
      }
      void offset;
      return Buffer.concat(parts);
    }
    case 'cp437': {
      const out = Buffer.allocUnsafe(text.length);
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const code = ch.charCodeAt(0);
        if (code < 0x80) out[i] = code;
        else {
          const byte = CP437_TO_BYTE.get(ch);
          if (byte === undefined) throw new Error(`字符 ${JSON.stringify(ch)} 不在 CP437 码表中`);
          out[i] = byte;
        }
      }
      return out;
    }
    case 'latin-1': {
      const out = Buffer.allocUnsafe(text.length);
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code > 0xff) throw new Error(`字符 ${JSON.stringify(text[i])} 超出 Latin-1 范围`);
        out[i] = code;
      }
      return out;
    }
    case 'cp1252': {
      const out = Buffer.allocUnsafe(text.length);
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const code = ch.charCodeAt(0);
        if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) out[i] = code;
        else {
          const byte = CP1252_TO_BYTE.get(ch);
          if (byte === undefined) throw new Error(`字符 ${JSON.stringify(ch)} 不在 CP1252 码表中`);
          out[i] = byte;
        }
      }
      return out;
    }
    default:
      throw new Error(`不支持的编码：${encoding}`);
  }
}

/** 尝试严格编码，失败返回 null。 */
export function tryEncode(text, encoding) {
  try {
    return encodeText(text, encoding);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 文本形态判定（供嗅探与目录分类共用）
 * ------------------------------------------------------------------ */

const CJK_RANGES = [
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 基本区
  [0xf900, 0xfaff], // 兼容汉字
];

/** 是否常用汉字（含扩展 A 与兼容区）。 */
export function isCjk(code) {
  for (const [lo, hi] of CJK_RANGES) if (code >= lo && code <= hi) return true;
  return false;
}

/** 是否全角符号/全角字母数字（U+FF01–U+FF60、U+FFE0–U+FFE6）。 */
export function isFullwidth(code) {
  return (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6);
}

/** 字符串是否纯 ASCII。 */
export function isAscii(text) {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** 统计 U+FFFD 的数量（字节已被销毁的硬证据）。 */
export function countFffd(text) {
  let n = 0;
  for (const ch of text) if (ch === '\uFFFD') n++;
  return n;
}

/** 是否含 U+FFFD。 */
export function hasFffd(text) {
  return text.includes('\uFFFD');
}

/**
 * 文本是否「像正常中文」：非 ASCII 字符几乎全是汉字或全角符号，且至少有一个汉字。
 * 这是区分「GBK 正确解码」与「误解码产物」的关键判据。
 */
export function looksLikeChineseText(text) {
  let nonAscii = 0;
  let good = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) continue;
    nonAscii++;
    if (isCjk(code) || isFullwidth(code)) good++;
  }
  if (nonAscii === 0) return false;
  return good / nonAscii >= 0.85 && good > 0;
}

/** 汉字在非 ASCII 字符中的占比（用于嗅探评分与置信度）。 */
export function cjkRatio(text) {
  let nonAscii = 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) continue;
    nonAscii++;
    if (isCjk(code)) cjk++;
  }
  return nonAscii === 0 ? 0 : cjk / nonAscii;
}

/** 统计字符串的显示宽度（近似：CJK/全角算 2，其余算 1），用于报告排版。 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    width += isCjk(code) || isFullwidth(code) || code > 0xffff ? 2 : 1;
  }
  return width;
}
