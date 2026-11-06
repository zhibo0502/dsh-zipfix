# dsh-zipfix（发布包）

DeepSeek Harness 的 ZIP 中文文件名乱码修复插件：5 个 agent 工具 + 侧边栏「ZIP 修复」上传面板。
本目录由 `tools/build-dist.mjs` 从仓库源码自动生成，请不要直接编辑。

- 源码仓库：https://github.com/zhibo0502/dsh-zipfix
- 许可证：MIT

## 安装

推荐在 DSH 的插件市场（发现 → 添加索引源：
`https://raw.githubusercontent.com/zhibo0502/dsh-zipfix/main/plugin-index.json`）里安装；
也可以直接使用本目录：

```powershell
plugin_manager { action: "install_bundle", target: "<本目录绝对路径>" }
```

安装后在任意会话中可用 `zipfix_scan` / `zipfix_fix_zip` / `zipfix_rename_dir` /
`zipfix_match_source` / `zipfix_verify_names` 五个工具，左侧边栏出现「ZIP 修复」入口。
