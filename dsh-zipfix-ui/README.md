# dsh-zipfix-ui

DeepSeek Harness Web 侧边栏面板源码：左侧边栏「ZIP 修复」入口，提供上传 ZIP、体检、下载修复版 ZIP、按正确文件名解压的页面，以及同源 `/zipfix-api` 接口。修复逻辑复用 [`dsh-zipfix-plugin`](../dsh-zipfix-plugin/lib/fix.js)，发布用单包见 [`dist/dsh-zipfix`](../dist/dsh-zipfix/README.md)。

## Features

- 上传 ZIP（流式落盘，默认上限 2 GiB）
- 体检：编码、置信度、条目数、冗余顶层目录、U+FFFD 条目、改名样例
- 下载修复版 ZIP（全部条目置位 `0x0800`，回读逐条 CRC32 校验）
- 解压到指定目录（系统目录选择器，逐条 CRC32 校验）
- 审计报告：页面内查看 Markdown / 下载 CSV

## Security

- `/zipfix-api` 所有路由先经 `connection.requestRejection` 宿主认证（fail closed），另有同源 CSRF token
- 上传只落系统临时目录，24 小时自动清理
- 下载/报告只访问本进程登记过的任务，不接受任意路径
- 与 agent 工具一致：不删除、不覆盖源文件

## Development

本包通过相对路径 `../dsh-zipfix-plugin/lib/` 复用修复核心，两个源码目录必须同级。

```powershell
plugin_manager { action: "install_bundle", target: "<仓库目录>/dsh-zipfix-ui" }
```

Host API 的集成测试在仓库 `npm test` 中（上传 → 体检 → 修复 → 下载 → 解压 → 安全边界）。浏览器端仅供 DSH 页面模块加载，无独立构建步骤。

## License

MIT
