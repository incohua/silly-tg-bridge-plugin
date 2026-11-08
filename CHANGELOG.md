# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [未发布]

### 新增
- `/preset`：在 Telegram 里分页切换当前 API 的预设；`/status` 显示当前预设。
- `/menu` 主菜单和 Telegram 命令菜单（输入 `/` 可选）。
- 新聊天（`/new`、切换到只有开场白的角色）自动发出开场白，同一聊天只发一次。
- 行动选项按钮：解析回复末尾的选项（内置 `<SUOT>` 与“标题+编号列表”），点按钮即发送；规则放在 `choice-rules.json`，热加载。附 `docs/choices.md`、样例、`pnpm choices:test` 和 `skills/silly-tg-choice-rules`。
- 酒馆扩展栏里的“Silly TG”配置面板：读写 `config.json`，密码掩码，对话样式、日志级别、空闲关闭保存后立即生效。

### 变更
- 配置有误或还没有 `config.json` 时，配置面板的接口仍然可用（其余路由不注册），以便用面板修好配置。
- 扩展在普通 ST 页面不再完全静默：会在扩展栏渲染配置面板并读取一次配置，仍不处理命令、不连接 host 通道。

## [0.1.0] - 2026-11-08

首个版本，提供文字对话。

### 新增
- 在 Telegram 里与 SillyTavern 1.19+ 或 Luker 对话：流式预览、正式消息（Rich Message，超长自动分段、失败退回纯文本）。
- 命令：`/start` `/help` `/status` `/stop` `/regen` `/chars` `/chats` `/new`；草稿上的停止按钮。
- 无头 Chromium 管理：低内存参数、空闲关闭与按需启动、看门狗自动恢复。
- `dialogueStyle` 配置：对话加粗、斜体、高亮或只保留引号。
- 启动自检：CSRF、酒馆助手、MVU、API 连接。

### 已知限制
- 前端卡片的截图和 Mini App 尚未提供，含卡片的消息只发正文。
- 不支持群聊、多账户、swipe、图片和语音。
