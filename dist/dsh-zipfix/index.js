/**
 * dsh-zipfix 发布包（自动生成，请勿直接编辑；改源码后运行 node tools/build-dist.mjs）。
 *
 * 同一行插件同时提供：
 * - 5 个 agent 工具（来自 plugin/index.js）
 * - 侧边栏 UI 使用的 /zipfix-api 上传/修复/下载接口（来自 ui/index.js）
 */

import { apply as applyTools } from './plugin/index.js';
import { apply as applyUi } from './ui/index.js';

export const name = 'dsh-zipfix';
export const inject = ['tools'];

export function apply(ctx) {
  applyTools(ctx);
  applyUi(ctx);
}
