# 在 Linux 服务器和手机上安装

适用于没有桌面环境的机器：Debian、Ubuntu 服务器，以及手机上的 Termux。

插件不自带浏览器，需要系统里有 Chrome 或 Chromium；它以无头方式运行，**不需要显示器**。所以在服务器上要做三件事：装浏览器、装插件、处理好沙箱和代理。

> [!NOTE]
> 状态说明：Debian 13 和 Ubuntu 25.04（均为 LXC 容器，amd64）已按本文步骤实测过，**未实测**的地方会标出。Termux 路线是推断，**待社区验证**。

## 先看你是哪种环境

| 环境 | 浏览器 | 看哪一节 |
|---|---|---|
| Debian | `apt install chromium`（真正的 deb 包） | [Debian](#debian) |
| Ubuntu | **不要用** apt 里的 `chromium-browser`（它会装 snapd，变成 snap 版），装 Google Chrome 的 deb | [Ubuntu](#ubuntu) |
| 手机 Termux | 原生 Termux 不支持，经 proot-distro 里的 Debian | [Termux](#termux手机推断待社区验证) |

## 前提

- SillyTavern 1.19 及以上，Node.js 20 及以上。Debian 13 的 apt 自带 Node 20.19，直接 `apt install nodejs npm` 就够；Debian 12、Ubuntu 的 apt 版本可能低于 20（先看 `apt-cache policy nodejs`），这时用 [nvm](https://github.com/nvm-sh/nvm) 或 NodeSource 安装。装完 `node -v` 确认。
- 已有 Telegram bot 的 token 和你自己的数字 ID（见 [README 前提条件](../README.md#前提条件)）。
- 约 1 GB 可用内存（2 GB 的机器建议保持 `lowMemory: true` 并设置 `idleShutdownMinutes`）。`lowMemory: true` 会把无头页面的 JS 内存限制在 256 MB，页面长时间运行会涨到上限，插件会在 bot 空闲时自动重载页面回收（见 [README 使用提醒](../README.md#使用提醒)第 5 条）。

没有 ST 的话先装一份，并**用普通用户而不是 root 运行**：

```bash
git clone https://github.com/SillyTavern/SillyTavern -b release
cd SillyTavern
```

> [!TIP]
> 国内网络直连 GitHub 可能中途断开（`GnuTLS recv error` 之类）。已经有 HTTP 代理的话，克隆前先 `git config --global http.proxy http://127.0.0.1:7890`（换成你的地址），`npm install` 会读 `HTTPS_PROXY` 环境变量。

后面的命令都在这个 ST 根目录下执行。

## Debian

```bash
sudo apt update
sudo apt install -y chromium git curl nodejs npm     # Debian 12 的 nodejs 低于 20，见上面的前提
chromium --version        # 能打印版本号就行
```

Debian 的 `chromium` 是真正的 deb 包，**普通用户直接可以运行，沙箱保持开启，不需要任何额外设置**，插件在 PATH 里能找到它（Debian 13 已实测）。最小化的 Debian 里没有 `curl`，所以上面一并装上，后面验证代理要用。接着看[安装插件](#安装插件)。

## Ubuntu

Ubuntu 的 apt 里没有真正的 `chromium` 包，`chromium-browser` 只是个过渡包，会装上 snapd 再下载 snap 版（Ubuntu 25.04 已确认）。snap 版的沙箱和临时目录限制会让无头启动失败，插件检测到会提示改装 deb 版。推荐直接装 Google Chrome 的 deb：

```bash
sudo apt update
sudo apt install -y git wget curl
cd /tmp
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
google-chrome-stable --version
```

用 Ubuntu 25.04 实测：装完后普通用户可以直接以无头方式运行，沙箱保持开启。

- ARM 机器把文件名里的 `amd64` 换成 `arm64`（地址存在，**未实测**）。
- 如果之前已经装了 snap 版：`sudo snap remove chromium`，否则插件可能先找到它。也可以在 `config.json` 里把 `chromiumPath` 指向 `/usr/bin/google-chrome-stable`。
- Ubuntu 23.10 以后限制了普通用户创建用户命名空间，Chrome 的沙箱可能起不来，日志会出现 `No usable sandbox`。处理办法见[沙箱](#沙箱什么时候需要关)（未实测：这个限制是 Ubuntu 内核的，在 PVE 的 LXC 里复现不了，需要真正的 Ubuntu 虚拟机或物理机）。

## 安装插件

在 ST 根目录：

```bash
git clone https://github.com/incohua/silly-tg-bridge-plugin plugins/silly-tg-bridge-plugin
```

1. 编辑 `config.yaml`（ST 第一次运行后才会生成，没有的话先 `./start.sh` 跑一次再 Ctrl+C），设置 `enableServerPlugins: true`。**不开启时插件根本不会被加载，也不会有任何提示。** 已经是 `true` 就不用改。 也可以不改文件，启动前设置环境变量 `SILLYTAVERN_ENABLESERVERPLUGINS=true`（ST 的配置项都能用 `SILLYTAVERN_<键名大写，点换下划线>` 覆盖；只对这次启动的进程有效，systemd 里用这种方式更方便）。
2. 启动（或重启）ST：`./start.sh`（它会先 `npm install` 装好依赖）。这是整个流程里**唯一需要的一次重启**。此时还没有 `config.json`，日志里会出现 `[silly-tg] UI 扩展已部署到 ...` 和“插件已待命”，这是正常的。如果你已经在 ST 的“扩展”面板里粘贴链接装过 UI 扩展（见 [README 的安装一节](../README.md#安装)），日志会改为“检测到已通过 ST 安装的 UI 扩展……跳过自动复制”，也是正常的。
3. 填写配置，二选一：
   - 通过 SSH 隧道（见[首次配置 API](#首次配置-api用-ssh-隧道)）在电脑浏览器里打开 ST，在“扩展”设置栏的 Silly TG 里填 Bot Token 和允许的用户 ID，保存。**保存后自动连接，不需要重启 ST。**
   - 或者在第 2 步之前复制 `plugins/silly-tg-bridge-plugin/config.example.json` 为 `plugins/silly-tg-bridge-plugin/config.json`，至少填 `botToken` 和 `allowedUserIds`，启动时就直接连接。
4. 日志里应出现 `Telegram 已连接，bot：@...`。给 bot 发 `/status`，应看到 Chromium、ST 页面都正常。再发 `/chars` 选角色。

ST 默认只监听 `127.0.0.1`，无头 Chromium 也访问这个地址，不需要改任何网络设置。

**更新插件**：ST 默认在启动时对 `plugins/` 下的 git 目录自动 `git pull`（`config.yaml` 的 `enableServerPluginsAutoUpdate`，默认开启），重启 ST 就会更新；`dist/` 已提交到仓库，不需要自己构建。想手动更新就在 `plugins/silly-tg-bridge-plugin` 里 `git pull` 再重启 ST。

## 沙箱：什么时候需要关

Chromium 的沙箱需要系统支持用户命名空间。插件在 **root 运行时自动加 `--no-sandbox`**，其他情况保持沙箱开启。以普通用户运行、而系统不允许创建用户命名空间时（容器的非 root 模式、Ubuntu 23.10 及以上等），Chromium 起不来，日志里会出现 `No usable sandbox` 一类的报错，并附上本节的修法。

修法：在启动 ST 的环境里设置环境变量后重启 ST：

```bash
export PUPPETEER_DANGEROUS_NO_SANDBOX=true
./start.sh
```

用 systemd 托管时写进服务文件，见下一节。

**风险**：这会关闭 Chromium 的沙箱，浏览器被攻破时与系统之间少一层隔离。本插件的无头 Chromium 只访问你自己本机的 ST 页面，风险可以接受；但不要拿同一个浏览器去打开别的网站，也不要把 ST 暴露到公网。这个开关只能用环境变量设置，配置面板里没有。

Ubuntu 23.10 及以上还有另一条路：放宽整机的限制 `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`（重启失效）。它影响整台机器，不如上面的环境变量针对性强，所以不作为推荐（未实测）。

## 首次配置 API：用 SSH 隧道

ST 监听在服务器的 `127.0.0.1`，要在网页里连接大模型 API，就在**你自己的电脑**上开一条隧道：

```bash
ssh -L 8000:127.0.0.1:8000 你的用户名@服务器地址
```

保持这个窗口，然后在电脑浏览器里打开 `http://127.0.0.1:8000`，像平时一样配置 API 并点一次“连接”。无头页面启动时读取已保存的设置（见 [README](../README.md#前提条件)），之后改了 API 设置，要重启 ST 才会用上。

不要为了方便把 ST 直接开放到公网。一定要开放时，先在 ST 里开启登录，因为配置面板能修改 token 和白名单。

## 用 systemd 托管

让 ST 开机自启、崩溃自动重启。先在 ST 根目录手动跑过一次 `./start.sh`（装好依赖、生成 `config.yaml`）。把下面的内容写入 `/etc/systemd/system/sillytavern.service`，把 `User`、`WorkingDirectory`、`ExecStart` 里的路径改成你自己的（`which node` 能看到 node 的路径；用 nvm 装的 node 路径在 `~/.nvm` 下）：

```ini
[Unit]
Description=SillyTavern
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=st
WorkingDirectory=/home/st/SillyTavern
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

# 没改 config.yaml 的话，用环境变量开启服务端插件
#Environment=SILLYTAVERN_ENABLESERVERPLUGINS=true
# 需要时取消注释（见“沙箱”和“代理”两节）
#Environment=PUPPETEER_DANGEROUS_NO_SANDBOX=true
#Environment=HTTPS_PROXY=http://127.0.0.1:7890
#Environment=NO_PROXY=localhost,127.0.0.1

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sillytavern
journalctl -u sillytavern -f        # 看日志，找 [silly-tg] 开头的行
```

## 代理

访问不了 Telegram 的网络需要代理。先在服务器上用 `curl` 验证代理本身可用（把 `<token>` 换成你的 bot token，端口换成你的 HTTP 代理端口）：

```bash
curl -x http://127.0.0.1:7890 -sS -m 10 https://api.telegram.org/bot<token>/getMe
```

返回包含 `"ok":true` 的 JSON 就通了；返回 401 说明代理通了但 token 不对。超时或连接被拒绝，说明代理地址或端口不对，先解决这个。

验证通过后，二选一：

1. **推荐**：在 `config.json` 写 `"telegramProxy": "http://127.0.0.1:7890"`。只影响本插件访问 Telegram。
2. 设置环境变量 `HTTPS_PROXY`（也认 `https_proxy`、`HTTP_PROXY`、`http_proxy`、`ALL_PROXY`、`all_proxy`，按这个顺序取第一个非空值），`NO_PROXY` 同样生效。`config.json` 里有 `telegramProxy` 时以它为准。

注意：

- **只支持 `http://` 和 `https://` 代理。** 代理软件如果只给了 socks 端口，请在软件里找它的 HTTP（混合）端口。环境变量里写了 socks 地址时，日志会警告并改为直连。
- 账号密码用 `http://user:password@host:port` 的写法。日志和 `/status` 不会显示它们。
- 设了 `HTTPS_PROXY` 又没配 `telegramProxy` 的机器上，访问 Telegram 会改走该代理，启动日志会写明代理来源。
- **无头 Chromium 会继承 `HTTPS_PROXY` 等环境变量。** 默认的 `stBaseUrl` 是 `127.0.0.1`，Chromium 对它不走代理；如果你把 `stBaseUrl` 改成了别的地址，请设置 `NO_PROXY` 把它排除，例如 `NO_PROXY=localhost,127.0.0.1,你的ST地址`，否则无头页面会通过代理访问 ST 而打不开。

## Termux（手机）：推断，待社区验证

> [!WARNING]
> 这一节没有在真机上验证过。原生 Termux 里 `process.platform` 是 `android`，没有可用的 Chrome/Chromium，沙箱也大概率起不来，**不支持**；下面是经 proot-distro 的推断路线，卡住的话欢迎提 Issue 反馈结果。

思路：在 Termux 里用 proot-distro 装一个 Debian，在 Debian 里按上面的 [Debian](#debian) 路线装 Chromium 和 ST。proot 里是伪 root，插件会自动关沙箱。

1. 从 [F-Droid 或 GitHub 发布页](https://github.com/termux/termux-app#installation) 装 Termux（按 Termux 官方说明推荐这两个渠道）。
2. 在 Termux 里：

   ```bash
   pkg update && pkg install -y proot-distro
   proot-distro install debian
   proot-distro login debian
   ```

3. 现在你在 Debian 里了（提示符变化）。依次执行：

   ```bash
   apt update && apt install -y chromium git curl
   ```

   然后装 Node.js 20 及以上（见[前提](#前提)），再克隆 ST 和插件、配置、启动，步骤同 [Debian](#debian) 和[安装插件](#安装插件)。
4. 让手机别休眠杀进程：在 Termux 通知栏里点 “Acquire wakelock”，并把 Termux 加入电池优化白名单。
5. 内存紧张时保持 `lowMemory: true`，并设置 `idleShutdownMinutes`（例如 10）。日志里偶尔出现 `Page crashed!` 说明页面撞上了 256 MB 的 JS 内存上限，插件会自动重启并在空闲时提前回收；仍然频繁时才考虑把 `lowMemory` 设为 `false`（需要更多内存）。

如果日志出现沙箱相关的错误，按上面[沙箱](#沙箱什么时候需要关)一节设置 `PUPPETEER_DANGEROUS_NO_SANDBOX=true`。

## 报错对照

启动无头浏览器失败时，日志和 `/status` 会在原始报错后面追加一句 `💡 修法：…`，认不出的报错会保留原文并指向本文档。常见的几类：

| 报错里的关键字 | 含义 | 处理 |
|---|---|---|
| `Could not find Chrome` / 提示找不到浏览器 | 系统里没有浏览器，或不在 PATH 里 | 按上面的路线安装；或在 `config.json` 的 `chromiumPath` 写可执行文件路径 |
| `No usable sandbox` / `Running as root without --no-sandbox` | 沙箱在当前环境不可用 | 设置 `PUPPETEER_DANGEROUS_NO_SANDBOX=true`，见[沙箱](#沙箱什么时候需要关) |
| `error while loading shared libraries` | 缺系统库 | 用发行版自带的包安装（Debian/Ubuntu：`apt install chromium` 会装好依赖），不要手动拷贝浏览器文件 |
| 路径里有 `/snap/` | 用的是 snap 版 Chromium | 改装 deb 版：Debian 用 `apt install chromium`，Ubuntu 用 Google Chrome 的 deb |
| 提示当前是 Termux（android） | 原生 Termux 不支持 | 改用 proot-distro 里的 Debian |
