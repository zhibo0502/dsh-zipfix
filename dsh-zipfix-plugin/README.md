# dsh-zipfix — ZIP 中文文件名乱码修复器（DeepSeek Harness 插件）

修复 ZIP 压缩包与已解压目录里的**中文文件名乱码**：打包方把 GBK/Big5 文件名写进 ZIP 却未置位
「UTF-8 文件名标志（通用位 bit 11）」，在 UTF-8 系统代码页（Windows 的 `ACP=65001`、macOS/Linux）
或部分工具下就会被解成 `╢╖├┼`、`Ö·ÃÅ`、`����` 之类的乱码——文件内容完好，只有文件名这一层坏了。

> English: A DeepSeek Harness plugin that repairs mojibake Chinese ZIP entry names. It reads raw
> central-directory filename bytes, sniffs the original encoding, extracts with correct names and
> per-entry CRC32 verification, rebuilds a UTF-8-flagged ZIP, pairs U+FFFD-damaged files against a
> source archive by `(size, CRC32)`, and verifies reconstructed names by an encoding fingerprint.

本仓库包含两个可独立安装的 bundle：

| 包 | 形态 | 提供 |
|---|---|---|
| `dsh-zipfix-plugin` | Host 插件 | 5 个 agent 可调用工具（`zipfix_*`） |
| `dsh-zipfix-ui` | Host + Web Client 插件 | 左侧边栏「ZIP 修复」入口、上传/体检/修复/下载页面、同源 `/zipfix-api` 接口 |

## 特性

- 纯 Node 标准库实现：本地 ZIP/ZIP64 解析、zlib 流式解压/重压缩、CRC32、GBK/GB18030/Big5/CP437/CP1252/Latin-1 编解码，**零第三方依赖、不联网**。
- **读取中央目录原始文件名字节**做编码嗅探（utf-8/gbk/gb18030/big5 严格解码 + 中文得分排序 + 高频字加权），不依赖任何库的预解码。
- 形态 A（可逆）：`乱码字符串.encode(cp437|latin-1|cp1252).decode(gbk|gb18030)` 无损还原。
- 形态 B（含 `U+FFFD`，字节已销毁）：**不猜名字**。优先用源 ZIP 的 `(size, CRC32)` 唯一配对；无源包时从
  `.docx/.xlsx/.pptx/.pdf` 抽取内部标题生成候选，再用「候选名 GBK 编码 → UTF-8 替换解码」的**编码指纹**逐字符验证。
- 修复版 ZIP 显式置位 `0x0800`、用 UTF-8 写文件名，并在写出后回读逐条校验 CRC32——Windows 资源管理器 / 7-Zip 直接正常显示。
- 安全红线：永不删除、永不覆盖源 ZIP/源文件；目标同名自动加 `_fixed` 序号；所有写操作默认 dry-run；每次写操作产出 Markdown + CSV 审计报告（写到 `<目标>/_zipfix-reports/`）。

## 安装

两个包通过本地目录作为 bundle 安装（UI 包通过相对路径复用工具包的修复核心，**两个目录必须保持同级**）：

```text
<仓库目录>/
  dsh-zipfix-plugin/
  dsh-zipfix-ui/
```

```powershell
# 1) 安装 5 个 agent 工具
plugin_manager { action: "install_bundle", target: "<仓库目录>/dsh-zipfix-plugin" }

# 2) 安装侧边栏 UI（可选）
plugin_manager { action: "install_bundle", target: "<仓库目录>/dsh-zipfix-ui" }

# 卸载
plugin_manager { action: "remove_bundle", target: "dsh-zipfix" }
plugin_manager { action: "remove_bundle", target: "dsh-zipfix-ui" }
```

> 需要 DeepSeek Harness 的 profile 环境（Cordis Loader + `plugin_manager` 工具）。
> UI 包安装后，浏览器端模块图热同步可能需要刷新一次页面；若侧边栏没有出现，刷新页面或重启 Harness。

## 用法

### 1. Agent 工具（自然语言即可）

| 工具 | 作用 |
|---|---|
| `zipfix_scan` | 只读体检：ZIP/目录的乱码形态、编码判定、置信度、可修复数量、下一步建议 |
| `zipfix_fix_zip` | 按正确编码解压（逐条 CRC32 校验）+ 生成置位 `0x0800` 的修复版 ZIP；判定「无需修复」时零改动，`force` 可强制 |
| `zipfix_rename_dir` | 已解压目录形态 A 批量改名（cp437/latin-1 → GBK，自底向上，含嵌套） |
| `zipfix_match_source` | 形态 B 最优解：按 `(size, CRC32)` 与源 ZIP 唯一配对改名，唯一命中才动 |
| `zipfix_verify_names` | 内容反推 + 编码指纹验证；只标记「已验证」的候选名，不改文件 |

样例：

> 这个 ZIP 解压出来文件名全是乱码，帮我看看是什么问题，然后修好，再生成一个别人拿去也不会乱码的 ZIP。
> `<你的目录>/项目资料.zip`

> 这个文件夹里的文件名已经是 `�` 了，源压缩包还在，帮我按内容配对改回来。
> 目录：`<你的目录>/受损项目`；源包：`<你的目录>/源包.zip`

### 2. 侧边栏 UI

安装 `dsh-zipfix-ui` 后，左侧边栏出现 **「ZIP 修复」**：拖拽/选择 ZIP → 自动体检（编码/置信度/条目数/不可逆条目/改名样例）→
**生成修复版 ZIP 并下载** 或 **解压到目录**（系统目录选择器，逐条 CRC32 校验）；报告可在页面打开或下载 CSV。

## 实现要点

- `lib/encoding.js`：WHATWG `TextDecoder` 负责 GBK/GB18030/Big5；CP437/CP1252 自带码表；GBK 编码器由解码器反向生成「字符→字节」表（与 Python `encode('gbk')` 对全部 2 字节序列一致）。
- `lib/zip.js`：手写 ZIP/ZIP64 中央目录解析（保留原始文件名字节）、流式解压 + CRC 校验、修复版 ZIP 写出（回填本地头、不使用数据描述符）与回读自检。
- `lib/detect.js`：编码嗅探打分与形态分类（A/A2/不可逆/二次损坏）、路径安全化（ZIP Slip / Windows 非法字符 / 保留设备名）。
- `lib/fix.js`：解压、目录改名、源包 CRC 配对、指纹验证、OOXML 标题抽取；所有落盘操作带 dry-run 与冲突后缀。
- `lib/report.js`：Markdown + CSV 审计报告。
- `lib/webapi.js` + `dsh-zipfix-ui`：`/zipfix-api` 上传/修复/下载接口与侧边栏页面（同源 token + Origin/Host 校验，2 GiB 上传上限，临时目录 24h 清理）。

## 自测与 CI

```powershell
# 仓库根目录（推荐，自动带上仓库级 lint/formal 脚本）
npm test

# 或只跑本包自测（需要 Python 3；ZIPFIX_PYTHON 可指定解释器）
cd dsh-zipfix-plugin
node test/run-tests.mjs
```

覆盖：62 条目 GBK 案例（冗余顶层目录剥离、50 文件逐条 CRC32、修复版 ZIP 全 `0x800` 回读）、`flag=0x0008`、
合规 UTF-8 / ASCII（无需修复零改动）、形态 A/A2 目录改名（含嵌套）、源包 CRC 配对、纯 `U+FFFD` 不擅自改名、
指纹与 Python 逐字符一致、OOXML 标题抽取、ZIP64 重建、目标已存在绝不覆盖、审计报告路径与目录隔离，
以及 `/zipfix-api` 的「上传 → 体检 → 生成修复版 ZIP → 下载回读校验」「解压到目录 + 安全边界」集成测试。

当前 **30/30 通过**。仓库中的测试夹具全部为**合成数据**，文件名使用中性占位（项目资料 / 合同文件 / 预算清单 / 图纸等），
不含任何真实用户文件内容。

仓库级质量门禁（ESLint、CI 三 job、TLA+/TLC 形式化验证）见根目录 [README](../README.md)；形式化规格见 [`spec/`](../spec/README.md)。

## 验证与限制

- 另有独立黑盒验收（自建 Python 夹具 + 工具端到端 + Python 独立复核）：核心场景与安全红线全部通过；
  原始验收报告包含真实文件清单与哈希，为隐私起见**不随仓库发布**。
- 已知限制：`U+FFFD` 字节级不可逆（只能源包配对或内容反推验证）；编码嗅探为启发式，短名单上 GBK/Big5 可能接近，
  可用 `encoding` 参数强制；仅支持 ZIP（RAR/7z 请先转换）；加密/分卷/非 deflate 压缩条目明确报错；
  T11 只读目录、T14 中断恢复未做破坏性测试；T13 仅覆盖 ZIP64 结构层（未测真实 4GB+ 数据量）。
- 插件用 Node `fs` 直接写文件（不受 Harness fs 沙箱约束），请只对明确目标路径使用；所有落盘操作默认 dry-run 且绝不覆盖。

## License

MIT
