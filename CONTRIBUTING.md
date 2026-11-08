# 贡献指南

欢迎提 Issue 和 PR。

## 开发

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Node 20 及以上。提交前这四条命令都要通过。

## 关于 `dist/`

`dist/` 是提交到仓库的构建产物：ST 的服务端插件更新只做 `git pull`，不会构建，用户机器上也不一定有 pnpm。所以改了 `src/` 之后要运行 `pnpm build`，把 `dist/` 的变化一起提交。CI 会检查 `dist/` 和源码是否一致。

## 约定

- 提交信息用 `feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:` 开头。
- 改了行为要补测试；修 bug 先写一个能复现它的测试。
- 注释和文档用中文，保持与现有代码一致。
- 不要提交 `config.json`、日志，或任何含 token、用户 ID 的内容。
- 联调用环境变量：`SILLY_TG_CONFIG`（配置文件路径）、`SILLY_TG_OFFLINE=1`（不连接 Telegram）、`SILLY_TG_DATA_DIR`（数据目录）。

## 提 Issue

请带上：ST（或 Luker）版本、插件版本、`logLevel: debug` 的相关日志片段（先确认里面没有 token）、`/status` 的输出。
