import { describe, expect, it } from 'vitest';
import { diagnoseBrowserError, type DiagnoseContext } from '../src/server/browser-diagnose';

const linux: DiagnoseContext = { platform: 'linux', isRoot: false, chromiumPath: '/usr/bin/chromium' };

describe('diagnoseBrowserError', () => {
  it('沙箱不可用：提示 PUPPETEER_DANGEROUS_NO_SANDBOX', () => {
    const samples = [
      'Failed to launch the browser process!\n[FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! Update your kernel',
      'Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted',
      'FATAL:setuid_sandbox_host.cc: The SUID sandbox helper binary was found, but is not configured correctly',
    ];
    for (const m of samples) {
      const d = diagnoseBrowserError(m, linux);
      expect(d?.kind, m).toBe('sandbox');
      expect(d?.hint).toContain('PUPPETEER_DANGEROUS_NO_SANDBOX=true');
    }
  });

  it('root 且没有 --no-sandbox', () => {
    const d = diagnoseBrowserError('Running as root without --no-sandbox is not supported. See https://crbug.com/638180.', { ...linux, isRoot: true });
    expect(d?.kind).toBe('root');
    expect(d?.hint).toContain('PUPPETEER_DANGEROUS_NO_SANDBOX=true');
  });

  it('缺系统库', () => {
    const d = diagnoseBrowserError('/usr/bin/chromium: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory', linux);
    expect(d?.kind).toBe('missing-libs');
    expect(d?.hint).toMatch(/apt install chromium/);
  });

  it('snap 版 chromium：按路径或报错文本识别', () => {
    const byPath = diagnoseBrowserError('Failed to launch the browser process!', { ...linux, chromiumPath: '/snap/bin/chromium' });
    expect(byPath?.kind).toBe('snap');
    expect(byPath?.hint).toMatch(/deb/);
    const byText = diagnoseBrowserError("Command '/usr/bin/chromium' requires the chromium snap to be installed.", linux);
    expect(byText?.kind).toBe('snap');
  });

  it('找不到浏览器：给出对应平台的安装提示', () => {
    const d = diagnoseBrowserError('Could not find Chrome (ver. 130). This can occur if either', linux);
    expect(d?.kind).toBe('not-found');
    expect(d?.hint).toMatch(/apt install chromium/);
    const enoent = diagnoseBrowserError('spawn /opt/chrome/chrome ENOENT', linux);
    expect(enoent?.kind).toBe('not-found');
  });

  it('android：找不到浏览器时提示 proot-distro；其他类别追加 Termux 说明', () => {
    const android: DiagnoseContext = { platform: 'android', isRoot: false };
    expect(diagnoseBrowserError('Could not find Chrome', android)?.hint).toMatch(/proot-distro/);
    const sb = diagnoseBrowserError('No usable sandbox!', android);
    expect(sb?.kind).toBe('sandbox');
    expect(sb?.hint).toMatch(/proot-distro/);
  });

  it('认不出的报错返回 null，由调用方回退为原始信息', () => {
    expect(diagnoseBrowserError('Protocol error (Target.setDiscoverTargets): Target closed', linux)).toBeNull();
    expect(diagnoseBrowserError('', linux)).toBeNull();
    // 不带浏览器字样的 "No such file or directory" 不能误判成找不到浏览器
    expect(diagnoseBrowserError('Failed to launch the browser process! failed to open /dev/shm: No such file or directory', linux)).toBeNull();
  });
});
