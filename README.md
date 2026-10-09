# Cute Island

<p align="center">
  <img src="build/icon.png" width="128" alt="Cute Island 图标：米色圆角底上的黑胶囊，里面是橙、绿、蓝三颗圆点">
</p>

Windows、macOS、Linux 上的 PC 灵动岛。黑胶囊贴在屏幕顶部正中，用来看 agent 正在做什么。

闲置时它收成一条细胶囊。有活动时变成紧凑态：左侧是状态图标，右侧是一行标题。点一下展开，能看到 agent 名称、说明、进度、最近步骤和耗时。成功会短暂打勾后收回；失败保持展开，直到被新状态盖掉，或点「关闭」。

## 开发

需要 Node.js 22.12 或更高版本。

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

多个活动同时存在时，按 agent 分组显示会话列表，点击各行查看详情。同一 agent 内按失败、执行、思考、等待、成功排序。

## 自动识别本机会话

应用启动时会恢复已经开始的本机会话，之后持续跟踪四种 agent 的日志。明确的回合结束标记会显示完成；工具失败或回合失败保持可见，直到关闭或有新状态。

检测到 agent 进程时，会从最近 24 小时、每种 agent 最新 64 个候选记录中寻找未结束的会话；已跟踪的会话不会因超过这个窗口而消失。新版 Claude Code 的忙碌会话还会通过 `~/.claude/sessions/<PID>.json` 和存活 PID 关联，可恢复超过 24 小时的长任务。没有进程依据时只检查最近两分钟的记录，且不复活旧的完成记录。文件暂时不更新不会被当作成功；已跟踪任务在进程消失且日志静默超过一分钟后显示中断。

| Agent | 记录位置 |
| --- | --- |
| Claude Code | `~/.claude/projects/<项目>/<会话>.jsonl` |
| Codex | `~/.codex/sessions/年/月/日/rollout-*.jsonl` |
| Gemini | `~/.gemini/tmp/<项目>/chats/session-*.json`，兼容 JSONL |
| Cursor | `~/.cursor/projects/<项目>/agent-transcripts/<会话>/<会话>.jsonl` |

Windows 上这些目录在 `%USERPROFILE%` 下面，布局相同。可以用 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GEMINI_CLI_HOME`、`CURSOR_HOME` 改根目录。支持原生可执行文件及通过 Node.js 启动的 npm agent。设置 `CUTE_ISLAND_WATCH=0` 可以关掉自动识别，只保留上面的 HTTP 接口。

扫描使用异步 I/O：已发现的日志约每 800 毫秒检查一次，新文件约每 10 秒发现一次，进程查询间隔 5 秒；内容未变化时不重新读取和解析。JSONL 默认只读末尾 256 KiB，必要时扩展到 4 MiB；Gemini JSON 整份读取，上限 16 MiB。

自动识别依赖各 agent 实际写出的日志。除可关联的 Claude 会话外，进程检测只能证明某种 agent 在运行，无法精确区分该进程下所有会话；缺少结束标记的旧日志仍可能被判断为活动。需要精确状态时可以使用 HTTP/CLI 推送。

## 窗口

窗口无边框、透明、置顶，不进任务栏，也不抢焦点。只有胶囊本身接收点击，周围的透明区域会把鼠标让给下面的窗口。托盘菜单可以显示、隐藏、播放演示或退出。

macOS 使用 panel，并在全屏空间保持可见。Windows 和 Linux 使用 screen-saver 级别置顶。Linux 需要桌面合成器，透明窗口才能透出后面的内容。

## 打包

```bash
npm run dist
```

该命令依次执行类型检查、测试、构建和当前平台打包，产物在 `release/`。仅生成可运行目录时用 `npm run pack`。配置已经写好 Windows NSIS、macOS dmg、Linux AppImage 和 deb。三端安装包都用 `build/icon.png`。

生产构建压缩 JS/CSS，React 和动画库只保留构建后的代码，不重复分发其 npm 包。Electron 仅打包简体中文、繁体中文和英语资源，并启用最大压缩；需要其他系统对话框语言时可扩展 `build.electronLanguages`。运行时仍使用 Electron，安装体积的主要部分来自 Chromium/Node.js。

Windows 打包后的集成验证（使用隔离的临时用户目录和端口，不安装应用）：

```bash
node scripts/smoke-packaged.cjs "release/win-unpacked/Cute Island.exe"
```

它验证启动前会话恢复、HTTP、preload、展开/关闭、成功自动收起和空闲布局开销，并将截图存入 `release/`。

推送版本标签，或在 Actions 里手动运行 Release，都会在三端打包成功后发布到这个仓库的 [Releases](https://github.com/xihadance/cute-island/releases)。手动运行时，标签取 `package.json` 里的版本号，例如当前是 `v0.1.1`。

```bash
git tag v0.1.1
git push origin v0.1.1
```

## 图标

应用图标是米色圆角方块，中间一条黑胶囊，胶囊里三颗圆点：橙、绿、蓝。

| 文件 | 用途 |
| --- | --- |
| `build/icon.png` | 1024 像素，Windows、macOS、Linux 安装包图标 |
| `build/tray.png` | 32 像素托盘图标源图。运行时托盘读 `src/main/tray-icon.ts` 里嵌进去的同一张图 |
| `src/renderer/favicon.png` | 开发时浏览器页签图标，由 `src/renderer/index.html` 引用 |
