// 页面操作串行队列。对 ST 页面的读、写、切换、生成都经过这里，一次只执行一个。
// 例外：stop 和 getStatus 不进队列（生成进行中也要立即执行），见 index.ts。

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;

  /** 正在执行和排队中的任务数。 */
  get size(): number {
    return this.pendingCount;
  }

  /** 排队执行 fn。前一个任务失败不影响后面的任务，fn 自己的结果或错误原样返回给调用方。 */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.pendingCount++;
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => this.pendingCount--,
      () => this.pendingCount--,
    );
    return result;
  }
}
