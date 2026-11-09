# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [未发布]

## [0.3.0] - 2026-11-09

### 修复
- 连接 Telegram 收到 401 时，不再提示“检查代理是否可用”（收到 401 说明网络和代理是通的），改为指向 botToken。

### 新增
- 在 ST 的“安装扩展”里直接粘贴仓库链接即可安装 UI 扩展（仓库根目录新增 `manifest.json`，指向提交在仓库里的 `dist/extension`）。两份 manifest 都带 `auto_update`，并有测试防止版本号漂移。
- “扩展”设置栏里的 Silly TG 在检测到服务端插件没装（接口返回 HTTP 404）时，显示安装引导（可一键复制的 `git clone` 命令、`enableServerPlugins`、重启提示），而不是报错；网络错误、401、5xx 仍显示原来的错误提示。
- UI 与服务端版本检查：`hello` 增加可选字段 `extVersion`，两边版本不一致时服务端日志警告（不拒绝连接；旧版 UI 不带该字段照常连接）。
- UI 扩展单例保护：被加载了两份时只运行先加载的一份，另一份在控制台和 toast 里提示。
- README 前部增加两部分缺一不可、`enableServerPlugins` 默认 `false` 必须开启的提示，安装改写为“面板粘贴链接”和“直接 git clone”两条路径，新增“更新与卸载”一节。
- Telegram 代理支持环境变量兜底：`config.json` 的 `telegramProxy` 为空时，读取 `HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY`、`http_proxy`、`ALL_PROXY`、`all_proxy`（按此顺序取第一个非空值）以及 `NO_PROXY`；只支持 http/https，socks 等协议会警告并忽略（直连）。`telegramProxy` 优先于环境变量。
- 无头浏览器启动失败时，在原始报错后追加一句可操作的修法（沙箱不可用、缺系统库、snap 版 Chromium、以 root 运行、找不到浏览器），同时出现在日志和 `/status`；认不出的报错保留原文并附通用提示。
- 找不到浏览器的提示新增 `android`（Termux）：原生 Termux 不支持，请用 proot-distro 里的 Debian；Linux 的提示补充了 Ubuntu snap 的说明。
- `/status` 增加“Telegram 代理”一行，显示来源（配置 / 环境变量 / 无）和主机，不显示账号密码。
- 文档 `docs/install-linux.md`：Debian、Ubuntu（用 Google Chrome 的 deb，不用 snap）、Termux（经 proot-distro 的 Debian，推断路线，待社区验证）的安装步骤，以及沙箱开关 `PUPPETEER_DANGEROUS_NO_SANDBOX`、SSH 隧道配置 API、systemd 托管、代理验证。
- README 增加“无头服务器与 Linux”入口，故障排查指向新文档，配置一节说明代理环境变量兜底。

### 变更
- UI 扩展的自动部署改为幂等且原子：部署目录里写入 `.silly-tg-deploy.json`（版本和内容哈希），内容一致就不重复复制；先复制到同级临时目录再替换，失败不留空目录。目标目录是软链接、带 `.git` 或不能确认是本插件部署的，不会被删除或覆盖，只给出警告和手动步骤。
- 插件启动时发现 ST 里已有面板安装的副本（`manifest.json` 带 `silly_tg: true`，扫描全局 `third-party` 和 `default-user` 的用户级扩展目录）会跳过自动复制，并清理旧的自动部署副本，避免加载两份。只有服务端插件的老用户行为不变。
- “扩展没有连接”的报错同时提到面板安装的副本，并提醒检查扩展是否被停用。
- 行为变化：设了 `HTTPS_PROXY` 等环境变量、且没有配置 `telegramProxy` 的机器上，访问 Telegram 会改走该代理（之前一律直连）。启动日志会写明代理来源；不想走代理时取消环境变量，或用 `NO_PROXY` 排除。

## [0.2.0] - 2026-11-08

### 新增
- `/preset`：在 Telegram 里分页切换当前 API 的预设；`/status` 显示当前预设。
- `/menu` 主菜单和 Telegram 命令菜单（输入 `/` 可选）。
- 新聊天（`/new`、切换到只有开场白的角色）自动发出开场白，同一聊天只发一次。
- 行动选项按钮：解析回复末尾的选项（内置 `<SUOT>` 与“标题+编号列表”），点按钮即发送；规则放在 `choice-rules.json`，热加载。附 `docs/choices.md`、样例、`pnpm choices:test` 和 `skills/silly-tg-choice-rules`。
- 酒馆扩展栏里的“Silly TG”配置面板：读写 `config.json`，密码掩码，对话样式、日志级别、空闲关闭保存后立即生效。

- `/settings`：在 Telegram 里切换对话样式、生成时预览方式、预览刷新间隔、行动选项按钮排版，保存到 `config.json` 并立即生效；这几项同时出现在酒馆扩展栏的配置面板里。
- 新增配置项 `draftIntervalSeconds`、`draftMode`、`choiceLayout`（都可热生效），用来缓解流式生成时聊天窗口上下滚动，以及选择行动选项按钮的排版。
- 行动选项消息最下面增加 🔄 按钮，点一下重新生成上一条回复。

### 变更
- 菜单、命令说明、列表、`/settings`、`/status`、行动选项和各类提示、报错统一加 emoji：✅ 成功、❌ 失败、⚠️ 警告、⏳ 进行中、🟢🟡🔴 状态；列表里当前项用 ✅ 标记；选项消息的 🔄 按钮改为“🔄 重新生成”。
- 页面通道超时、未连接、断开时，报错改成能照着做的说明（例如提示等一会儿再试或发 `/status`）。
- 配置有误或还没有 `config.json` 时，配置面板的接口仍然可用（其余路由不注册），以便用面板修好配置。
- 扩展在普通 ST 页面不再完全静默：会在扩展栏渲染配置面板并读取一次配置，仍不处理命令、不连接 host 通道。

### 修复
- 切换到前端很重的角色卡时报“切换角色超时”：页面其实已经切过去，只是加载比等待时间慢。切换角色、打开聊天、新建聊天的等待宽限期从 5 秒改为 30 秒，超时报错会说明卡在哪一步。
- 对话样式（`dialogueStyle`）现在也作用于「…」『…』形式的对话。之前只有酒馆包成 `<q>` 的引号内容才有样式，用「」写对话的角色卡切换样式没有任何变化。
- `/preset`、`/chars` 看不到在酒馆里新增的预设和角色卡：无头页面只在加载时读一次。现在发这两个命令时先刷新无头页面，再按 bot 记着的会话恢复角色和聊天，然后列出（刷新失败仍用现有列表；`/chats` 每次从服务器读，不刷新）。

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
