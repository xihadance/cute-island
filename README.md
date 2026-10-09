# Cute Island

Windows、macOS、Linux 上的 PC 灵动岛。黑胶囊贴在屏幕顶部正中，用来看 agent 正在做什么。

闲置时它收成一条细胶囊。有活动时变成紧凑态：左侧是状态图标，右侧是一行标题。点一下展开，能看到 agent 名称、说明、进度、最近步骤和耗时。成功会短暂打勾后收回；失败保持展开，直到被新状态盖掉，或点「关闭」。

## 开发

```bash
npm install
npm run dev
```

只看界面、不启动 Electron 时：

```bash
npm run dev:web
```

浏览器打开 http://127.0.0.1:5174 。页面底部可以播放演示、模拟失败或清空。

## 把状态推过来

应用只监听 `127.0.0.1:17321`。端口用 `CUTE_ISLAND_PORT` 改。如果设置了 `CUTE_ISLAND_TOKEN`，请求要带 `Authorization: Bearer <token>` 或 `X-Island-Token`。

```bash
npm run island -- push --agent Cursor --state running --title "正在修改登录页" --progress 0.4
npm run island -- end --result success --summary "登录页已更新"
npm run island -- demo
```

也可以直接 POST：

```bash
curl -X POST http://127.0.0.1:17321/v1/activities \
  -H 'content-type: application/json' \
  -d '{"id":"run-1","agent":"Cursor","state":"running","title":"正在修改登录页","progress":0.4}'

curl -X POST http://127.0.0.1:17321/v1/activities/run-1/end \
  -H 'content-type: application/json' \
  -d '{"result":"success","summary":"登录页已更新"}'
```

`state` 可以是 `thinking`、`running`、`waiting`、`success`、`error`。同一个 `id` 再次 POST 会合并更新。`GET /v1/activities` 返回当前活动。`WS /v1/events` 会在每次变化时推送 `{ "type": "activities", "activities": [...] }`。

多个活动同时存在时，紧凑态显示优先级最高的一条：失败、执行、思考、等待、成功。展开后能看到其余条数。

## 自动识别本机会话

应用启动后会看这四个 agent 写在本机的会话记录。文件还在更新时，灵动岛显示思考、工具调用或等待；这一轮写完就显示完成，工具失败或回合失败则保持展开。两分钟以前的历史不会被翻出来。

| Agent | 记录位置 |
| --- | --- |
| Claude Code | `~/.claude/projects/<项目>/<会话>.jsonl` |
| Codex | `~/.codex/sessions/年/月/日/rollout-*.jsonl` |
| Gemini | `~/.gemini/tmp/<项目>/chats/session-*.jsonl` |
| Cursor | `~/.cursor/projects/<项目>/agent-transcripts/<会话>/<会话>.jsonl` |

Windows 上这些目录在 `%USERPROFILE%` 下面，布局相同。可以用 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GEMINI_CLI_HOME`、`CURSOR_HOME` 改根目录。Claude、Codex、Gemini 以及 `cursor-agent` 进程还在跑时，稍微久一点没写文件也会继续算作这一轮。设置 `CUTE_ISLAND_WATCH=0` 可以关掉自动识别，只保留上面的 HTTP 接口。

## 窗口

窗口无边框、透明、置顶，不进任务栏，也不抢焦点。只有胶囊本身接收点击，周围的透明区域会把鼠标让给下面的窗口。托盘菜单可以显示、隐藏、播放演示或退出。

macOS 使用 panel，并在全屏空间保持可见。Windows 和 Linux 使用 screen-saver 级别置顶。Linux 需要桌面合成器，透明窗口才能透出后面的内容。

## 打包

```bash
npm run build
npx electron-builder
```

配置已经写好 Windows NSIS、macOS dmg、Linux AppImage 和 deb。图标在 `build/icon.png`。

推送版本标签后，GitHub Actions 会在三端打包，并发布到这个仓库的 Release：

```bash
git tag v0.1.0
git push origin v0.1.0
```
