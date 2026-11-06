# dsh-zipfix

[![CI](https://github.com/zhibo0502/dsh-zipfix/actions/workflows/ci.yml/badge.svg)](https://github.com/zhibo0502/dsh-zipfix/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-zipfix.svg)](https://www.npmjs.com/package/dsh-zipfix)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-339933.svg)](https://nodejs.org/)

DeepSeek Harness 插件：修复 ZIP 压缩包与已解压目录中的中文文件名乱码。提供 5 个 agent 工具和一个侧边栏上传面板。

ZIP 里的文件名如果按 GBK/Big5 编码写入却未置位 UTF-8 标志（通用位 bit 11），在 UTF-8 系统代码页下会显示为 `╢╖├┼`、`Ö·ÃÅ`、`����` 等乱码。本插件只修复文件名这一层，文件内容保持原样。

## Features

- 读取 ZIP 中央目录原始文件名字节，嗅探 UTF-8 / GBK / GB18030 / Big5 编码
- 按正确文件名解压，逐条校验 CRC32；生成置位 UTF-8 文件名标志（`0x0800`）的修复版 ZIP
- 已解压目录的形态 A（CP437 / Latin-1 / CP1252 → GBK）批量改名
- U+FFFD 不可逆乱码：按源包 `(size, CRC32)` 唯一配对还原；无源包时用文档内部标题生成候选，并以编码指纹验证
- 侧边栏「ZIP 修复」：上传 ZIP → 体检 → 下载修复版 ZIP 或按正确文件名解压
- 零运行时依赖，无网络请求；不删除、不覆盖源文件

## Packages

| 目录 | 说明 |
|---|---|
| [`dist/dsh-zipfix/`](dist/dsh-zipfix/README.md) | 可发布单包 `dsh-zipfix`（工具 + 侧边栏 UI），由 `tools/build-dist.mjs` 生成 |
| [`dsh-zipfix-plugin/`](dsh-zipfix-plugin/README.md) | 修复核心与 5 个 agent 工具的源码包 |
| [`dsh-zipfix-ui/`](dsh-zipfix-ui/README.md) | 侧边栏 UI 与 `/zipfix-api` 的源码包 |

## Install

npm 包 [`dsh-zipfix`](https://www.npmjs.com/package/dsh-zipfix)（registry.npmjs.org），在 DSH 中安装：

```powershell
plugin_manager { action: "install_bundle", target: "dsh-zipfix@0.4.0" }
```

DSH 插件市场索引（发现 → 添加索引源）：

```text
https://raw.githubusercontent.com/zhibo0502/dsh-zipfix/main/plugin-index.json
```

本地目录安装：

```powershell
plugin_manager { action: "install_bundle", target: "<仓库目录>/dist/dsh-zipfix" }
```

安装后任意会话可用 `zipfix_*` 工具，左侧边栏出现「ZIP 修复」入口。

## Tools

| 工具 | 作用 |
|---|---|
| `zipfix_scan` | 只读体检：编码判定、形态分类、可修复条目、下一步建议 |
| `zipfix_fix_zip` | 解压 + 生成修复版 ZIP；`dryRun` 默认开启，`force` 可强制处理合规包 |
| `zipfix_rename_dir` | 已解压目录形态 A 批量改名 |
| `zipfix_match_source` | 形态 B：按 `(size, CRC32)` 与源 ZIP 唯一配对改名 |
| `zipfix_verify_names` | 内容反推 + 编码指纹验证 |

## Development

```bash
npm ci
npm run lint          # ESLint
npm test              # 30 项自动测试 + dist 冒烟
npm run formal        # TLA+ / TLC 形式化验证
npm run build         # 生成 dist/dsh-zipfix
npm run build:check   # 校验 dist 与源码同步
npm run validate:index  # 用 DSH 官方校验器校验 plugin-index.json
```

CI 执行 lint / test / formal / build:check / validate:index。

## Repository layout

```text
dsh-zipfix-plugin/   # 修复核心 + 5 个工具（源码）
dsh-zipfix-ui/       # 侧边栏 UI + /zipfix-api（源码）
dist/dsh-zipfix/     # 可发布单包（生成物）
plugin-index.json    # DSH 插件市场索引（format 1）
spec/                # TLA+ 规格与 TLC 配置
tools/               # dist 组装、索引生成/校验、TLC 运行器
docs/publishing.md   # 发布说明
```

## Security

- 写操作默认 dry-run；同名目标自动加 `_fixed` 后缀；不删除、不覆盖源文件
- `/zipfix-api` 所有路由先经 `connection.requestRejection` 宿主认证（fail closed），另有同源 CSRF token

## License

MIT
