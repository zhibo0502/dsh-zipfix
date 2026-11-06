# dsh-zipfix

DeepSeek Harness 插件：修复 ZIP 压缩包与已解压目录中的中文文件名乱码。提供 5 个 agent 工具和一个侧边栏上传面板。

## 功能

- 读取 ZIP 中央目录原始文件名字节，嗅探 UTF-8 / GBK / GB18030 / Big5 编码
- 按正确文件名解压，逐条校验 CRC32；生成置位 UTF-8 文件名标志（0x0800）的修复版 ZIP
- 对 U+FFFD 不可逆乱码，按源包 `(size, CRC32)` 唯一配对还原，并用编码指纹验证
- 5 个工具：`zipfix_scan`、`zipfix_fix_zip`、`zipfix_rename_dir`、`zipfix_match_source`、`zipfix_verify_names`
- 侧边栏「ZIP 修复」：上传 ZIP → 体检 → 下载修复版 ZIP / 按正确文件名解压

## 安装

npm：[`dsh-zipfix`](https://www.npmjs.com/package/dsh-zipfix)（DSH 中执行 `plugin_manager { action: "install_bundle", target: "dsh-zipfix@0.4.0" }`）。

DSH 插件市场（发现 → 添加索引源）：

```text
https://raw.githubusercontent.com/zhibo0502/dsh-zipfix/main/plugin-index.json
```

本地目录安装：

```powershell
plugin_manager { action: "install_bundle", target: "<本目录绝对路径>" }
```

## 安全

- 绝不删除、绝不覆盖源文件；同名目标自动加 `_fixed` 后缀；写操作默认 dry-run
- `/zipfix-api` 所有路由先经 `connection.requestRejection` 宿主认证（fail closed）
- 零运行时依赖，无网络请求

## License

MIT · https://github.com/zhibo0502/dsh-zipfix
