/**
 * dsh-zipfix-ui 的 Host 半：注册侧边栏 UI 使用的 `/zipfix-api` HTTP 接口。
 *
 * 修复逻辑完全复用 `dsh-zipfix` 包的 lib（与 5 个 agent 工具同一套实现），
 * 本包只负责「浏览器上传 → 本机处理 → 下载/解压」的搬运与安全边界。
 */

import { installZipfixWebApi } from '../plugin/lib/webapi.js';

/** Cordis 插件名。 */
export const name = 'dsh-zipfix-ui';

/** 无硬依赖：webServer 缺失时静默降级（不阻塞同仓的 agent 工具包）。 */
export const inject = [];

/**
 * 注册 HTTP API，并随插件卸载释放路由与临时目录。
 * @param {object} ctx Host 插件上下文
 */
export function apply(ctx) {
  ctx.effect(() => installZipfixWebApi(ctx), 'zipfix-ui: web api');
}
