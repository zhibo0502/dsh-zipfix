/**
 * 编码嗅探与形态分类（对应交接文档 ALG-2 与 §5.1 决策树）。
 *
 * 三种输入：
 * - ZIP 条目：手里有**原始文件名字节**，嗅探是「多候选严格解码 + 中文得分排序」；
 * - 已解压目录：手里是**误解码后的字符串**，只能反解（cp437/latin1 → GBK）；
 * - 含 U+FFFD 的名字：字节已被替换符覆盖，直接判「不可逆」。
 */

import {
  decodeBytes,
  decodeCp437,
  decodeUtf8Replacement,
  encodeText,
  isAscii,
  isCjk,
  looksLikeChineseText,
  cjkRatio,
  countFffd,
  hasFffd,
  normalizeEncoding,
  tryDecode,
  tryEncode,
  DECODE_ENCODINGS,
} from './encoding.js';

/** 编码嗅探的候选顺序（gbk 先于 gb18030，等分时取 gbk）。 */
export const SNIFF_CANDIDATES = Object.freeze(['utf-8', 'gbk', 'gb18030', 'big5']);

/** 形态 A 的反解链：误解码编码 → 目标中文编码。cp437 必须排在 latin-1/cp1252 之前。 */
export const DIR_REVERSE_CHAINS = Object.freeze([
  { from: 'cp437', to: 'gbk' },
  { from: 'cp437', to: 'gb18030' },
  { from: 'latin-1', to: 'gbk' },
  { from: 'latin-1', to: 'gb18030' },
  { from: 'cp1252', to: 'gbk' },
  { from: 'cp1252', to: 'gb18030' },
]);

/** CP437 高位区中「正常文件名几乎不会出现」的字符（字节 0xB0–0xFF），用于可疑度提示。 */
const CP437_DISTINCTIVE = new Set(
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■',
);

/**
 * 高频汉字集合（约 800 字，出自常用字频率表）。
 *
 * 为什么需要它：交接文档指出「条目少时 gbk 与 big5 仅差几十分」是本算法唯一薄弱点。
 * 纯 Unicode 区段打分无法区分「真中文」与「Big5 误解码出来的生僻字」——
 * 二者都落在 U+4E00–U+9FFF。而自然中文里高频字占比极高，随机生僻字几乎为 0，
 * 因此对高频字额外加分，可在短名单上把区分度拉开一个数量级。
 * 该集合只影响候选排序，不改变「严格解码成功」这一硬条件。
 */
const COMMON_HANZI = new Set(
  '的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活尔更别打女变四神总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边死张该交规万取拉格望觉术领共确传师观清今切院让识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始怎呢存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际约示复病息究线似官火断精满支视消越器容照须九增研写称企八功吗包片史委乎查轻易早曾除农找装广显吧阿李标谈吃图念六引历首医局突专费号尽另周较注语仅考落青随选列武红响虽推势参希古众构房半节土投某案黑维革划敌致陈律足态护七兴派孩验责营星够章音跟志底站严巴例防族供效续施留讲型料终答紧黄绝奇察母京段依批群项故按河米围江织害斗双境客纪采举杀攻父苏密低朝友诉止细愿千值仍男钱破网热助倒育属坐帝限船脸职速刻乐否刚威毛状率甚独球般普怕弹校苦创假久错承印晚兰试股拿脑预谁益阳若哪微尼继送急血惊伤素药适波夜省初喜卫源食险待述陆习置居劳财环排福纳欢雷警获模充负云停木游龙树疑层冷洲冲射略范竟句室异激汉村哈策演简卡罪判担州静退既衣您宗积余痛检差富灵协角占配征修皮挥胜降阶审沉坚善妈刘读超免压银买皇养伊怀执副乱抗犯追帮宣佛岁航优怪香著田铁控税左右份穿艺背阵草脚概恶块顿敢守酒岛托央户烈洋哥索胡款靠评版宝座释景顾弟登货互付伯慢欧换闻危忙核暗姐介坏讨丽良序升监临亮露永呼味野架域沙掉括舰鱼杂误湾吉减编楚肯测败屋跑梦散温困剑渐封救贵枪缺楼县尚毫移娘朋画班智亦耳恩短掌恐遗固席松秘谢鲁遇康虑幸均销钟诗藏赶剧票损忽巨炮旧端探湖录叶春乡附吸予礼港雨呀板庭妇归睛饭额含顺输摇招婚脱补谓督毒油疗旅泽材灭逐莫笔亡鲜词圣择寻厂睡博勒烟授诺伦岸奥唐卖俄炸载洛健堂旁宫喝借君禁阴园谋宋避抓荣姑孙逃牙束跳顶玉镇雪午练迫爷篇肉嘴馆遍凡础洞卷坦牛宁纸诸训私庄祖丝翻暴森塔默握戏隐熟骨访弱蒙歌店鬼软典欲萨伙遭盘爸扩盖弄雄稳忘亿刺拥徒姆杨齐赛趣曲刀床迎冰虚玩析窗醒妻透购替塞努休虎扬途侵刑绿迅套贸毕唯谷轮库迹尤竞街促延震弃甲伟麻川申缓潜闪售灯针哲络抵朱埃抱鼓植纯夏忍页杰筑折郑贝尊吴秀混臣雅振染盛怒舞圆搞狂措姓残秋培迷诚宽宇猛摆梅毁伸摩盟末乃悲拍丁赵硬麦蒋操耶阻订彩抽赞魔纷沿喊违妹浪汇币丰蓝殊献桌啦瓦莱援译夺汽烧距裁偏符勇触课敬哭懂墙袭召罚侠厅拜巧侧韩冒债曼融惯享戴童犹乘挂奖绍厚纵障讯涉彻刊丈爆乌役描洗玛患妙镜唱烦签仙彼弗症仿倾牌陷鸟轰咱菜闭奋庆柳',
);

/**
 * 交接文档 ALG-2 的评分函数：越像正常中文，分越高。
 * 在文档基础上增加「高频字」加分，用于解决短名单上 gbk/big5 区分度不足。
 * @param {string[]} names 解码后的名字
 * @returns {number} 得分
 */
export function scoreNames(names) {
  let score = 0;
  for (const name of names) {
    for (const ch of name) {
      const code = ch.codePointAt(0);
      if (code >= 0x4e00 && code <= 0x9fff) {
        score += 3; // 常用汉字
        if (COMMON_HANZI.has(ch)) score += 2; // 高频字：自然中文比例远高于误解码生僻字
      } else if (code < 0x80) score += 1; // ASCII
      else if (code >= 0xff01 && code <= 0xff60) score += 1; // 全角符号
      else if (code >= 0x3400 && code <= 0x4dbf) score += 2; // 扩展 A
      else if (code >= 0x0100 && code <= 0x07ff) score -= 2; // 拉丁扩展/西里尔/阿拉伯（典型误解码产物）
      else if (code >= 0xe000 && code <= 0xf8ff) score -= 6; // 私用区：误解码典型产物
      else if (code >= 0xf900 && code <= 0xfaff) score -= 2; // 兼容汉字：误解码高频出现
      else if (code === 0xfffd) score -= 10; // 替换字符
      else score -= 1;
    }
  }
  return score;
}

/** 名字里是否有「CP437 误解码」的典型字形。 */
export function hasCp437Marker(name) {
  for (const ch of name) if (CP437_DISTINCTIVE.has(ch)) return true;
  return false;
}

/** 名字里是否有 Latin-1 误解码的典型痕迹（C1 控制区或 Ã/Â 系列）。 */
export function hasLatin1Marker(name) {
  if (/[\u0080-\u009f]/.test(name)) return true;
  if (/[ÃÂ][\u0080-\u00bf]/.test(name)) return true;
  return false;
}

/** 名字是否已被二次损坏（锟斤拷型：U+FFFD 的 UTF-8 字节又被当成 GBK 解读）。 */
export function isDoubleMojibake(name) {
  return name.includes('锟斤拷') || name.includes('烫烫烫') || name.includes('屯屯屯');
}

/**
 * 单个名字的形态分类（适用于已解压目录，或 ZIP 解码后的名字复核）。
 * @param {string} name 名字
 * @returns {{form: 'ascii'|'clean'|'A'|'A2'|'irreversible'|'double'|'unknown', fixed?: string, chain?: string, fffd?: number, markers?: string[]}}
 */
export function classifyName(name) {
  const fffd = countFffd(name);
  if (fffd > 0) return { form: 'irreversible', fffd };
  if (isDoubleMojibake(name)) return { form: 'double' };
  if (isAscii(name)) return { form: 'ascii' };
  const reversed = tryReverseName(name);
  if (reversed) {
    const markers = [];
    if (hasCp437Marker(name)) markers.push('cp437-marker');
    if (hasLatin1Marker(name)) markers.push('latin1-marker');
    return { form: reversed.chain.startsWith('cp437') ? 'A' : 'A2', fixed: reversed.fixed, chain: reversed.chain, markers };
  }
  if (cjkRatio(name) >= 0.6) return { form: 'clean' };
  return { form: 'unknown' };
}

/**
 * 形态 A 反解：把误解码字符串还原为原始字节，再按 GBK/GB18030 解码。
 * @param {string} name 误解码名字
 * @param {{chains?: ReadonlyArray<{from: string, to: string}>}} [options]
 * @returns {{fixed: string, chain: string}|null}
 */
export function tryReverseName(name, { chains = DIR_REVERSE_CHAINS } = {}) {
  for (const chain of chains) {
    const bytes = tryEncode(name, chain.from);
    if (bytes === null) continue;
    const candidate = tryDecode(bytes, chain.to);
    if (candidate === null || candidate === name) continue;
    if (!looksLikeChineseText(candidate)) continue;
    // 反解后的非法路径字符由调用方过滤，这里只保证是通顺中文
    return { fixed: candidate, chain: `${chain.from}→${chain.to}` };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * ZIP 条目嗅探
 * ------------------------------------------------------------------ */

function nonAsciiBytes(bytes) {
  for (const byte of bytes) if (byte > 0x7f) return true;
  return false;
}

/**
 * 嗅探一个 ZIP 的条目名编码，并解码全部条目名。
 *
 * 规则（§5.1 + §6.5 ALG-2）：
 * 1. 全部 ASCII → 无需修复；
 * 2. 全部非 ASCII 条目都置位 0x0800 → 已合规；
 * 3. 未置位条目按 utf-8/gbk/gb18030/big5 做严格整组解码，成功率 + 中文得分排序；
 * 4. 最高分是 utf-8 → 名字本身已是 UTF-8，只是漏置位（仍需重建 ZIP）。
 *
 * @param {Array<object>} entries ZipCatalog 条目
 * @param {{encoding?: string}} [options] 强制指定编码（跳过嗅探，仍做解码校验）
 * @returns {{
 *   encoding: string|null,
 *   method: 'empty'|'ascii'|'declared-utf8'|'sniffed'|'forced'|'undecodable',
 *   confidence: 'high'|'medium'|'low',
 *   scores: Record<string, number>,
 *   rejections: Record<string, string>,
 *   nonAsciiEntries: number,
 *   declaredUtf8Entries: number,
 *   names: Array<{entry: object, name: string, lossy: boolean}>,
 *   warnings: string[]
 * }}
 */
export function sniffZipEncoding(entries, { encoding } = {}) {
  const warnings = [];
  const nonAscii = entries.filter((entry) => nonAsciiBytes(entry.nameBytes));
  const declaredUtf8Entries = entries.filter((entry) => entry.utf8Flag).length;
  const forced = normalizeEncoding(encoding);
  const result = {
    encoding: null,
    method: 'empty',
    confidence: 'low',
    scores: {},
    rejections: {},
    nonAsciiEntries: nonAscii.length,
    declaredUtf8Entries,
    names: [],
    warnings,
  };

  const decodeEntries = (enc) => {
    const names = [];
    for (const entry of entries) {
      if (entry.utf8Flag) {
        const declared = tryDecode(entry.nameBytes, 'utf-8');
        if (declared === null) {
          warnings.push(`条目 ${entry.index} 声明 UTF-8 但字节非法，已按替换字符处理`);
          names.push({ entry, name: decodeUtf8Replacement(entry.nameBytes), lossy: true });
        } else {
          names.push({ entry, name: declared, lossy: false });
        }
        continue;
      }
      const decoded = tryDecode(entry.nameBytes, enc);
      if (decoded !== null) names.push({ entry, name: decoded, lossy: false });
      else {
        // 兜底：先试 utf-8，再试 GBK，最后替换字符（保留信息，标记 lossy）
        const fallback = tryDecode(entry.nameBytes, 'utf-8') ?? tryDecode(entry.nameBytes, 'gbk');
        if (fallback === null) {
          names.push({ entry, name: decodeUtf8Replacement(entry.nameBytes), lossy: true });
          warnings.push(`条目 ${entry.index} 无法按 ${enc} 解码，已使用替换字符`);
        } else {
          names.push({ entry, name: fallback, lossy: true });
          warnings.push(`条目 ${entry.index} 无法按 ${enc} 解码，已回退 UTF-8/GBK`);
        }
      }
    }
    return names;
  };

  if (entries.length === 0) {
    result.method = 'empty';
    result.names = [];
    return result;
  }

  if (nonAscii.length === 0) {
    result.encoding = 'ascii';
    result.method = 'ascii';
    result.confidence = 'high';
    result.names = decodeEntries('latin-1');
    return result;
  }

  if (forced !== undefined && forced !== 'auto' && DECODE_ENCODINGS.includes(forced)) {
    result.encoding = forced;
    result.method = 'forced';
    result.confidence = 'high';
    result.names = decodeEntries(forced);
    return result;
  }

  const undeclared = nonAscii.filter((entry) => !entry.utf8Flag);
  if (undeclared.length === 0) {
    result.encoding = 'utf-8';
    result.method = 'declared-utf8';
    result.confidence = 'high';
    result.names = decodeEntries('utf-8');
    return result;
  }

  const rawList = undeclared.map((entry) => entry.nameBytes);
  /** @type {Array<{encoding: string, score: number, names: string[]}>} */
  const viable = [];
  for (const candidate of SNIFF_CANDIDATES) {
    const decoded = [];
    let ok = true;
    for (const bytes of rawList) {
      const text = tryDecode(bytes, candidate);
      if (text === null) {
        ok = false;
        result.rejections[candidate] = '存在非法字节序列，整组解码失败';
        break;
      }
      decoded.push(text);
    }
    if (!ok) continue;
    const score = scoreNames(decoded);
    result.scores[candidate] = score;
    viable.push({ encoding: candidate, score, names: decoded });
  }

  if (viable.length === 0) {
    result.method = 'undecodable';
    result.encoding = null;
    result.names = decodeEntries('latin-1');
    warnings.push('所有候选编码都无法严格解码文件名，可能需要人工指定 encoding（如 shift_jis）');
    return result;
  }

  const utf8 = viable.find((item) => item.encoding === 'utf-8');
  if (utf8 !== undefined) {
    result.encoding = 'utf-8';
    result.method = 'sniffed';
    result.confidence = 'high';
    result.names = decodeEntries('utf-8');
    return result;
  }

  // gbk 与 gb18030 得分通常相同：按候选顺序稳定取 gbk。
  let best = viable[0];
  for (const item of viable) if (item.score > best.score) best = item;
  // 同名次时优先 gbk（SNIFF_CANDIDATES 顺序已隐含，此处仅作显式保证）
  if (best.encoding === 'gb18030' && result.scores.gbk === best.score) {
    best = viable.find((item) => item.encoding === 'gbk') ?? best;
  }

  const others = viable.filter((item) => {
    if (item.encoding === best.encoding) return false;
    // gbk 是 gb18030 的子集，二者得分相同属正常现象，不作为区分度参考
    if (best.encoding === 'gbk' && item.encoding === 'gb18030') return false;
    if (best.encoding === 'gb18030' && item.encoding === 'gbk') return false;
    return true;
  });
  const runnerUp = others.reduce((max, item) => (item.score > max ? item.score : max), -Infinity);
  const ratio = runnerUp <= 0 ? Number.POSITIVE_INFINITY : best.score / runnerUp;
  let confidence = 'low';
  if (best.score > 0 && ratio >= 1.4) confidence = 'high';
  else if (best.score > 0 && ratio >= 1.1) confidence = 'medium';
  if (rawList.length < 3 && confidence !== 'low') {
    // 条目很少时区分度低（案例 3：gbk 与 big5 仅差 33 分），主动降级并提示复核
    confidence = confidence === 'high' ? 'medium' : 'low';
    warnings.push('非 ASCII 条目少于 3 个，编码判定置信度有限，建议人工复核或显式指定 encoding');
  }

  result.encoding = best.encoding;
  result.method = 'sniffed';
  result.confidence = confidence;
  result.names = decodeEntries(best.encoding);
  return result;
}

/* ------------------------------------------------------------------ *
 * 路径安全与顶层目录剥离
 * ------------------------------------------------------------------ */

/** Windows 非法文件名字符（不含路径分隔符，路径分隔符单独处理）。 */
const ILLEGAL_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/g;
/** Windows 保留设备名（不能作为文件名主干）。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 单个路径段的 Windows 安全化：替换非法字符、去掉尾部点/空格、规避保留设备名。
 * @param {string} segment 原始路径段
 * @returns {string} 可落盘的路径段
 */
export function sanitizePathSegment(segment) {
  let result = segment.replace(ILLEGAL_NAME_CHARS, '_');
  result = result.replace(/[. ]+$/g, '');
  if (result.length === 0) result = '_';
  if (WINDOWS_RESERVED.test(result)) result = `_${result}`;
  return result;
}

/**
 * 规范化 ZIP 条目名：统一分隔符、剔除危险路径段、替换非法字符。
 * @param {string} raw 解码后的条目名
 * @returns {{safe: boolean, name: string, reason?: string}}
 */
export function sanitizeEntryName(raw) {
  let name = raw.replace(/\\/g, '/');
  if (name.length === 0) return { safe: false, name, reason: '空文件名' };
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    return { safe: false, name, reason: '绝对路径条目（ZIP Slip 风险）' };
  }
  const segments = name.split('/');
  const cleaned = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { safe: false, name, reason: '含 .. 路径段（ZIP Slip 风险）' };
    cleaned.push(sanitizePathSegment(segment));
  }
  if (cleaned.length === 0) return { safe: false, name, reason: '规范化后为空' };
  const isDir = name.endsWith('/');
  const joined = cleaned.join('/');
  return { safe: true, name: isDir ? `${joined}/` : joined };
}

/**
 * 检测 ZIP 是否把所有条目都包在与 ZIP 同名的顶层目录里（常见于「压缩为 ZIP」）。
 * @param {Array<{name: string}>} names 解码后的条目名
 * @param {string} zipPath ZIP 路径
 * @returns {string} 需要剥离的前缀（含末尾 '/'），无则空串
 */
export function detectRedundantRoot(names, zipPath) {
  const base = zipPath.replace(/[\\/]/g, '/').split('/').pop() ?? '';
  const stem = base.replace(/\.zip$/i, '');
  if (stem.length === 0) return '';
  const prefix = `${stem}/`;
  const nonEmpty = names.filter((item) => item.name.length > 0);
  if (nonEmpty.length === 0) return '';
  return nonEmpty.every((item) => item.name === prefix || item.name.startsWith(prefix)) ? prefix : '';
}

/**
 * 判断条目解码后是否「仍然可疑」：含替换字符、CP437/Latin-1 痕迹、二次损坏。
 * @param {string} name 名字
 * @returns {string[]} 命中的可疑标记
 */
export function suspicionMarkers(name) {
  const markers = [];
  if (hasFffd(name)) markers.push('U+FFFD');
  if (hasCp437Marker(name)) markers.push('CP437 框线字符');
  if (hasLatin1Marker(name)) markers.push('Latin-1 高位字符');
  if (isDoubleMojibake(name)) markers.push('二次损坏（锟斤拷）');
  return markers;
}

/**
 * 汇总一组名字的形态计数。
 * @param {Array<{name: string}>} names 名字列表
 * @returns {{ascii: number, clean: number, reversibleA: number, reversibleA2: number, irreversible: number, double: number, unknown: number}}
 */
export function summarizeForms(names) {
  const stats = { ascii: 0, clean: 0, reversibleA: 0, reversibleA2: 0, irreversible: 0, double: 0, unknown: 0 };
  for (const item of names) {
    const form = item.form ?? classifyName(item.name).form;
    switch (form) {
      case 'ascii':
        stats.ascii++;
        break;
      case 'clean':
        stats.clean++;
        break;
      case 'A':
        stats.reversibleA++;
        break;
      case 'A2':
        stats.reversibleA2++;
        break;
      case 'irreversible':
        stats.irreversible++;
        break;
      case 'double':
        stats.double++;
        break;
      default:
        stats.unknown++;
        break;
    }
  }
  return stats;
}

/** 让 CP437 解码一份字节（供测试与报告展示）。 */
export { decodeCp437, decodeBytes, encodeText };
