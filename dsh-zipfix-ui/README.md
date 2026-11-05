# dsh-zipfix-ui — ZIP 文件名修复的侧边栏面板

DeepSeek Harness 的 Web UI 插件：在**左侧边栏**加入「ZIP 修复」入口，点开后是完整的上传/体检/修复页面。
Host 半只注册本机 HTTP 接口（`/zipfix-api`），真正修复逻辑 100% 复用同目录的
[`dsh-zipfix`](../dsh-zipfix-plugin/README.md) 包（与 5 个 agent 工具同一套实现，行为一致）。

## 版本

- **0.1.2** — 界面文案与仓库质量门禁对齐（无功能变化）；此前 0.1.1 修复深色主题下主按钮「白底白字」。
- 0.1.1 — 深色主题主按钮文字颜色改用 `--dsw-alias-bg-base`（深色=白钮深字，浅色=品牌钮白字）。
- 0.1.0 — 首个侧边栏 UI：上传 ZIP、编码体检、下载修复版 ZIP、解压到目录、审计报告。

## 功能

1. **拖拽/选择 ZIP 上传**（只收 `.zip`，流式落盘，默认上限 2 GiB）。
2. **自动体检**：编码嗅探（utf-8/gbk/gb18030/big5）、置信度、条目数、冗余顶层目录、
   含 U+FFFD 的不可逆条目、原名字 → 新名字样例。
3. **生成修复版 ZIP 并下载**：全部条目置位 UTF-8 文件名标志 `0x0800`、UTF-8 文件名，
   回读逐条校验 CRC32；浏览器直接下载。
4. **解压到目录…**：调用系统目录选择器，按正确文件名落盘并逐条校验 CRC32；
   审计报告写到 `<输出目录>/_zipfix-reports/`。
5. **审计报告**：可在页面里打开 Markdown 报告或下载 CSV 明细。
6. 判定「无需修复」时默认零改动；按钮会变为「仍要生成修复版 ZIP」显式强制。

## 安全与边界

- 上传文件只落在系统临时目录，任务 24 小时后自动清理；`/cleanup` 可立即清理。
- 变更类 HTTP 请求需要同源页面才能取得的随机 token（CSRF 防护），并校验 `Origin`；
  下载/报告只允许访问本进程登记过的任务，不接受任意路径。
- 页面样式只用主题 token（跟随明暗主题），无第三方 UI 依赖；文案走 Client locale（zh/en）。
- 与 agent 工具一致：永不删除、永不覆盖源 ZIP / 源文件；目标同名自动加 `_fixed`。

## 依赖布局

本包通过相对路径 `../dsh-zipfix-plugin/lib/webapi.js` 复用修复逻辑，因此**两个目录必须放在同一父目录下**：

```
<workspace>/
  dsh-zipfix-plugin/     # 修复核心 + 5 个 agent 工具（Host）
  dsh-zipfix-ui/         # 本包：侧边栏 UI + /zipfix-api（Host + Client）
```

## 安装 / 生效

```powershell
# 安装本 bundle（首装）
plugin_manager { action: "install_bundle", target: "<绝对路径>/dsh-zipfix-ui" }

# 已安装后重新加载
plugin_manager { action: "set_plugin", target: "include:dsh-zipfix-ui", enabled: false }
plugin_manager { action: "set_plugin", target: "include:dsh-zipfix-ui", enabled: true }
```

Client 模块图变化会通过 `/plugins/events` SSE 同步到已打开的页面；若侧边栏没有立即出现
「ZIP 修复」，刷新一次页面即可。卸载：`plugin_manager { action: "remove_bundle", target: "dsh-zipfix-ui" }`。

## 验证状态（2026-11-05，本地实测）

- **仓库级质量门禁**：本包的 Host 半（`/zipfix-api`）已纳入仓库自动测试（`npm test`，30/30 通过）；
  整个仓库通过 ESLint、CI（lint / test / formal 三个 job）与 TLA+/TLC 形式化验证，详见根目录 README。
- **Host HTTP API 全链路独立复核（PowerShell 驱动 + Python 校验）**：
  上传 62 条目 GBK 案例 ZIP → 体检 `status=reversible / encoding=gbk / stripRoot` 正确 →
  `fix` 返回 62 条目、`allUtf8Flag=true`、`fullChecked=true` → 下载修复版 ZIP →
  Python `zipfile`：62 条目全部 `flag & 0x800`、`testzip()=None`、50 个文件内容 CRC32 与源包逐条一致 →
  `extract` 到目录：50 文件 / 11 目录 / 0 失败（冗余顶层目录已剥离）、抽样内容 CRC32 一致；
  Markdown/CSV 报告可在线取回。
- **安全边界实测**：非 ZIP 上传 → 400「缺少 PK 魔数」；缺 token → 403；非白名单 `Origin` → 403；
  `_zipfix-reports/` 报告目录不污染用户文件。
- **客户端半**：包已注册进客户端模块图（`/zipfix-api/selfcheck` 返回 `clientRegistered=true`），
  实际下发的 `client.js` 与磁盘源码内容一致（含最新字典与侧边栏注册代码），`client.js` 通过语法检查、
  不引用任何 Harness Client 包、样式仅用主题 token。
- 本会话无浏览器控制：**侧边栏图标与面板的实际渲染/点击交互未做视觉验证**。
  若发现入口未出现，刷新一次页面（Ctrl+R）即可；仍未出现则重启 DeepSeek Harness。
