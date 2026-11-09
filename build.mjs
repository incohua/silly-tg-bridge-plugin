// 构建脚本。产物写入 dist/，dist/ 需要提交。
// 入口不存在时跳过（src/miniapp 之类后续任务才会出现）。
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

// 版本号只有 package.json 一个来源，构建时注入到服务端和扩展（hello 版本比对用）。
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/extension', { recursive: true });

const jobs = [];

// 服务端插件：ESM 单文件。依赖（undici、puppeteer-core 等）全部打进去，
// 因为 ST 不会为插件执行 npm install。banner 里补 require，供打包进来的 CJS 依赖使用。
jobs.push({
  entry: 'src/server/index.ts',
  options: {
    outfile: 'dist/server.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
    },
  },
});

// UI 扩展：浏览器端，ST 以 script 方式加载。
jobs.push({
  entry: 'src/extension/index.ts',
  options: { outfile: 'dist/extension/index.js', platform: 'browser', format: 'iife', target: 'es2022' },
});

// Mini App 外壳：入口由 card-render 任务提供。
jobs.push({
  entry: 'src/miniapp/index.ts',
  options: { outfile: 'dist/miniapp/index.js', platform: 'browser', format: 'iife', target: 'es2022' },
});

for (const { entry, options } of jobs) {
  if (!existsSync(entry)) {
    console.log(`skip  ${entry}（不存在）`);
    continue;
  }
  await build({ entryPoints: [entry], bundle: true, logLevel: 'warning', legalComments: 'none', define: { __SILLY_TG_VERSION__: JSON.stringify(version) }, ...options });
  console.log(`built ${entry} -> ${options.outfile}`);
}

// 静态文件：扩展清单。
cpSync('src/extension/manifest.json', 'dist/extension/manifest.json');
if (existsSync('src/miniapp/static')) cpSync('src/miniapp/static', 'dist/miniapp', { recursive: true });
