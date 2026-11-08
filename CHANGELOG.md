# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] - 未发布

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
