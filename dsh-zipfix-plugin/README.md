# dsh-zipfix-plugin

DeepSeek Harness 的 Host 插件源码：ZIP 中文文件名乱码修复核心 + 5 个 agent 工具。发布用单包见 [`dist/dsh-zipfix`](../dist/dsh-zipfix/README.md)。

## Tools

| 工具 | 作用 |
|---|---|
| `zipfix_scan` | 只读体检：ZIP/目录的乱码形态、编码判定、置信度、可修复数量、下一步建议 |
| `zipfix_fix_zip` | 按正确编码解压（逐条 CRC32 校验）+ 生成置位 `0x0800` 的修复版 ZIP；`dryRun` 默认开启 |
| `zipfix_rename_dir` | 已解压目录形态 A 批量改名（cp437/latin-1 → GBK） |
| `zipfix_match_source` | 形态 B：按 `(size, CRC32)` 与源 ZIP 唯一配对改名，唯一命中才动 |
| `zipfix_verify_names` | 内容反推 + 编码指纹验证；只标记已验证候选，不改文件 |

## Usage

直接用自然语言描述问题即可，例如：

> 这个 ZIP 解压出来文件名全是乱码，帮我看看是什么问题，然后修好，再生成一个别人拿去也不会乱码的 ZIP。
> `<目录>/项目资料.zip`

> 这个文件夹的文件名已经是 `�` 了，源压缩包还在，帮我按内容配对改回来。
> 目录：`<目录>/受损项目`；源包：`<目录>/源包.zip`

所有写操作默认 dry-run；确认后再传 `dryRun=false`。审计报告写在 `<目标目录>/_zipfix-reports/`（Markdown + CSV）。

## Implementation

```
index.js        # 工具定义
lib/encoding.js # GBK/GB18030/Big5/CP437/CP1252/Latin-1 编解码
lib/zip.js      # ZIP/ZIP64 解析、流式解压 + CRC 校验、修复版 ZIP 写出与回读
lib/detect.js   # 编码嗅探、形态分类、路径安全化
lib/fix.js      # 解压、目录改名、源包配对、指纹验证、OOXML 标题抽取
lib/report.js   # 审计报告
lib/webapi.js   # /zipfix-api（侧边栏 UI 使用）
```

## Development

```bash
npm test              # 30 项测试（需要 Python 3；ZIPFIX_PYTHON 可指定解释器）
node test/run-tests.mjs
```

仓库级检查（`npm run lint` / `npm run formal` / `npm run build:check`）见根目录 [README](../README.md)。

## Limitations

- U+FFFD 字节不可逆，只能源包配对或内容反推验证；不猜名字
- 编码嗅探为启发式，可用 `encoding` 参数强制指定
- 仅支持 ZIP；加密、分卷、非 deflate 条目会明确报错

## License

MIT
