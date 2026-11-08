// 扩展用到的 ST / Luker 前端 API 的最小类型。只声明实际用到的字段。

export interface StEventSource {
  on(event: string, listener: (...args: unknown[]) => unknown): void;
  once(event: string, listener: (...args: unknown[]) => unknown): void;
  removeListener(event: string, listener: (...args: unknown[]) => unknown): void;
}

export interface StChatMessage {
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  mes?: string;
}

export interface StCharacter {
  name?: string;
  avatar?: string;
}

/** ST / Luker 的预设管理器（getContext().getPresetManager）。 */
export interface StPresetManager {
  getAllPresets(): string[];
  findPreset(name: string): unknown;
  getSelectedPresetName(): string;
  selectPreset(value: unknown): Promise<void> | void;
}

export interface StContext {
  chat: StChatMessage[];
  characters: StCharacter[];
  characterId?: string | number;
  groupId?: string | null;
  name2?: string;
  mainApi?: string;
  /** 无参取当前 main_api 的预设管理器；该 API 没有预设时返回 null。 */
  getPresetManager?: (apiId?: string) => StPresetManager | null;
  onlineStatus?: string;
  eventSource: StEventSource;
  eventTypes: Record<string, string>;
  getCurrentChatId(): string | undefined;
  getRequestHeaders(opts?: { omitContentType?: boolean }): Record<string, string>;
  generate(type: string, options?: Record<string, unknown>): Promise<unknown>;
  stopGeneration(): boolean;
  selectCharacterById(id: number): Promise<unknown>;
  openCharacterChat(fileName: string): Promise<unknown>;
  executeSlashCommandsWithOptions(text: string, options?: Record<string, unknown>): Promise<unknown>;
  /** Luker 提供，ST 1.19 没有（用 /newchat）。 */
  doNewChat?: (opts?: { deleteCurrentChat?: boolean }) => Promise<unknown>;
  /** Luker 提供，ST 1.19 没有（用 /api/characters/chats）。 */
  getPastCharacterChats?: (characterId?: number) => Promise<unknown>;
}

export interface StHostApi {
  getContext(): StContext;
}

/** jQuery 中扩展用到的部分。 */
export interface JQueryXhrLike {
  status: number;
  setRequestHeader(name: string, value: string): void;
}

export interface JQueryLike {
  (selector: string): { val(v?: string): unknown; length: number; [i: number]: HTMLElement | undefined };
  ajaxSetup(options: { beforeSend?: (xhr: JQueryXhrLike) => void }): void;
  ajax(options: Record<string, unknown>): PromiseLike<unknown> & { fail?: unknown };
}

export interface ToastrLike {
  error: (...args: unknown[]) => unknown;
  warning: (...args: unknown[]) => unknown;
}
