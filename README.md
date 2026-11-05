# dsh-zipfix — ZIP 中文文件名乱码修复器（DeepSeek Harness 插件）

修复 ZIP 压缩包与已解压目录中的**中文文件名乱码**（GBK/Big5 文件名未置位 UTF-8 标志位，
在 UTF-8 系统代码页下被误解码为 `╢╖├┼`、`Ö·ÃÅ`、`����` 等），文件内容完好、只修复文件名这一层。

> English: DeepSeek Harness plugins that repair mojibake Chinese filenames in ZIP archives —
> encoding sniffing, CRC-verified extraction, UTF-8-flagged ZIP rebuild, source-archive CRC pairing,
> and encoding-fingerprint verification. No third-party dependencies, no network.

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
- **零依赖**：本地 ZIP/ZIP64 解析、zlib 流式解压、CRC32、各编码编解码全部使用 Node 标准库。

## 快速开始

```powershell
# 安装 Host 工具包（两个目录需保持同级，UI 包通过相对路径复用它）
plugin_manager { action: "install_bundle", target: "<仓库目录>/dsh-zipfix-plugin" }
# 可选：安装侧边栏 UI
plugin_manager { action: "install_bundle", target: "<仓库目录>/dsh-zipfix-ui" }
```

自测（需要 Python 3）：

```powershell
cd dsh-zipfix-plugin
node test/run-tests.mjs
```

## 隐私说明

- 仓库内所有测试夹具均为**程序合成的假数据**，示例项目名已匿名化为「示例」，不含任何真实用户文件内容。
- 独立验收的原始报告包含真实文件清单与哈希，为隐私起见未随仓库发布；本仓库只保留合成夹具与自测。

## License

MIT
