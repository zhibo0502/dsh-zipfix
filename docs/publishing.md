# Publishing

发布物：`dist/dsh-zipfix`（npm 包 `dsh-zipfix`）与 `plugin-index.json`（DSH format 1 插件市场索引）。

## npm

```bash
npm login
cd dist/dsh-zipfix
npm publish --access public
```

验证：

```bash
npm view dsh-zipfix version
pnpm add dsh-zipfix
```

发布后把索引切换到 npm 来源并提交：

```bash
node tools/write-market-index.mjs --source npm --commit "$(git rev-parse HEAD)"
npm run validate:index
git add plugin-index.json && git commit -m "market: switch to npm source" && git push
```

未发布 npm 前，索引使用固定 Git commit（`source.type = "git"` + `path: dist/dsh-zipfix`），同样可安装。

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

- dshopen.org：https://github.com/polang233/dsh-plugin-index/issues/285 （已提交，审核中）
- deepseek1024.com：https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/836 （已自动合并；npm 发布后安装按钮自动出现）
- dsh.market：按 GitHub topic 自动采集，无需提交

## GitHub topics

`deepseek-harness-plugins`、`deepseek-harness`、`deepseek-harness-plugin`、`dsh-plugin`、`dsh-bundle`、`plugin-market`、`zip`、`mojibake`、`gbk`、`filename`、`chinese`、`cordis-plugin`。
