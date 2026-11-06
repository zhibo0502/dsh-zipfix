# 发布到 DeepSeek Harness 的「插件库」

本文说明本仓库的发布物、可用的发布渠道，以及发布后用户如何安装。所有结论都来自当前 DSH 安装包内的
实现（`@deepseek-ai/dsh-plugin-market-index`、`@deepseek-ai/dsh-plugin-market`、`@deepseek-ai/dsh-official-bundles`）。

## 1. 先分清三种「插件库」

| 渠道 | 谁能进入 | 用户如何看到 |
|---|---|---|
| **官方内置插件库**（设置 → 插件里的官方列表 / 发现页官方条目） | 只有随 DSH 安装包编译进去的 `@deepseek-ai/*` bundle（`dsh-official-bundles` 的 `OPTIONAL_BUNDLES` / `ON_DEMAND_BUNDLES`） | 无需配置，离线可见 |
| **官方「插件市场索引」机制**（实验性） | 任何第三方：发布一个 **format 1 索引 JSON**（https 地址），用户在「发现 → 添加索引源」里粘贴 | 打开「实验性插件 → 自定义插件市场」后，在「发现」页浏览 |
| **社区插件市场** | 提交到各社区项目的收录流程（`dshopen.org`、`deepseek1024.com`、`dsh.market` 等）；它们最终也以 format 1 索引 / 目录形式供用户添加 | 添加对应社区索引源后浏览，或用其独立插件页 |

**第三方无法直接写进官方内置列表**：`dsh-official-bundles` 的列表编译在安装包里，改列表必须发新版 DSH。
第三方要「进插件库」，走的是后两种渠道。

## 2. 本仓库的发布物

| 文件 | 作用 |
|---|---|
| [`dist/dsh-zipfix/`](../dist/dsh-zipfix/README.md) | **可发布单包**：`dsh-zipfix`（含 5 个 agent 工具 + 侧边栏 UI + `/zipfix-api`）。由 `tools/build-dist.mjs` 从两个源码包组装，避免 Git 安装只打包子目录导致的缺文件问题 |
| [`plugin-index.json`](../plugin-index.json) | **format 1 插件市场索引**，一个插件条目、Git 安装来源（commit 固定） |
| `tools/build-dist.mjs` | 组装 dist（`--check` 供 CI 校验源码与发布包同步） |
| `tools/write-market-index.mjs` | 生成索引（可切 Git / npm 来源） |
| `tools/validate-index.mjs` | 用 DSH 官方校验器校验索引并核对 dist 一致性 |

发布包版本来自 `dist/dsh-zipfix/package.json`（当前 `0.4.0`），与源码包的 `0.3.1` / `0.1.2` 独立演进；
两者都保留在仓库里，前者面向「插件市场安装」，后者面向本地开发与源码阅读。

## 3. 发布流程（Git 来源，无需 npm 账号）

已完成的仓库内步骤：

```bash
npm run build                          # 生成 dist/dsh-zipfix
git add dist && git commit -m "build: dist bundle"
npm run market:index -- --commit "$(git rev-parse HEAD)"   # 索引固定到含 dist 的提交
npm run validate:index                 # 官方 format 1 校验 + dist 一致性
git add plugin-index.json && git commit -m "market: pin index"
git push
```

索引地址（用户添加到 DSH 的「索引源」）：

```text
https://raw.githubusercontent.com/zhibo0502/dsh-zipfix/main/plugin-index.json
```

> `raw.githubusercontent.com` 会直接返回文件（不重定向），满足插件市场「索引 URL 不能跳转」的要求。
> 如果用 GitHub Pages，请使用 Pages 的最终 URL。

## 4. 用户在 DSH 里安装

1. 插件 → 实验性插件 → 打开 **自定义插件市场**（`@deepseek-ai/dsh-experimental-plugin-market-bundle`）。
2. 发现 → 添加索引源 → 粘贴上面的 `plugin-index.json` 地址。
3. 在「发现」里找到 **ZIP 中文文件名修复器** → 安装（内部会调用
   `plugin_manager.installBundle`，参数形如
   `git+https://github.com/zhibo0502/dsh-zipfix.git#<commit>&path:/dist/dsh-zipfix`）。
4. 重启/刷新后：任意会话出现 5 个 `zipfix_*` 工具，左侧边栏出现「ZIP 修复」入口。

不经过市场、直接本地安装也可以：

```powershell
plugin_manager { action: "install_bundle", target: "<仓库目录>/dist/dsh-zipfix" }
```

## 5. 发布到 npm（推荐，长期升级更顺）

插件市场的 `source.type = "npm"` 依赖 npm 上已发布的包。发布步骤：

```bash
npm login --registry https://registry.npmjs.org/
cd dist/dsh-zipfix
npm publish --access public
```

发布后重新生成索引并切到 npm 来源：

```bash
node tools/write-market-index.mjs --source npm --commit "$(git rev-parse HEAD)"
npm run validate:index
git add plugin-index.json && git commit -m "market: switch to npm source" && git push
```

之后安装目标就是 `dsh-zipfix@<version>`（`marketInstallTarget` 自动生成），升级只需更新索引里的版本列表。

## 6. 提交到社区插件市场

- **dshopen.org（开放插件市场）**：[提交收录申请](https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml)。
  要求公开源码、可安装版本（npm 优先；固定 Git commit 也可，但需维护者确认）与明确许可证。收录后其索引
  `https://dshopen.org/index.json` 会包含本插件。
- **deepseek1024.com（awesome-deepseek-harness-plugins）**：按
  [CONTRIBUTING](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/blob/main/CONTRIBUTING.md)
  在 `catalog/plugins/` 新增一个 JSON（id 用子目录形式 `zhibo0502/dsh-zipfix/dist/dsh-zipfix`），
  非 draft PR 通过静态检查后自动合并；npm 未发布时以「仅仓库安装」展示。
- **dsh.market**：按 GitHub topic 自动采集，仓库加入 `deepseek-harness-plugins`、`dsh-plugin`、`dsh-bundle`
  等 topic 后会被发现（本仓库已加入）。

> 社区市场的收录是外部仓库流程；本仓库只负责提供可安装包、合规索引与元数据。

## 7. GitHub 标签说明

GitHub Topics **不支持空格、大写字母**（会规范化为小写连字符），所以「DeepSeek Harness Plugins」对应：

```text
deepseek-harness-plugins
```

本仓库已加入的 topic：`deepseek-harness-plugins`、`deepseek-harness`、`deepseek-harness-plugin`、`dsh-plugin`、
`dsh-bundle`、`plugin-market`、`zip`、`mojibake`、`gbk`、`filename`、`chinese`、`cordis-plugin`。

## 8. 发布检查清单

```bash
npm ci
npm run lint            # ESLint 0 问题
npm test                # 30 项自动测试
npm run formal          # TLA+/TLC 形式化验证
npm run build:check     # dist 与源码同步
npm run validate:index  # 索引通过 DSH 官方 format 1 校验
cd dist/dsh-zipfix && npm pack --dry-run   # 核对发布内容
```

CI（`.github/workflows/ci.yml`）会执行 lint / test / formal / build:check / validate:index；发布新版本时
记得同步升级 `dist/dsh-zipfix/package.json` 的版本与 `plugin-index.json` 的版本/commit。
