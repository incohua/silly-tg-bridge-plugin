"use strict";
(() => {
  // src/shared/protocol.ts
  var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  var isStr = (v) => typeof v === "string";
  function decodeHostCommand(v) {
    if (!isRecord(v) || !isStr(v.id) || !isStr(v.type)) return null;
    const id = v.id;
    switch (v.type) {
      case "send":
        return isStr(v.text) && isStr(v.generationId) ? { id, type: "send", text: v.text, generationId: v.generationId } : null;
      case "regenerate":
        return isStr(v.generationId) && isStr(v.chatId) && typeof v.messageId === "number" ? { id, type: "regenerate", generationId: v.generationId, chatId: v.chatId, messageId: v.messageId } : null;
      case "stop":
      case "getStatus":
      case "newChat":
      case "listCharacters":
      case "listChats":
      case "listPresets":
      case "refreshPage":
        return { id, type: v.type };
      case "selectPreset":
        return isStr(v.name) ? { id, type: "selectPreset", name: v.name } : null;
      case "selectCharacter":
        return isStr(v.characterId) ? { id, type: "selectCharacter", characterId: v.characterId } : null;
      case "openChat":
        return isStr(v.fileName) ? { id, type: "openChat", fileName: v.fileName } : null;
      case "getCardState":
        return typeof v.messageId === "number" && isStr(v.chatId) ? { id, type: "getCardState", messageId: v.messageId, chatId: v.chatId } : null;
      case "updateVariables":
        return typeof v.messageId === "number" && isStr(v.chatId) ? { id, type: "updateVariables", messageId: v.messageId, chatId: v.chatId, patch: v.patch } : null;
      default:
        return null;
    }
  }

  // src/extension/adapter.ts
  var NOISE_RULES = [
    // Luker 没配置 Stable Diffusion 时的 /api/sd/* 500
    (n) => n.kind === "http" && n.status === 500 && /\/api\/sd\//.test(n.url ?? ""),
    // Luker 内置工具查询的 worldinfo 404（__SEARCH_TOOLS__、__MEMORY_GRAPH__ 等）
    (n) => n.kind === "http" && n.status === 404 && /\/api\/worldinfo\/get/.test(n.url ?? ""),
    // Luker 首次加载时 jQuery UI autocomplete 的 pageerror
    (n) => n.kind === "error" && /autocomplete/i.test(n.message ?? "") && /jquery|ui|widget|instance/i.test(n.message ?? ""),
    // 浏览器自带的 favicon 请求
    (n) => n.kind === "http" && n.status === 404 && /favicon\.ico/.test(n.url ?? "")
  ];
  function isKnownNoise(n) {
    return NOISE_RULES.some((r) => r(n));
  }
  function getHostApi(g = globalThis) {
    const api = g.Luker ?? g.SillyTavern;
    return api && typeof api.getContext === "function" ? api : void 0;
  }
  function detectApp(g = globalThis) {
    return g.Luker !== void 0 ? "luker" : "st";
  }
  function ctx() {
    const api = getHostApi();
    if (!api) throw new Error("SillyTavern / Luker \u7684 getContext \u4E0D\u53EF\u7528");
    return api.getContext();
  }
  function waitAppReady(timeoutMs) {
    return new Promise((resolve) => {
      const c = ctx();
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      c.eventSource.once(c.eventTypes.APP_READY, () => {
        clearTimeout(timer);
        resolve("ready");
      });
    });
  }
  async function newChat() {
    const c = ctx();
    if (typeof c.doNewChat === "function") await c.doNewChat({ deleteCurrentChat: false });
    else await c.executeSlashCommandsWithOptions("/newchat", { handleParserErrors: false });
  }
  async function pastChats(characterIndex) {
    const c = ctx();
    if (typeof c.getPastCharacterChats === "function") {
      const r = await c.getPastCharacterChats(characterIndex);
      return Array.isArray(r) ? r : [];
    }
    const avatar = c.characters[characterIndex]?.avatar;
    if (!avatar) return [];
    const res = await fetch("/api/characters/chats", { method: "POST", headers: c.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
    if (!res.ok) throw new Error(`\u8BFB\u53D6\u804A\u5929\u5217\u8868\u5931\u8D25\uFF1AHTTP ${res.status}`);
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  }

  // src/extension/generation.ts
  var STREAM_UPLOAD_INTERVAL_MS = 400;
  var generating = false;
  var toastLog = null;
  var isGenerating = () => generating;
  function captureToasts() {
    const t = globalThis.toastr;
    if (!t) return;
    for (const level of ["error", "warning"]) {
      const orig = t[level];
      if (typeof orig !== "function") continue;
      t[level] = function(...args) {
        if (toastLog) toastLog.push(args.filter((a) => typeof a === "string").join(" ").slice(0, 300));
        return orig.apply(this, args);
      };
    }
  }
  function regenerateRejection(current, expected) {
    if (current.chatId !== expected.chatId) return "ST \u5F53\u524D\u6253\u5F00\u7684\u4E0D\u662F\u4E0A\u4E00\u6761\u56DE\u590D\u6240\u5728\u7684\u804A\u5929\uFF08\u53EF\u80FD\u5DF2\u5207\u6362\u804A\u5929\uFF09\uFF0C\u65E0\u6CD5\u91CD\u65B0\u751F\u6210";
    const last = current.chat.length - 1;
    if (last !== expected.messageId) return "\u4E0A\u4E00\u6761\u56DE\u590D\u5DF2\u4E0D\u662F\u804A\u5929\u91CC\u7684\u6700\u540E\u4E00\u6761\uFF08\u4E4B\u540E\u53C8\u6709\u65B0\u6D88\u606F\u6216\u88AB\u5220\u9664\uFF09\uFF0C\u65E0\u6CD5\u91CD\u65B0\u751F\u6210";
    const m = current.chat[last];
    if (!m || m.is_user || m.is_system) return "\u804A\u5929\u91CC\u7684\u6700\u540E\u4E00\u6761\u4E0D\u662F\u89D2\u8272\u56DE\u590D\uFF0C\u65E0\u6CD5\u91CD\u65B0\u751F\u6210";
    return null;
  }
  var hasChat = (c) => c.characterId !== void 0 && c.characterId !== null || !!c.groupId;
  async function runGeneration(opts) {
    const { generationId, report, request } = opts;
    const c = ctx();
    if (!hasChat(c)) throw new Error("ST \u5F53\u524D\u6CA1\u6709\u6253\u5F00\u4EFB\u4F55\u89D2\u8272\u7684\u804A\u5929\uFF0C\u8BF7\u5148\u53D1 /chars \u9009\u62E9\u89D2\u8272");
    let textarea = null;
    let minIndex;
    if (request.kind === "send") {
      if (request.text.trimStart().startsWith("/")) throw new Error("\u4EE5 / \u5F00\u5934\u7684\u6587\u5B57\u4F1A\u88AB ST \u5F53\u4F5C slash \u547D\u4EE4\uFF0C\u5DF2\u62D2\u7EDD");
      const $ = globalThis.$;
      textarea = $("#send_textarea");
      if (!textarea.length || !textarea[0]) throw new Error("\u627E\u4E0D\u5230 #send_textarea\uFF0CST \u9875\u9762\u7ED3\u6784\u53EF\u80FD\u5DF2\u53D8\u5316");
      minIndex = c.chat.length;
    } else {
      const why = regenerateRejection({ chatId: c.getCurrentChatId(), chat: c.chat }, request);
      if (why) throw new Error(why);
      minIndex = request.messageId;
    }
    const { eventSource, eventTypes } = c;
    let stopped = false;
    let latest = null;
    let timer = null;
    const flush = () => {
      timer = null;
      if (latest !== null) report({ type: "streamText", generationId, text: latest });
      latest = null;
    };
    const onToken = (...args) => {
      if (typeof args[0] !== "string") return;
      latest = args[0];
      if (!timer) timer = setTimeout(flush, STREAM_UPLOAD_INTERVAL_MS);
    };
    const onStopped = () => void (stopped = true);
    generating = true;
    toastLog = [];
    eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, onToken);
    eventSource.on(eventTypes.GENERATION_STOPPED, onStopped);
    let error;
    try {
      if (request.kind === "send" && textarea) {
        textarea.val(request.text);
        textarea[0]?.dispatchEvent(new Event("input", { bubbles: true }));
      }
      opts.onStarted();
      await c.generate(request.kind === "send" ? "normal" : "regenerate");
    } catch (e) {
      error = e;
    } finally {
      eventSource.removeListener(eventTypes.STREAM_TOKEN_RECEIVED, onToken);
      eventSource.removeListener(eventTypes.GENERATION_STOPPED, onStopped);
      if (timer) clearTimeout(timer);
      timer = null;
      latest = null;
      generating = false;
    }
    const toasts = toastLog ?? [];
    toastLog = null;
    await new Promise((r) => setTimeout(r, 50));
    const after = ctx();
    const index = after.chat.length - 1;
    const msg = after.chat[index];
    if (index >= minIndex && msg && !msg.is_user && !msg.is_system) {
      const node = document.querySelector(`#chat .mes[mesid="${index}"] .mes_text`);
      report({
        type: "messageFinal",
        generationId,
        chatId: after.getCurrentChatId() ?? "",
        messageId: index,
        html: node?.innerHTML ?? "",
        text: node ? node.innerText : msg.mes ?? "",
        raw: msg.mes ?? "",
        stopped,
        cards: []
      });
      return;
    }
    if (stopped) {
      report({ type: "generationStopped", generationId });
      return;
    }
    const reason = toasts.filter(Boolean).join("\uFF1B") || (error instanceof Error ? error.message : error ? String(error) : "") || "\u6CA1\u6709\u751F\u6210\u65B0\u7684\u56DE\u590D";
    report({ type: "generationFailed", generationId, reason: reason.slice(0, 500) });
  }

  // src/extension/commands.ts
  var SWITCH_TIMEOUT_MS = 3e4;
  var SWITCH_SETTLE_MS = 3e4;
  var MULTI_OK = /* @__PURE__ */ new Set(["alternate_greetings"]);
  function formDuplicates() {
    const form = document.getElementById("form_create");
    if (!(form instanceof HTMLFormElement)) return [];
    const fd = new FormData(form);
    return [...new Set(fd.keys())].filter((k) => !MULTI_OK.has(k) && fd.getAll(k).length > 1);
  }
  function formDuplicateLocations(name) {
    return [...document.querySelectorAll(`[name="${CSS.escape(name)}"]`)].map((e) => {
      const path = [];
      let x = e;
      for (let i = 0; i < 5 && x; i++) {
        path.push(x.tagName.toLowerCase() + (x.id ? `#${x.id}` : "") + (typeof x.className === "string" && x.className ? `.${x.className.split(" ")[0]}` : ""));
        x = x.parentElement;
      }
      return path.join(" < ");
    });
  }
  function assertCardSafe(action) {
    const dups = formDuplicates();
    if (dups.length === 0) return;
    const where = formDuplicateLocations(dups[0]).join(" | ");
    throw new Error(
      `ST \u9875\u9762\u7684\u89D2\u8272\u7F16\u8F91\u8868\u5355\u51FA\u73B0\u91CD\u590D\u5B57\u6BB5\uFF08${dups.slice(0, 6).join("\u3001")}\uFF09\uFF0C${action}\u4F1A\u7528\u5B83\u91CD\u65B0\u4FDD\u5B58\u89D2\u8272\u5361\u5E76\u628A\u5361\u7247\u5199\u574F\uFF0C\u5DF2\u62D2\u7EDD\u6267\u884C\u3002\u91CD\u542F ST \u540E\u518D\u8BD5\u3002\u8BCA\u65AD\uFF1A${where}`
    );
  }
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function settle(p, ms) {
    await Promise.race([p, sleep(ms)]);
  }
  async function waitFor(pred, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await sleep(200);
    }
    return pred();
  }
  var currentIndex = () => {
    const id = ctx().characterId;
    return id === void 0 || id === null || id === "" ? void 0 : Number(id);
  };
  function switchResult() {
    const c = ctx();
    const i = currentIndex();
    const ch = i === void 0 ? void 0 : c.characters[i];
    return { characterName: ch?.name, characterAvatar: ch?.avatar, chatId: c.getCurrentChatId() };
  }
  function isGreetingOnly(chat) {
    return chat.length === 1 && !chat[0].is_user && !chat[0].is_system;
  }
  function readGreeting() {
    const c = ctx();
    if (!isGreetingOnly(c.chat)) return void 0;
    const node = document.querySelector('#chat .mes[mesid="0"] .mes_text');
    const html = node?.innerHTML ?? "";
    const text = node ? node.innerText : c.chat[0].mes ?? "";
    return html || text ? { html, text } : void 0;
  }
  function presetManager() {
    const c = ctx();
    return typeof c.getPresetManager === "function" ? c.getPresetManager() : null;
  }
  function hostStatus() {
    const c = ctx();
    const r = switchResult();
    return {
      app: detectApp(),
      characterName: c.groupId ? `\u7FA4\u804A ${c.groupId}` : r.characterName,
      characterAvatar: r.characterAvatar,
      chatId: r.chatId,
      messageCount: r.chatId ? c.chat.length : void 0,
      formDuplicates: formDuplicates(),
      mainApi: c.mainApi,
      onlineStatus: c.onlineStatus,
      generating: isGenerating(),
      presetName: presetManager()?.getSelectedPresetName() || void 0
    };
  }
  function listPresets() {
    const m = presetManager();
    if (!m) throw new Error("\u5F53\u524D API \u6CA1\u6709\u53EF\u5207\u6362\u7684\u9884\u8BBE");
    const presets = m.getAllPresets().filter((n) => typeof n === "string" && n);
    return { api: ctx().mainApi ?? "", current: m.getSelectedPresetName() || void 0, presets };
  }
  async function selectPreset(name) {
    const m = presetManager();
    if (!m) throw new Error("\u5F53\u524D API \u6CA1\u6709\u53EF\u5207\u6362\u7684\u9884\u8BBE");
    const value = m.findPreset(name);
    if (value === void 0 || value === null) throw new Error("\u627E\u4E0D\u5230\u8FD9\u4E2A\u9884\u8BBE\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\u6216\u6539\u540D\uFF09\uFF0C\u8BF7\u91CD\u65B0\u53D1\u9001 /preset");
    if (m.getSelectedPresetName() !== name) await m.selectPreset(value);
    if (!await waitFor(() => presetManager()?.getSelectedPresetName() === name, 5e3)) throw new Error("\u5207\u6362\u9884\u8BBE\u8D85\u65F6");
    return { presetName: name };
  }
  function listCharacters() {
    return ctx().characters.filter((ch) => typeof ch.avatar === "string" && ch.avatar).map((ch) => ({ avatar: ch.avatar, name: ch.name || ch.avatar }));
  }
  async function selectCharacter(avatar) {
    const c = ctx();
    const index = c.characters.findIndex((ch) => ch.avatar === avatar);
    if (index < 0) throw new Error("\u627E\u4E0D\u5230\u8FD9\u4E2A\u89D2\u8272\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\u6216\u6539\u540D\uFF09\uFF0C\u8BF7\u91CD\u65B0\u53D1\u9001 /chars");
    if (currentIndex() === index && c.getCurrentChatId()) return { ...switchResult(), greeting: readGreeting() };
    await settle(c.selectCharacterById(index), SWITCH_TIMEOUT_MS);
    const ok = await waitFor(() => currentIndex() === index && !!ctx().getCurrentChatId(), SWITCH_SETTLE_MS);
    if (!ok) {
      const where = currentIndex() === index ? "\u89D2\u8272\u5DF2\u9009\u4E2D\uFF0C\u4F46\u804A\u5929\u4E00\u76F4\u6CA1\u52A0\u8F7D\u51FA\u6765" : "\u9875\u9762\u4E00\u76F4\u6CA1\u5207\u5230\u8FD9\u4E2A\u89D2\u8272";
      throw new Error(`\u5207\u6362\u89D2\u8272\u8D85\u65F6\uFF1A${where}\u3002\u8FD9\u5F20\u5361\u53EF\u80FD\u524D\u7AEF\u5F88\u91CD\uFF0C\u9875\u9762\u8FD8\u5728\u52A0\u8F7D\uFF0C\u7B49\u4E00\u4F1A\u513F\u518D\u70B9\u4E00\u6B21\u901A\u5E38\u5C31\u597D\u4E86`);
    }
    await sleep(300);
    return { ...switchResult(), greeting: readGreeting() };
  }
  function normalizeChats(raw) {
    const out = [];
    for (const r of raw) {
      if (typeof r !== "object" || r === null) continue;
      const o = r;
      if (typeof o.file_name !== "string" || !o.file_name) continue;
      const fileName = o.file_name.replace(/\.jsonl$/, "");
      let lastMessageAt;
      if (typeof o.last_mes === "number" && Number.isFinite(o.last_mes)) lastMessageAt = o.last_mes;
      else if (typeof o.last_mes === "string") {
        const t = Date.parse(o.last_mes);
        if (Number.isFinite(t)) lastMessageAt = t;
      }
      const count = typeof o.chat_items === "number" ? o.chat_items : Number(o.chat_items);
      const preview = typeof o.mes === "string" ? o.mes.replace(/\s+/g, " ").trim().slice(0, 60) : void 0;
      out.push({ fileName, lastMessageAt, messageCount: Number.isFinite(count) ? count : void 0, preview });
    }
    return out.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  }
  async function listChats() {
    const i = currentIndex();
    if (i === void 0) throw new Error("ST \u5F53\u524D\u6CA1\u6709\u9009\u62E9\u89D2\u8272\uFF0C\u5148\u7528 /chars \u9009\u4E00\u4E2A");
    return normalizeChats(await pastChats(i));
  }
  async function openChat(fileName) {
    const c = ctx();
    if (currentIndex() === void 0) throw new Error("ST \u5F53\u524D\u6CA1\u6709\u9009\u62E9\u89D2\u8272\uFF0C\u5148\u7528 /chars \u9009\u4E00\u4E2A");
    if (c.getCurrentChatId() === fileName) return switchResult();
    assertCardSafe("\u6253\u5F00\u804A\u5929");
    await settle(c.openCharacterChat(fileName), SWITCH_TIMEOUT_MS);
    if (!await waitFor(() => ctx().getCurrentChatId() === fileName, SWITCH_SETTLE_MS)) throw new Error(`\u6253\u5F00\u804A\u5929\u8D85\u65F6\uFF1A\u9875\u9762 ${SWITCH_SETTLE_MS / 1e3} \u79D2\u5185\u6CA1\u5207\u5230\u8FD9\u4E2A\u804A\u5929\uFF0C\u53EF\u80FD\u8FD8\u5728\u52A0\u8F7D\uFF0C\u7B49\u4E00\u4F1A\u513F\u518D\u8BD5`);
    return switchResult();
  }
  async function newChat2() {
    const c = ctx();
    if (currentIndex() === void 0) throw new Error("ST \u5F53\u524D\u6CA1\u6709\u9009\u62E9\u89D2\u8272\uFF0C\u5148\u7528 /chars \u9009\u4E00\u4E2A");
    const before = c.getCurrentChatId();
    assertCardSafe("\u65B0\u5EFA\u804A\u5929");
    await settle(newChat(), SWITCH_TIMEOUT_MS);
    if (!await waitFor(() => !!ctx().getCurrentChatId() && ctx().getCurrentChatId() !== before, SWITCH_SETTLE_MS)) throw new Error(`\u65B0\u5EFA\u804A\u5929\u8D85\u65F6\uFF1A\u9875\u9762 ${SWITCH_SETTLE_MS / 1e3} \u79D2\u5185\u6CA1\u5EFA\u597D\uFF0C\u53EF\u80FD\u8FD8\u5728\u52A0\u8F7D\uFF0C\u7B49\u4E00\u4F1A\u513F\u518D\u8BD5`);
    await sleep(300);
    return { ...switchResult(), greeting: readGreeting() };
  }

  // src/extension/api-connect.ts
  var CONNECT_BUTTONS = {
    openai: "#api_button_openai",
    textgenerationwebui: "#api_button_textgenerationwebui",
    novel: "#api_button_novel",
    kobold: "#api_button"
  };
  var NO_CONNECTION = "no_connection";
  var isConnected = () => {
    const s = ctx().onlineStatus;
    return !!s && s !== NO_CONNECTION;
  };
  async function ensureApiConnected(timeoutMs = 15e3) {
    const api = ctx().mainApi ?? "";
    if (isConnected()) return { name: "api", ok: true, detail: `${api} \u5DF2\u8FDE\u63A5` };
    const sel = CONNECT_BUTTONS[api];
    const btn = sel ? document.querySelector(sel) : null;
    if (!btn) return { name: "api", ok: false, detail: `\u5F53\u524D API\uFF08${api || "\u672A\u8BBE\u7F6E"}\uFF09\u672A\u8FDE\u63A5\uFF0C\u4E14\u627E\u4E0D\u5230\u5BF9\u5E94\u7684\u8FDE\u63A5\u6309\u94AE\u3002\u8BF7\u5728 ST \u91CC\u914D\u7F6E\u5E76\u8FDE\u63A5\u4E00\u6B21 API\u3002` };
    btn.click();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (isConnected()) return { name: "api", ok: true, detail: `${api} \u5DF2\u8FDE\u63A5` };
    }
    return { name: "api", ok: false, detail: `${api} \u8FDE\u63A5\u5931\u8D25\u6216\u8D85\u65F6\uFF08${ctx().onlineStatus ?? "\u672A\u77E5\u72B6\u6001"}\uFF09\u3002\u68C0\u67E5 ST \u91CC\u7684 API \u5730\u5740\u548C\u5BC6\u94A5\u3002` };
  }

  // src/extension/csrf.ts
  async function probe($) {
    try {
      await $.ajax({ type: "POST", url: "/api/ping", cache: false });
      return 204;
    } catch (e) {
      return e?.status ?? 0;
    }
  }
  var ok2xx = (s) => s >= 200 && s < 300;
  async function applyCsrfPatchAndCheck(opts = {}) {
    const $ = globalThis.$;
    if (typeof $ !== "function" || typeof $.ajaxSetup !== "function") {
      return { name: "csrf", ok: false, detail: "\u9875\u9762\u91CC\u6CA1\u6709 jQuery\uFF0C\u65E0\u6CD5\u5B89\u88C5 CSRF \u8865\u4E01" };
    }
    const before = await probe($);
    if (opts.skipPatch) {
      const detail2 = `\u6D4B\u8BD5\u5F00\u5173\uFF1A\u672A\u5B89\u88C5\u8865\u4E01\uFF0CjQuery.ajax \u81EA\u68C0 POST /api/ping \u8FD4\u56DE ${before || "\u7F51\u7EDC\u9519\u8BEF"}`;
      return { name: "csrf", ok: ok2xx(before), detail: detail2 };
    }
    $.ajaxSetup({
      beforeSend: (xhr) => {
        const token = ctx().getRequestHeaders()["X-CSRF-Token"];
        if (token) xhr.setRequestHeader("X-CSRF-Token", token);
      }
    });
    const after = await probe($);
    const detail = `jQuery.ajax \u81EA\u68C0 POST /api/ping\uFF1A\u8865\u4E01\u524D ${before || "\u7F51\u7EDC\u9519\u8BEF"}\uFF0C\u8865\u4E01\u540E ${after || "\u7F51\u7EDC\u9519\u8BEF"}`;
    if (ok2xx(after)) return { name: "csrf", ok: true, detail };
    return {
      name: "csrf",
      ok: false,
      detail: `${detail}\u3002\u9700\u8981 CSRF \u7684\u8BF7\u6C42\u4F1A\u5931\u8D25\uFF0C\u63D0\u793A\u8BCD\u53EF\u80FD\u88AB\u7EC4\u88C5\u4E3A\u7A7A\uFF0C\u6682\u505C\u4F7F\u7528\u5E76\u68C0\u67E5 ST \u7248\u672C\u6216\u767B\u5F55\u72B6\u6001\u3002`
    };
  }

  // src/extension/dialog-watcher.ts
  var BUTTONS = [".popup-button-ok", ".popup-button-close", ".popup-button-cancel"];
  function dismissTopDialog(doc = document) {
    const dialogs = [...doc.querySelectorAll("dialog[open]")];
    const top = dialogs.pop();
    if (!top) return null;
    for (const sel of BUTTONS) {
      const btn = top.querySelector(sel);
      if (btn) {
        const text = (top.innerText || top.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
        btn.click();
        return { text, button: sel };
      }
    }
    return null;
  }
  function startDialogWatcher(opts = {}) {
    const timer = setInterval(() => {
      try {
        const info = dismissTopDialog(opts.doc);
        if (info) opts.onDismiss?.(info);
      } catch {
      }
    }, opts.intervalMs ?? 1e3);
    return () => clearInterval(timer);
  }

  // src/extension/host-mode.ts
  var HOST_PARAM = "silly_tg_host";
  var SKIP_CSRF_PATCH_PARAM = "silly_tg_test_skip_csrf_patch";
  var NONCE_RE = /^[0-9a-f]{32}$/;
  function parseHostTestFlags(hash) {
    try {
      return { skipCsrfPatch: new URLSearchParams(hash.replace(/^#/, "")).get(SKIP_CSRF_PATCH_PARAM) === "1" };
    } catch {
      return { skipCsrfPatch: false };
    }
  }
  function parseHostNonce(hash) {
    let value;
    try {
      value = new URLSearchParams(hash.replace(/^#/, "")).get(HOST_PARAM);
    } catch {
      return null;
    }
    return value !== null && NONCE_RE.test(value) ? value : null;
  }

  // src/extension/queue.ts
  var SerialQueue = class {
    tail = Promise.resolve();
    pendingCount = 0;
    /** 正在执行和排队中的任务数。 */
    get size() {
      return this.pendingCount;
    }
    /** 排队执行 fn。前一个任务失败不影响后面的任务，fn 自己的结果或错误原样返回给调用方。 */
    run(fn) {
      this.pendingCount++;
      const result = this.tail.then(fn);
      this.tail = result.then(
        () => this.pendingCount--,
        () => this.pendingCount--
      );
      return result;
    }
  };

  // src/extension/restore.ts
  function activeCharacterFromSettingsResponse(body) {
    if (typeof body !== "object" || body === null) return null;
    let s = body.settings;
    if (typeof s === "string") {
      try {
        s = JSON.parse(s);
      } catch {
        return null;
      }
    }
    const v = s?.active_character;
    return typeof v === "string" && v ? v : null;
  }
  async function restoreActiveCharacter(timeoutMs = 2e4) {
    const c = ctx();
    if (c.characterId !== void 0 && c.characterId !== null || c.groupId) return { restored: false, reason: "\u5DF2\u6709\u6253\u5F00\u7684\u804A\u5929" };
    let key = null;
    try {
      const res = await fetch("/api/settings/get", { method: "POST", headers: c.getRequestHeaders(), body: "{}", cache: "no-cache" });
      key = activeCharacterFromSettingsResponse(await res.json());
    } catch (e) {
      return { restored: false, reason: `\u8BFB\u53D6\u8BBE\u7F6E\u5931\u8D25\uFF1A${e.message}` };
    }
    if (!key) return { restored: false, reason: "ST \u6CA1\u6709\u8BB0\u5F55\u6700\u8FD1\u4F7F\u7528\u7684\u89D2\u8272" };
    const index = c.characters.findIndex((ch) => ch.avatar === key);
    if (index < 0) return { restored: false, reason: `\u6700\u8FD1\u4F7F\u7528\u7684\u89D2\u8272 ${key} \u5DF2\u4E0D\u5B58\u5728` };
    if (typeof c.selectCharacterById !== "function") return { restored: false, reason: "selectCharacterById \u4E0D\u53EF\u7528" };
    void Promise.resolve(c.selectCharacterById(index)).catch(() => {
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      const now = ctx();
      if (String(now.characterId) === String(index) && now.getCurrentChatId()) return { restored: true, name: c.characters[index].name ?? key };
    }
    return { restored: false, reason: `\u6253\u5F00\u89D2\u8272 ${key} \u8D85\u65F6` };
  }

  // src/extension/settings-model.ts
  function parseUserIds(text) {
    const parts = text.split(/[\s,，、;；]+/).filter(Boolean);
    const ids = [];
    for (const p of parts) {
      if (!/^\d+$/.test(p) || !Number.isSafeInteger(Number(p)) || Number(p) <= 0) {
        return { ok: false, message: `\u201C${p}\u201D\u4E0D\u662F\u7528\u6237\u6570\u5B57 ID\uFF08\u5E94\u4E3A\u7EAF\u6570\u5B57\uFF0C\u53EF\u5411 @userinfobot \u67E5\u8BE2\uFF0C\u4E0D\u662F\u7528\u6237\u540D\uFF09\u3002` };
      }
      ids.push(Number(p));
    }
    return { ok: true, ids: [...new Set(ids)] };
  }
  function buildPatch(form, original) {
    const errors = [];
    const patch = {};
    if (form.botToken.trim()) patch.botToken = form.botToken.trim();
    const ids = parseUserIds(form.allowedUserIds);
    if (ids.ok) patch.allowedUserIds = ids.ids;
    else errors.push({ field: "allowedUserIds", message: ids.message });
    patch.telegramProxy = form.telegramProxy.trim();
    patch.stBaseUrl = form.stBaseUrl.trim();
    if (form.basicAuthUser.trim()) patch.basicAuth = { username: form.basicAuthUser.trim(), password: form.basicAuthPassword };
    else if (original?.basicAuth) patch.basicAuth = null;
    const idle = form.idleShutdownMinutes.trim() === "" ? 0 : Number(form.idleShutdownMinutes);
    if (!Number.isFinite(idle)) errors.push({ field: "idleShutdownMinutes", message: "\u7A7A\u95F2\u5173\u95ED\u65F6\u95F4\u5FC5\u987B\u662F\u6570\u5B57\uFF08\u5206\u949F\uFF09\uFF0C0 \u8868\u793A\u4E0D\u5173\u95ED\u3002" });
    else patch.idleShutdownMinutes = idle;
    patch.lowMemory = form.lowMemory;
    patch.dialogueStyle = form.dialogueStyle;
    patch.logLevel = form.logLevel;
    patch.draftMode = form.draftMode;
    patch.choiceLayout = form.choiceLayout;
    const draft = form.draftIntervalSeconds.trim() === "" ? 1 : Number(form.draftIntervalSeconds);
    if (!Number.isFinite(draft)) errors.push({ field: "draftIntervalSeconds", message: "\u8349\u7A3F\u5237\u65B0\u95F4\u9694\u5FC5\u987B\u662F\u6570\u5B57\uFF08\u79D2\uFF09\u3002" });
    else patch.draftIntervalSeconds = draft;
    return errors.length > 0 ? { ok: false, errors } : { ok: true, patch };
  }
  function saveSummary(r) {
    if (!r.changed || r.changed.length === 0) return "\u6CA1\u6709\u6539\u52A8\u3002";
    const parts = ["\u5DF2\u4FDD\u5B58\u3002"];
    if (r.hot && r.hot.length > 0) parts.push(`\u5DF2\u7ACB\u5373\u751F\u6548\uFF1A${r.hot.map(fieldLabel).join("\u3001")}\u3002`);
    if (r.restart && r.restart.length > 0) parts.push(`\u9700\u8981\u91CD\u542F ST \u624D\u751F\u6548\uFF1A${r.restart.map(fieldLabel).join("\u3001")}\u3002`);
    return parts.join("");
  }
  var FIELD_LABELS = {
    botToken: "Bot Token",
    allowedUserIds: "\u5141\u8BB8\u7684\u7528\u6237 ID",
    telegramProxy: "Telegram \u4EE3\u7406",
    stBaseUrl: "ST \u5730\u5740",
    basicAuth: "ST \u767B\u5F55\u8D26\u53F7",
    idleShutdownMinutes: "\u7A7A\u95F2\u5173\u95ED\u65F6\u95F4",
    lowMemory: "\u4F4E\u5185\u5B58\u6A21\u5F0F",
    dialogueStyle: "\u5BF9\u8BDD\u6837\u5F0F",
    logLevel: "\u65E5\u5FD7\u7EA7\u522B",
    draftIntervalSeconds: "\u8349\u7A3F\u5237\u65B0\u95F4\u9694",
    draftMode: "\u8349\u7A3F\u663E\u793A\u65B9\u5F0F",
    choiceLayout: "\u9009\u9879\u6309\u94AE\u6392\u7248"
  };
  var fieldLabel = (k) => FIELD_LABELS[k] ?? k;

  // src/extension/uplink.ts
  var PLUGIN_BASE = "/api/plugins/silly-tg";
  var Uplink = class {
    constructor(nonce, onRejected) {
      this.nonce = nonce;
      this.onRejected = onRejected;
    }
    nonce;
    onRejected;
    chain = Promise.resolve();
    dead = false;
    get closed() {
      return this.dead;
    }
    /** 立即提交（不排队），返回 HTTP 状态。只用于 hello。 */
    async sendNow(event) {
      const res = await fetch(`${PLUGIN_BASE}/host/message`, {
        method: "POST",
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ nonce: this.nonce, event })
      });
      return res.status;
    }
    /** 排队提交。失败只记控制台，不抛错。 */
    send(event) {
      const p = this.chain.then(async () => {
        if (this.dead) return;
        try {
          const status = await this.sendNow(event);
          if (status === 403) this.reject();
          else if (status >= 400) console.warn(`[silly-tg] \u4E0A\u884C ${event.type} \u5931\u8D25\uFF1AHTTP ${status}`);
        } catch (e) {
          console.warn(`[silly-tg] \u4E0A\u884C ${event.type} \u5931\u8D25\uFF1A${e.message}`);
        }
      });
      this.chain = p;
      return p;
    }
    reject() {
      if (this.dead) return;
      this.dead = true;
      this.onRejected();
    }
  };

  // src/extension/settings-ui.ts
  var CONTAINER_ID = "extensions_settings2";
  var ROOT_ID = "silly_tg_settings";
  function el(tag, attrs = {}, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== void 0) e.textContent = text;
    return e;
  }
  function row(label, effect, control, hint) {
    const root = el("div", { class: "silly-tg-row", style: "margin-bottom:10px" });
    const head = el("div", { style: "display:flex;justify-content:space-between;gap:8px;align-items:baseline" });
    head.append(el("label", {}, label), el("small", { style: "opacity:.65" }, effect));
    root.append(head, control);
    if (hint) root.append(el("small", { style: "opacity:.65;display:block" }, hint));
    const error = el("small", { style: "color:var(--SmartThemeQuoteColor,#e66);display:block" });
    root.append(error);
    return { root, error };
  }
  var input = (type, placeholder = "") => el("input", { type, class: "text_pole", placeholder, autocomplete: "off", style: "width:100%" });
  function select(options) {
    const s = el("select", { class: "text_pole", style: "width:100%" });
    for (const [v, t] of options) s.append(el("option", { value: v }, t));
    return s;
  }
  function mountSettings() {
    const mount = () => {
      const container = document.getElementById(CONTAINER_ID);
      if (!container || document.getElementById(ROOT_ID)) return !!container;
      buildDrawer(container);
      return true;
    };
    if (mount()) return;
    try {
      const c = ctx();
      c.eventSource.once(c.eventTypes.APP_READY, () => void mount());
    } catch {
    }
    let tries = 0;
    const t = setInterval(() => {
      if (mount() || ++tries > 20) clearInterval(t);
    }, 500);
  }
  function buildDrawer(container) {
    const root = el("div", { id: ROOT_ID });
    const drawer = el("div", { class: "inline-drawer" });
    const header = el("div", { class: "inline-drawer-toggle inline-drawer-header" });
    header.append(el("b", {}, "Silly TG\uFF08Telegram \u6865\u63A5\uFF09"), el("div", { class: "inline-drawer-icon fa-solid fa-circle-chevron-down down" }));
    const content = el("div", { class: "inline-drawer-content" });
    drawer.append(header, content);
    root.append(drawer);
    container.append(root);
    const banner = el("div", { style: "margin-bottom:10px" });
    const form = el("div");
    content.append(banner, form);
    const f = {
      botToken: input("password", ""),
      allowedUserIds: input("text", "\u4F8B\u5982 123456789\uFF0C\u591A\u4E2A\u7528\u9017\u53F7\u5206\u9694"),
      telegramProxy: input("text", "\u4F8B\u5982 http://127.0.0.1:7890\uFF0C\u4E0D\u9700\u8981\u7559\u7A7A"),
      stBaseUrl: input("text", "http://127.0.0.1:8000"),
      basicAuthUser: input("text", "ST \u5F00\u542F\u4E86 basic auth \u65F6\u586B"),
      basicAuthPassword: input("password", ""),
      idleShutdownMinutes: input("number", "0"),
      lowMemory: el("input", { type: "checkbox" }),
      dialogueStyle: select([
        ["bold", "\u52A0\u7C97"],
        ["italic", "\u659C\u4F53"],
        ["mark", "\u9AD8\u4EAE"],
        ["plain", "\u53EA\u4FDD\u7559\u5F15\u53F7"]
      ]),
      draftIntervalSeconds: input("number", "1"),
      draftMode: select([
        ["live", "\u9010\u6B65\u663E\u793A\u6B63\u6587"],
        ["progress", "\u53EA\u663E\u793A\u8FDB\u5EA6"]
      ]),
      choiceLayout: select([
        ["numbers", "\u4E00\u6392\u6570\u5B57\u6309\u94AE"],
        ["rows", "\u6BCF\u4E2A\u9009\u9879\u4E00\u884C"]
      ]),
      logLevel: select([
        ["info", "info"],
        ["debug", "debug"],
        ["warn", "warn"],
        ["error", "error"]
      ])
    };
    const rows = {
      botToken: row("Bot Token", "\u91CD\u542F ST \u540E\u751F\u6548", f.botToken),
      allowedUserIds: row("\u5141\u8BB8\u7684\u7528\u6237 ID", "\u91CD\u542F ST \u540E\u751F\u6548", f.allowedUserIds, "\u53EA\u6709\u8FD9\u4E9B Telegram \u8D26\u53F7\u80FD\u4F7F\u7528 bot\u3002"),
      telegramProxy: row("Telegram \u4EE3\u7406", "\u91CD\u542F ST \u540E\u751F\u6548", f.telegramProxy),
      stBaseUrl: row("ST \u5730\u5740", "\u91CD\u542F ST \u540E\u751F\u6548", f.stBaseUrl, "\u65E0\u5934\u6D4F\u89C8\u5668\u8BBF\u95EE ST \u7528\u7684\u5730\u5740\u3002"),
      basicAuth: row("ST \u767B\u5F55\u8D26\u53F7", "\u91CD\u542F ST \u540E\u751F\u6548", f.basicAuthUser),
      idleShutdownMinutes: row("\u7A7A\u95F2\u5173\u95ED\uFF08\u5206\u949F\uFF09", "\u7ACB\u5373\u751F\u6548", f.idleShutdownMinutes, "0 \u8868\u793A\u4E0D\u81EA\u52A8\u5173\u95ED\u65E0\u5934\u6D4F\u89C8\u5668\u3002"),
      lowMemory: row("\u4F4E\u5185\u5B58\u6A21\u5F0F", "\u4E0B\u6B21\u542F\u52A8\u6D4F\u89C8\u5668\u65F6\u751F\u6548", f.lowMemory),
      dialogueStyle: row("\u5BF9\u8BDD\u6837\u5F0F", "\u7ACB\u5373\u751F\u6548", f.dialogueStyle),
      draftIntervalSeconds: row("\u8349\u7A3F\u5237\u65B0\u95F4\u9694\uFF08\u79D2\uFF09", "\u7ACB\u5373\u751F\u6548", f.draftIntervalSeconds, "\u751F\u6210\u65F6\u6BCF\u9694\u8FD9\u4E48\u4E45\u66F4\u65B0\u4E00\u6B21\u8349\u7A3F\uFF0C0.5\u201330\u3002\u8C03\u5927\u53EF\u51CF\u5C11\u804A\u5929\u7A97\u53E3\u4E0A\u4E0B\u6EDA\u52A8\u3002"),
      draftMode: row("\u8349\u7A3F\u663E\u793A\u65B9\u5F0F", "\u7ACB\u5373\u751F\u6548", f.draftMode, "\u201C\u53EA\u663E\u793A\u8FDB\u5EA6\u201D\u65F6\u751F\u6210\u8FC7\u7A0B\u4E2D\u4E0D\u663E\u793A\u6B63\u6587\uFF0C\u804A\u5929\u7A97\u53E3\u4E0D\u4F1A\u6EDA\u52A8\u3002"),
      choiceLayout: row("\u884C\u52A8\u9009\u9879\u6309\u94AE", "\u7ACB\u5373\u751F\u6548", f.choiceLayout),
      logLevel: row("\u65E5\u5FD7\u7EA7\u522B", "\u7ACB\u5373\u751F\u6548", f.logLevel)
    };
    rows.basicAuth.root.insertBefore(f.basicAuthPassword, rows.basicAuth.error);
    f.basicAuthPassword.style.marginTop = "4px";
    for (const r of Object.values(rows)) form.append(r.root);
    const save = el("input", { type: "button", class: "menu_button", value: "\u4FDD\u5B58" });
    const status = el("small", { style: "margin-left:8px" });
    const foot = el("div", { style: "margin-top:6px" });
    foot.append(save, status);
    form.append(foot);
    form.append(el("small", { style: "opacity:.65;display:block;margin-top:8px" }, "Chromium \u8DEF\u5F84\u7B49\u672A\u5728\u6B64\u5217\u51FA\u7684\u9009\u9879\u53EA\u80FD\u5728 config.json \u91CC\u4FEE\u6539\u3002\u884C\u52A8\u9009\u9879\u89C4\u5219\u89C1\u63D2\u4EF6\u76EE\u5F55\u4E0B\u7684 choice-rules.json\uFF08\u6539\u5B8C\u65E0\u9700\u91CD\u542F\uFF09\u3002"));
    let original;
    const clearErrors = () => {
      for (const r of Object.values(rows)) r.error.textContent = "";
    };
    const showErrors = (errs) => {
      for (const e of errs) {
        const r = rows[e.field] ?? rows[e.field === "basicAuth" ? "basicAuth" : ""];
        if (r) r.error.textContent = `${fieldLabel(e.field)}\uFF1A${e.message}`;
        else status.textContent = `${fieldLabel(e.field)}\uFF1A${e.message}`;
      }
    };
    const fill = (v) => {
      original = v;
      f.botToken.value = "";
      f.botToken.placeholder = v.botToken.set ? "\u5DF2\u8BBE\u7F6E\uFF0C\u7559\u7A7A\u8868\u793A\u4E0D\u4FEE\u6539" : "123456789:AA...\uFF08\u4ECE @BotFather \u83B7\u53D6\uFF09";
      f.allowedUserIds.value = v.allowedUserIds.join(", ");
      f.telegramProxy.value = v.telegramProxy;
      f.stBaseUrl.value = v.stBaseUrl;
      f.basicAuthUser.value = v.basicAuth?.username ?? "";
      f.basicAuthPassword.value = "";
      f.basicAuthPassword.placeholder = v.basicAuth?.passwordSet ? "\u5DF2\u8BBE\u7F6E\uFF0C\u7559\u7A7A\u8868\u793A\u4E0D\u4FEE\u6539" : "\u5BC6\u7801";
      f.idleShutdownMinutes.value = String(v.idleShutdownMinutes);
      f.lowMemory.checked = v.lowMemory;
      f.dialogueStyle.value = v.dialogueStyle;
      f.draftIntervalSeconds.value = String(v.draftIntervalSeconds);
      f.draftMode.value = v.draftMode;
      f.choiceLayout.value = v.choiceLayout;
      f.logLevel.value = v.logLevel;
    };
    const showBanner = (r) => {
      banner.textContent = "";
      if (r.exists === false) banner.append(el("div", {}, "\u8FD8\u6CA1\u6709 config.json\uFF1A\u586B\u597D Bot Token \u548C\u5141\u8BB8\u7684\u7528\u6237 ID \u540E\u4FDD\u5B58\uFF0C\u7136\u540E\u91CD\u542F ST\u3002"));
      else if (r.running === false) {
        banner.append(el("div", {}, "\u63D2\u4EF6\u5F53\u524D\u6CA1\u6709\u542F\u52A8\uFF08\u914D\u7F6E\u6709\u8BEF\uFF09\u3002\u4FEE\u6B63\u540E\u4FDD\u5B58\u5E76\u91CD\u542F ST\uFF1A"));
        for (const e of r.startErrors ?? []) banner.append(el("div", { style: "opacity:.8" }, `\xB7 ${e.field}\uFF1A${e.message}`));
      }
    };
    const request = async (method, body) => {
      const headers = ctx().getRequestHeaders();
      const res = await fetch(`${PLUGIN_BASE}/config`, { method, headers, body: body === void 0 ? void 0 : JSON.stringify(body) });
      let json;
      try {
        json = await res.json();
      } catch {
        return { ok: false, error: `\u670D\u52A1\u7AEF\u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u5185\u5BB9\uFF08HTTP ${res.status}\uFF09\u3002\u63D2\u4EF6\u53EF\u80FD\u6CA1\u6709\u52A0\u8F7D\uFF0C\u68C0\u67E5 ST \u7684 enableServerPlugins\u3002` };
      }
      return res.ok ? json : { ...json, ok: false, error: json.error ?? `HTTP ${res.status}` };
    };
    const load = async () => {
      status.textContent = "\u8BFB\u53D6\u4E2D\u2026";
      try {
        const r = await request("GET");
        if (!r.ok || !r.values) {
          status.textContent = r.error ?? "\u8BFB\u53D6\u914D\u7F6E\u5931\u8D25";
          return;
        }
        showBanner(r);
        fill(r.values);
        status.textContent = "";
      } catch (e) {
        status.textContent = `\u8BFB\u53D6\u914D\u7F6E\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`;
      }
    };
    save.addEventListener("click", () => {
      void (async () => {
        clearErrors();
        const form2 = {
          botToken: f.botToken.value,
          allowedUserIds: f.allowedUserIds.value,
          telegramProxy: f.telegramProxy.value,
          stBaseUrl: f.stBaseUrl.value,
          basicAuthUser: f.basicAuthUser.value,
          basicAuthPassword: f.basicAuthPassword.value,
          idleShutdownMinutes: f.idleShutdownMinutes.value,
          lowMemory: f.lowMemory.checked,
          dialogueStyle: f.dialogueStyle.value,
          draftIntervalSeconds: f.draftIntervalSeconds.value,
          draftMode: f.draftMode.value,
          choiceLayout: f.choiceLayout.value,
          logLevel: f.logLevel.value
        };
        const built = buildPatch(form2, original);
        if (!built.ok) {
          showErrors(built.errors);
          status.textContent = "\u6709\u8F93\u5165\u9700\u8981\u4FEE\u6B63\u3002";
          return;
        }
        status.textContent = "\u4FDD\u5B58\u4E2D\u2026";
        try {
          const r = await request("POST", { settings: built.patch });
          if (!r.ok) {
            if (r.errors) {
              showErrors(r.errors);
              status.textContent = "\u6CA1\u6709\u4FDD\u5B58\uFF1A\u6709\u8F93\u5165\u9700\u8981\u4FEE\u6B63\u3002";
            } else status.textContent = r.error ?? "\u4FDD\u5B58\u5931\u8D25";
            return;
          }
          status.textContent = saveSummary(r);
          if (r.values) fill(r.values);
          showBanner({ ...r, running: void 0, exists: true });
        } catch (e) {
          status.textContent = `\u4FDD\u5B58\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`;
        }
      })();
    });
    void load();
  }

  // src/extension/index.ts
  var HEARTBEAT_MS = 15e3;
  var READY_TIMEOUT_MS = 18e4;
  var LOG = "[silly-tg]";
  async function stVersion() {
    try {
      const r = await fetch("/version");
      const j = await r.json();
      return `${detectApp()} ${j.pkgVersion ?? j.agent ?? "unknown"}`;
    } catch {
      return `${detectApp()} unknown`;
    }
  }
  function tavernHelperCheck() {
    const ok = typeof globalThis.TavernHelper === "object";
    return ok ? { name: "tavernHelper", ok: true } : { name: "tavernHelper", ok: false, detail: "\u672A\u68C0\u6D4B\u5230\u9152\u9986\u52A9\u624B\uFF08JS-Slash-Runner\uFF09\u3002\u524D\u7AEF\u5361\u7247\u548C\u53D8\u91CF\u529F\u80FD\u4E0D\u53EF\u7528\uFF0C\u7EAF\u6587\u5B57\u5BF9\u8BDD\u4E0D\u53D7\u5F71\u54CD\u3002" };
  }
  function mvuCheck() {
    const ok = typeof globalThis.Mvu !== "undefined";
    return ok ? { name: "mvu", ok: true } : {
      name: "mvu",
      ok: false,
      detail: "\u5F53\u524D\u89D2\u8272\u6CA1\u6709\u52A0\u8F7D MVU\u3002\u5982\u679C\u8FD9\u5F20\u5361\u4F9D\u8D56 MVU \u53D8\u91CF\uFF0C\u9700\u8981\u5728\u9152\u9986\u52A9\u624B\u91CC\u542F\u7528\u89D2\u8272\u811A\u672C\uFF1B\u4E0D\u7528 MVU \u7684\u5361\u53EF\u4EE5\u5FFD\u7565\u3002"
    };
  }
  async function main() {
    const nonce = parseHostNonce(location.hash);
    const testFlags = parseHostTestFlags(location.hash);
    if (!getHostApi()) return;
    if (!nonce) {
      mountSettings();
      return;
    }
    let alive = true;
    const cleanups = [];
    const shutdown = (reason) => {
      if (!alive) return;
      alive = false;
      for (const fn of cleanups.splice(0)) fn();
      console.warn(`${LOG} host \u6A21\u5F0F\u5DF2\u505C\u6B62\uFF1A${reason}`);
    };
    const uplink = new Uplink(nonce, () => shutdown("\u670D\u52A1\u7AEF\u62D2\u7EDD\u4E86 nonce\uFF08\u9875\u9762\u5DF2\u8FC7\u671F\uFF09"));
    const report = (e) => void uplink.send(e);
    const queue = new SerialQueue();
    const lastDialog = { text: "", at: 0 };
    cleanups.push(
      startDialogWatcher({
        onDismiss: (d) => {
          if (d.text === lastDialog.text && Date.now() - lastDialog.at < 3e4) return;
          lastDialog.text = d.text;
          lastDialog.at = Date.now();
          report({ type: "hostLog", level: "info", message: `\u5DF2\u81EA\u52A8\u5173\u95ED\u5F39\u7A97\uFF08${d.button}\uFF09\uFF1A${d.text}` });
        }
      })
    );
    captureToasts();
    if (await waitAppReady(READY_TIMEOUT_MS) === "timeout") {
      report({ type: "hostLog", level: "warn", message: `\u7B49\u5F85 APP_READY \u8D85\u8FC7 ${READY_TIMEOUT_MS / 1e3} \u79D2\uFF0C\u7EE7\u7EED\u521D\u59CB\u5316` });
    }
    if (!alive) return;
    const csrf = await applyCsrfPatchAndCheck({ skipPatch: testFlags.skipCsrfPatch });
    const restored = await queue.run(() => restoreActiveCharacter());
    report({
      type: "hostLog",
      level: restored.restored ? "info" : "warn",
      message: restored.restored ? `\u5DF2\u6253\u5F00\u6700\u8FD1\u4F7F\u7528\u7684\u89D2\u8272\uFF1A${restored.name}` : `\u6CA1\u6709\u81EA\u52A8\u6253\u5F00\u89D2\u8272\uFF1A${restored.reason}`
    });
    let helloStatus = 0;
    for (let i = 0; i < 5 && alive; i++) {
      try {
        helloStatus = await uplink.sendNow({
          type: "hello",
          nonce,
          stVersion: await stVersion(),
          hasTavernHelper: typeof globalThis.TavernHelper === "object"
        });
        if (helloStatus < 500) break;
      } catch {
      }
      await new Promise((r) => setTimeout(r, 2e3));
    }
    if (helloStatus !== 200) {
      shutdown(`hello \u672A\u88AB\u63A5\u53D7\uFF08HTTP ${helloStatus || "\u7F51\u7EDC\u9519\u8BEF"}\uFF09`);
      return;
    }
    const es = new EventSource(`${PLUGIN_BASE}/host/events?nonce=${encodeURIComponent(nonce)}`);
    cleanups.push(() => es.close());
    es.onmessage = (m) => {
      let raw;
      try {
        raw = JSON.parse(m.data);
      } catch {
        return;
      }
      const cmd = decodeHostCommand(raw);
      if (!cmd) {
        const id = raw?.id;
        if (typeof id === "string") report({ type: "rpcResult", id, ok: false, error: "\u65E0\u6CD5\u8BC6\u522B\u7684\u547D\u4EE4" });
        return;
      }
      handleCommand(cmd);
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) shutdown("SSE \u8FDE\u63A5\u88AB\u5173\u95ED");
    };
    const hb = setInterval(() => report({ type: "heartbeat" }), HEARTBEAT_MS);
    cleanups.push(() => clearInterval(hb));
    const runChecks = async () => {
      const api = await queue.run(() => ensureApiConnected());
      if (alive) report({ type: "selfCheck", items: [csrf, tavernHelperCheck(), mvuCheck(), api] });
    };
    void runChecks();
    const c = ctx();
    let chatTimer = null;
    const onChatChanged = () => {
      if (chatTimer) clearTimeout(chatTimer);
      chatTimer = setTimeout(() => void runChecks(), 3e3);
    };
    c.eventSource.on(c.eventTypes.CHAT_CHANGED, onChatChanged);
    cleanups.push(() => c.eventSource.removeListener(c.eventTypes.CHAT_CHANGED, onChatChanged));
    const seen = /* @__PURE__ */ new Map();
    const reportError = (message) => {
      if (isKnownNoise({ kind: "error", message })) return;
      const now = Date.now();
      if ((seen.get(message) ?? 0) > now - 3e4) return;
      seen.set(message, now);
      report({ type: "hostError", message: message.slice(0, 500) });
    };
    const onError = (e) => reportError(`${e.message}${e.filename ? ` (${e.filename}:${e.lineno})` : ""}`);
    const onRejection = (e) => {
      const r = e.reason;
      reportError(`\u672A\u5904\u7406\u7684 Promise \u62D2\u7EDD\uFF1A${typeof r?.message === "string" ? r.message : String(e.reason)}`);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    cleanups.push(() => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    });
    function handleCommand(cmd) {
      const reply = (ok, result, error) => report({ type: "rpcResult", id: cmd.id, ok, result, error });
      const fail = (e) => reply(false, void 0, e instanceof Error ? e.message : String(e));
      try {
        const generation = (generationId, request) => {
          let started = false;
          queue.run(async () => {
            await ensureApiConnected();
            await runGeneration({
              generationId,
              request,
              report,
              onStarted: () => {
                started = true;
                reply(true, { generationId });
              }
            });
          }).catch((e) => {
            if (!started) fail(e);
            else report({ type: "generationFailed", generationId, reason: e.message });
          });
        };
        const queued = (fn) => {
          queue.run(fn).then(
            (r) => reply(true, r),
            (e) => fail(e)
          );
        };
        switch (cmd.type) {
          case "send":
            generation(cmd.generationId, { kind: "send", text: cmd.text });
            return;
          case "regenerate":
            generation(cmd.generationId, { kind: "regenerate", chatId: cmd.chatId, messageId: cmd.messageId });
            return;
          case "listCharacters":
            queued(listCharacters);
            return;
          case "selectCharacter":
            queued(() => selectCharacter(cmd.characterId));
            return;
          case "listChats":
            queued(listChats);
            return;
          case "openChat":
            queued(() => openChat(cmd.fileName));
            return;
          case "newChat":
            queued(newChat2);
            return;
          case "listPresets":
            queued(listPresets);
            return;
          case "selectPreset":
            queued(() => selectPreset(cmd.name));
            return;
          // 重新加载无头页面，让它读到 ST 里新增的预设等数据（ST 只在页面加载时读一次，别的标签页里的改动它看不到）。
          // 先回应再刷新；页面重载后重新连上 host 通道并发 hello。
          case "refreshPage":
            if (hostStatus().generating) {
              fail(new Error("\u6B63\u5728\u751F\u6210\uFF0C\u6682\u4E0D\u5237\u65B0\u9875\u9762"));
              return;
            }
            reply(true, {});
            setTimeout(() => location.reload(), 300);
            return;
          // 不进队列：生成进行中也要立即执行
          case "stop":
            reply(true, { stopped: ctx().stopGeneration() });
            return;
          case "getStatus":
            reply(true, hostStatus());
            return;
          default:
            reply(false, void 0, `\u547D\u4EE4 ${cmd.type} \u4E0D\u652F\u6301`);
        }
      } catch (e) {
        fail(e);
      }
    }
    console.info(`${LOG} host \u6A21\u5F0F\u5DF2\u542F\u52A8`);
  }
  main().catch((e) => console.error(`${LOG} host \u521D\u59CB\u5316\u5931\u8D25`, e));
})();
