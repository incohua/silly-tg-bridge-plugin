// 无头页面 JS 内存上限（pageHeapLimitMB）的默认值与范围。服务端校验和面板表单共用，避免两处各写一份。
export const DEFAULT_PAGE_HEAP_LIMIT_MB = 512;
export const MIN_PAGE_HEAP_LIMIT_MB = 128;
export const MAX_PAGE_HEAP_LIMIT_MB = 4096;
