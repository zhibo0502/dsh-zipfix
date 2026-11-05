# dsh-zipfix — ZIP 中文文件名乱码修复器（DeepSeek Harness 插件）

[![CI](https://github.com/zhibo0502/dsh-zipfix/actions/workflows/ci.yml/badge.svg)](https://github.com/zhibo0502/dsh-zipfix/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-339933.svg)](https://nodejs.org/)
[![Formal](https://img.shields.io/badge/formal%20verification-TLA%2B%20%2F%20TLC-1f6feb.svg)](spec/README.md)

修复 ZIP 压缩包与已解压目录中的**中文文件名乱码**（GBK/Big5 文件名未置位 UTF-8 标志位，
在 UTF-8 系统代码页下被误解码为 `╢╖├┼`、`Ö·ÃÅ`、`����` 等），文件内容完好、只修复文件名这一层。

> English: DeepSeek Harness plugins that repair mojibake Chinese filenames in ZIP archives —
> encoding sniffing, CRC-verified extraction, UTF-8-flagged ZIP rebuild, source-archive CRC pairing,
> and encoding-fingerprint verification. Linted, tested, and formally verified with TLA+/TLC.

## 仓库内容

| 包 | 形态 | 提供 |
|---|---|---|
| [`dsh-zipfix-plugin/`](dsh-zipfix-plugin/README.md) | Host 插件 | 5 个 agent 工具：`zipfix_scan` / `zipfix_fix_zip` / `zipfix_rename_dir` / `zipfix_match_source` / `zipfix_verify_names` |
| [`dsh-zipfix-ui/`](dsh-zipfix-ui/README.md) | Host + Web Client 插件 | 左侧边栏「ZIP 修复」入口、上传/体检/修复/下载页面、同源 `/zipfix-api` 接口 |

## 能力概览

- **编码嗅探**：读取 ZIP 中央目录**原始文件名**字节，按 utf-8 / gbk / gb18030 / big5 严格解码打分，给出判定与置信度。
- **形态 A（可逆）**：`乱码.encode(cp437|latin-1|cp1252).decode(gbk|gb18030)` 无损还原。
- **形态 B（含 U+FFFD 不可逆）**：不猜名字——源 ZIP 按 `(size, CRC32)` 唯一配对；无源包时用文档内部标题生成候选，
  再以「GBK 编码 → UTF-8 替换解码」的编码指纹逐字符验证。
- **修复版 ZIP**：全部条目置位 UTF-8 文件名标志 `0x0800`，写出后回读逐条校验 CRC32。
- **安全**：永不删除/覆盖源文件；同名自动加 `_fixed`；写操作默认 dry-run；审计报告（Markdown + CSV）。
- **零运行时依赖**：本地 ZIP/ZIP64 解析、zlib 流式解压、CRC32、各编码编解码全部使用 Node 标准库。

## 快速开始

```powershell
# 安装 Host 工具包（两个目录需保持同级，UI 包通过相对路径复用它）
plugin_manager { action: "install_bundle", target: "<仓库目录>/dsh-zipfix-plugin" }
# 可选：安装侧边栏 UI
plugin_manager { action: "install_bundle", target: "<仓库目录>/dsh-zipfix-ui" }
```

## 质量门禁

| 门禁 | 本地命令 | 内容 |
|---|---|---|
| 静态检查 | `npm run lint` | ESLint 9 flat config，覆盖两个包全部 JS + 测试；`--max-warnings=0` |
| 自动化测试 | `npm test` | 30 项 Node 断言：Python 独立编码器生成的合成夹具（62 条目 GBK / flag=0x0008 / CP437 / Latin-1 / U+FFFD / OOXML 标题 / ZIP64 / 不覆盖），以及 `/zipfix-api` 上传→体检→修复→下载→解压→安全边界集成测试 |
| 形式化验证 | `npm run formal` | TLA+ 规格 + TLC 模型检查（见下） |
| CI | `.github/workflows/ci.yml` | `lint` / `test`（Node 22 + Python 3.12）/ `formal`（Java 21 + TLC）三个 job |

### 形式化验证（TLA+ / TLC）

[`spec/`](spec/README.md) 用 TLA+ 对两条核心安全性质建模，并由 TLC 穷尽检查：

- **FixSafety**：修复流水线（Sniff → Plan → Extract/Write → Rebuild → Verify）满足
  `SourceIntact`（源包不变）、`NoOverwrite`（已存在目标不被替换）、`DryRunPure`（dry-run 不写）、
  `NoUfffdGuess`（U+FFFD 未经指纹验证不改名）、`AllFixedUtf8Flagged`（修复版 ZIP 全部置位 0x0800 才完成）。
- **Pairing**：按 `(size, CRC32)` 与源 ZIP 唯一配对，满足 `Injective`（一个目标名最多一个文件）、
  `AmbiguousUnassigned`（歧义不分配）、`FingerprintRequired`（无指纹匹配不改名）。

运行器 [`tools/tla-run.mjs`](tools/tla-run.mjs) 会自动定位 Java 与 `tla2tools.jar`（带 SHA-256 校验），
逐份 `.cfg` 运行 TLC 并在非 `No error has been found.` 时失败。

## 隐私说明

- 仓库内所有测试夹具均为**程序合成的假数据**，文件名使用中性占位（项目资料 / 合同文件 / 预算清单 / 图纸等），
  不含任何真实用户文件、真实项目名或压缩包内容。
- 独立验收的原始报告包含真实文件清单与哈希，为隐私起见未随仓库发布。

## 目录结构

```text
README.md
LICENSE
package.json            # 仓库工具（lint / test / formal）
eslint.config.js
.github/workflows/ci.yml
dsh-zipfix-plugin/      # Host 工具包（5 个工具 + 修复核心 + 自测）
dsh-zipfix-ui/          # 侧边栏 UI 包（Host API + Web Client）
spec/                   # TLA+ 规格与 TLC 配置
tools/tla-run.mjs       # TLC 运行器（CI 与本地共用）
```

## License

MIT
