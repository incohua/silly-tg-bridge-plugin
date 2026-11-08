// 弹窗监视循环（spike 调整 3）。
// 首次启动欢迎弹窗、内置正则或世界书导入弹窗会让 firstLoadInit、selectCharacterById 一直不返回。
// host 页面没有人操作，所以独立循环：取最上层的 dialog[open]，依次尝试 OK、关闭、取消。
// 调用方不要 await 会弹窗的操作直到弹窗关闭，而是交给这个循环处理。

export interface DialogInfo {
  text: string;
  button: string;
}

export interface DialogWatcherOptions {
  intervalMs?: number;
  onDismiss?: (info: DialogInfo) => void;
  doc?: Document;
}

const BUTTONS = ['.popup-button-ok', '.popup-button-close', '.popup-button-cancel'];

/** 关闭最上层的一个弹窗。没有弹窗或没有可点按钮时返回 null。 */
export function dismissTopDialog(doc: Document = document): DialogInfo | null {
  const dialogs = [...doc.querySelectorAll<HTMLDialogElement>('dialog[open]')];
  const top = dialogs.pop();
  if (!top) return null;
  for (const sel of BUTTONS) {
    const btn = top.querySelector<HTMLElement>(sel);
    if (btn) {
      const text = (top.innerText || top.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      btn.click();
      return { text, button: sel };
    }
  }
  return null;
}

export function startDialogWatcher(opts: DialogWatcherOptions = {}): () => void {
  const timer = setInterval(() => {
    try {
      const info = dismissTopDialog(opts.doc);
      if (info) opts.onDismiss?.(info);
    } catch {
      // 监视循环本身不能抛错
    }
  }, opts.intervalMs ?? 1000);
  return () => clearInterval(timer);
}
