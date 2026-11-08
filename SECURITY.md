# 安全策略

## 报告漏洞

请不要在公开 Issue 里贴漏洞细节。到本仓库的 **Security → Report a vulnerability** 提交私密报告。

可以报告的例子：绕过 `allowedUserIds` 白名单、通过 bot 读取或写入 ST 的任意文件、日志或页面泄露 bot token、无头页面被另一个网页劫持。

## 使用时的安全提醒

- `config.json` 里有 bot token，不要提交、截图或发给别人。泄露后立即到 @BotFather 里 `/revoke`。
- 只把自己的 Telegram 数字 ID 放进 `allowedUserIds`。
- Telegram 的 bot 对话不是端到端加密，聊天内容会经过 Telegram 服务器。
- ST 端口不需要暴露到公网，插件通过长轮询访问 Telegram。
