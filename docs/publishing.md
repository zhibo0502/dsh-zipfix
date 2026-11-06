# Publishing

发布物：`dist/dsh-zipfix`（npm 包 `dsh-zipfix`）与 `plugin-index.json`（DSH format 1 插件市场索引）。

## npm

当前已发布：**`dsh-zipfix@0.4.0`**（https://www.npmjs.com/package/dsh-zipfix ，`latest`）。

发布新版本：

```bash
# 先更新 dist/dsh-zipfix/package.json 的 version
npm login
cd dist/dsh-zipfix
npm publish --access public
```

验证：

```bash
npm view dsh-zipfix version
pnpm add dsh-zipfix
```

索引使用 npm 来源时无需再固定 commit；升级只需更新索引里的版本列表：

```bash
node tools/write-market-index.mjs --source npm --commit "$(git rev-parse HEAD)"
npm run validate:index
git add plugin-index.json && git commit -m "market: update npm version" && git push
```

> 若 token 只有 `Read and write (stage only)` 权限，需改用 `npm stage publish`，再由维护者用 2FA 审批；首个版本必须用 direct 权限的 token 发布。

## DSH Plugin Market

索引地址：

```text
https://raw.githubusercontent.com/zhibo0502/dsh-zipfix/main/plugin-index.json
```

用户侧：插件 → 实验性插件 → 开启「自定义插件市场」→ 发现 → 添加索引源 → 粘贴上面的地址。

本地/CI 校验：

```bash
npm run build:check
npm run validate:index
cd dist/dsh-zipfix && npm pack --dry-run
```

## Community marketplaces

- dshopen.org：https://github.com/polang233/dsh-plugin-index/issues/285 （已提交，已补充 npm 版本，审核中）
- deepseek1024.com：https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/836 （已自动合并；npm 已发布，安装按钮由目录自动检测，无需再提 PR）
- dsh.market：按 GitHub topic 自动采集，无需提交

## GitHub topics

`deepseek-harness-plugins`、`deepseek-harness`、`deepseek-harness-plugin`、`dsh-plugin`、`dsh-bundle`、`plugin-market`、`zip`、`mojibake`、`gbk`、`filename`、`chinese`、`cordis-plugin`。
