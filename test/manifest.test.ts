import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(join(root, p), 'utf8')) as Record<string, unknown>;

const pkg = readJson('package.json');
const rootManifest = readJson('manifest.json');
const srcManifest = readJson('src/extension/manifest.json');

describe('manifest', () => {
  it('三处版本号一致（package.json、根 manifest、src/extension/manifest.json）', () => {
    expect(rootManifest.version).toBe(pkg.version);
    expect(srcManifest.version).toBe(pkg.version);
  });
  it('根 manifest 的 js 指向构建产物，src 的 manifest 指向同目录的 index.js', () => {
    expect(rootManifest.js).toBe('dist/extension/index.js');
    expect(srcManifest.js).toBe('index.js');
  });
  it('两份 manifest 除 js 外内容一致', () => {
    const { js: _a, ...a } = rootManifest;
    const { js: _b, ...b } = srcManifest;
    expect(a).toEqual(b);
  });
  it('带 auto_update 和 silly_tg 标记（去重靠 silly_tg 识别）', () => {
    for (const m of [rootManifest, srcManifest]) {
      expect(m.auto_update).toBe(true);
      expect(m.silly_tg).toBe(true);
    }
  });
});
