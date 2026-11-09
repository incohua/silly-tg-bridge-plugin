// SillyTavern 服务端插件入口。ST 的插件加载器要求导出 info、init，可选 exit。
// 任何错误都在这里吞掉并记日志，不能让 ST 因为本插件起不来。
// init 在外壳就绪（路由注册、UI 扩展部署）后立即返回，运行时在后台加载，Telegram 不通也不拖慢 ST 启动。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Router } from 'express';
import { createLogger } from './logger';
import { redactError } from './redact';
import { bootPlugin, type PluginShell } from './plugin';

export const info = {
  id: 'silly-tg',
  name: 'Silly TG',
  description: '在 Telegram 里与 SillyTavern / Luker 对话（Bot、无头浏览器、Mini App）。',
};

let shell: PluginShell | null = null;

export async function init(router: Router): Promise<void> {
  try {
    // dist/server.mjs 的上一级就是插件根目录。
    const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    shell = await bootPlugin({ router, pluginDir });
  } catch (e) {
    createLogger().error(`启动失败，插件已禁用：${redactError(e)}`);
  }
}

export async function exit(): Promise<void> {
  try {
    await shell?.stop();
  } catch (e) {
    createLogger().error(`退出出错：${redactError(e)}`);
  }
  shell = null;
}
