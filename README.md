# qqbot-cli

独立的 QQ 官方机器人通知工具：daemon 保持连接并将消息、发送结果和收到的附件归档到本地；CLI 负责发送、查询和等待。适合被不同 Agent 通过 shell 按需调用，不运行模型或 Agent 会话。

首版支持 **Linux、Node.js 24+、单机器人账号、C2C 私聊**。使用腾讯 `@tencent-connect/qqbot-nodejs` 的协议层；必需运行依赖只有该 SDK 及其 `ws` 依赖。

## 安装与配置

```sh
pnpm install
pnpm build
node dist/cli.js --help
# 将本地项目安装为全局命令，也可以继续使用 node /absolute/path/dist/cli.js
pnpm add --global "$(pwd)"
```

在 QQ 开放平台创建官方机器人，取得 AppID 和 AppSecret，按平台要求配置使用范围、测试用户及网络权限。工具不登录个人 QQ 账号。

```sh
mkdir -p ~/.config/qqbot-cli
chmod 700 ~/.config/qqbot-cli
cp examples/config.json ~/.config/qqbot-cli/config.json
chmod 600 ~/.config/qqbot-cli/config.json
```

编辑配置中的凭证。也可从配置中省略凭证，通过 `QQBOT_APP_ID`、`QQBOT_APP_SECRET` 环境变量传入。环境变量优先；不要将凭证放入命令行。

```sh
qqbot daemon run
```

daemon 前台运行，日志写 stderr。另开终端，在 QQ 中给机器人发送私聊，然后执行：

```sh
qqbot status
qqbot peers
```

将观察到的 OpenID 写入配置的 `"defaultPeer": "YOUR_OPENID"`。这是 CLI 的默认寻址偏好，每次调用都会重新读取，修改后立即生效，无需重启 daemon；也可直接用 `--to` / `--from` / `--peer` 覆盖。CLI 将选定的对象显式传给 daemon，daemon 不读取或回退到 `defaultPeer`。默认接收人不是入站白名单；工具记录平台交给该机器人的所有 C2C 消息。凭证、存储和附件等 daemon 配置在启动时读取，修改这些配置需要重启。

全局选项 `--config PATH`、`--data-dir PATH` 可放在子命令前后。默认配置目录遵循 `XDG_CONFIG_HOME`，数据目录遵循 `XDG_DATA_HOME`。设置自定义 `dataDir` 后，所有 CLI 必须使用相同配置或 `--data-dir`。

## 发送与等待

```sh
qqbot send --text '# 任务完成'
qqbot send --format plain --text '任务完成（纯文本）'
qqbot send --to OPENID --file ./report.pdf --caption '报告'
qqbot send --text - <<'TEXT'
# 任务报告

**状态**：成功
TEXT
```

文字默认使用 QQ 原生 Markdown（`msg_type: 2`、`markdown.content`）。使用 `--format plain` 才发送纯文本（`msg_type: 0`）；也可显式指定 `--format markdown`。`--text - < report.md` 会将文件内容作为消息发送。`--format` 仅适用于 `--text`；`--file` 仍上传富媒体附件，其 caption 为普通文本。

Markdown 需要机器人具备对应权限，且 QQ 支持的语法以客户端实际渲染为准。平台明确拒绝时直接返回错误，不自动改发纯文本；确认拒绝原因后可以手动指定 `--format plain`。返回 `SEND_UNKNOWN` 时不要重复发送。

普通发送优先关联该对象最近的可回复消息，本地默认按 60 分钟、最多 5 个回复序号判断候选；没有候选时尝试主动发送。可用 `--reply-to LOCAL_MESSAGE_ID` 显式回复，或 `--proactive` 主动发送。已选回复若被 QQ 拒绝，直接报错，不自动转主动发送。发送尝试都会消耗一个本地回复序号，避免在不确定状态下复用。

QQ 的权限、时限、频控和实际错误是最终依据。[旧版官方文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)存在主动推送停止提供与旧额度并存的说明；本工具不保证任意时刻都能主动通知。API 接受发送也不表示对方已阅读。

发送返回示例：

```json
{
  "ok": true,
  "data": {
    "message": { "id": "LOCAL_ID", "peerId": "OPENID", "status": "accepted", "format": "markdown" },
    "cursor": 12
  }
}
```

`data.cursor` 是**发送开始前**的游标。先保存完整发送结果，再提取游标等待，可以捕获发送和等待两次调用之间到达的回复：

```sh
qqbot send --to OPENID --text '操作完成，请确认' > /tmp/qqbot-send-result.json
# 检查上一步退出码；以下 jq 仅用于示例，不是项目依赖
cursor=$(jq -er 'select(.ok) | .data.cursor' /tmp/qqbot-send-result.json)
qqbot wait --from OPENID --after "$cursor" --timeout 60
```

游标匹配的是该位置之后的消息，不证明它一定回复了某次通知。每个等待者独立观察，同一消息可以返回给多个等待者，没有共享已读位置。

`wait` 返回第一条匹配的入站消息和它的游标。继续等待时使用这个游标。没有 `--after` 时只等待 daemon 接受请求之后的新消息。`--contains TEXT` 匹配文本子串；默认超时 60 秒，`--timeout 0` 无限等待。超时返回起始游标，可据此继续等待。Ctrl-C 取消当前 CLI；取消发送命令不会撤销已由 daemon 接受的发送。

文件发送支持图片和普通文件，超过 5 MiB 使用 SDK 分片上传，最大尺寸由 SDK 的文件类型限制决定。没有转码或通知重试队列。

本地 IPC 的 `POST /send` 在文本请求中接受 `format: "markdown" | "plain"`，省略时默认 `markdown`；CLI 会显式传入选定的格式。发送记录和历史中的 `format` 保存这次发送的实际选择，升级前没有该字段的出站文本记录按 `plain` 读取，日志无需迁移。

## 历史与附件

```sh
qqbot history --peer OPENID --direction in --limit 20
qqbot history --peer OPENID --after 12 --limit 50
qqbot history --contains '确认' --since 2026-11-09T00:00:00+08:00
```

`history` 支持对象、方向、时间范围、文本子串过滤。默认使用配置的 `defaultPeer`，未配置时查询所有对象；默认返回最近 50 条，按本地记录顺序排列。带 `--after` 时返回其后的下一页；`data.cursor` 用于续读，`data.hasMore` 表示还有匹配记录。`--limit` 最大 10000；`--since` / `--until` 使用含时区的 ISO 时间。

数据默认写入 `~/.local/share/qqbot-cli`：

- `events/YYYY-MM-DD.jsonl`：UTC 分日的追加事件日志，含 `version`、递增 `seq`、`kind`、`recordedAt`，以及消息或更新内容。
- `attachments/`：按本地附件 ID 命名的下载文件；原文件名保留在消息元数据。
- `daemon.sock`：本地 IPC socket。

消息包含本地 ID、消息游标、QQ 消息 ID、方向、对方 OpenID、文本、时间、附件，以及发送结果。入站归档先记录 `pending` 附件，再异步更新到 `ready`（含绝对 `localPath`）或 `failed`（含 `error`）。下载完成不会触发 `wait`；需要时再次查询历史。

默认下载并发为 2，单文件上限 100 MiB、超时 120 秒，可通过配置 `attachments` 调整。中断时仍处于 `pending` 的下载会在重启后恢复；已失败的下载不自动重试。远程链接可能过期。

日志与附件默认持续保留。`history` / `peers` 在 daemon 停止时仍可只读查询。启动恢复只截掉最后一个日志文件末尾没有换行的未完成记录；中间损坏会报错，不静默跳过。不要在 daemon 运行时编辑或删除数据文件。

首版会扫描日志并将消息视图保存在内存，适用于个人通知量；没有数据库索引、自动清理或服务端历史同步。连接中断由 SDK 重连；进程重启不恢复 Gateway Session，停机期间不保证补消息。

## JSON 与错误处理

除帮助文本外，stdout 输出单个 JSON envelope，诊断日志写 stderr：

```json
{
  "ok": false,
  "error": {
    "code": "SEND_UNKNOWN",
    "message": "...",
    "details": { "messageId": "...", "cursor": 12, "status": "unknown" }
  },
  "exitCode": 1
}
```

| 退出码 | 含义                                                     |
| ------ | -------------------------------------------------------- |
| 0      | 命令成功；status 在服务停止时也成功返回 `running: false` |
| 1      | 运行失败、QQ 拒绝、未连接、发送结果不确定等              |
| 2      | 用法或参数错误                                           |
| 3      | 等待超时；`error.details.cursor` 可用于续等              |

发送成功状态是 `accepted`；平台明确拒绝或发送前上传失败为 `failed`；丢失响应、服务端不确定错误，或重启发现未完成发送为 `unknown`。后两者不会触发自动重发。CLI 被中断、IPC 断开或收到 `SEND_UNKNOWN` 后，先查询出站历史，勿直接重复发送。磁盘写入失败会停止 daemon，错误交给 systemd 处理。

常见错误码包括 `DAEMON_OFFLINE`、`QQ_OFFLINE`、`QQ_AUTH`、`QQ_REJECTED`、`REPLY_UNAVAILABLE`、`SEND_UNKNOWN`、`WAIT_TIMEOUT`、`CURSOR_INVALID`、`ALREADY_RUNNING` 和 `LOG_CORRUPT`。QQ 拒绝时尽可能保留 HTTP 状态和 QQ 错误码。

## systemd

复制 `examples/qqbot.service` 到 `~/.config/systemd/user/qqbot.service`，把 `ExecStart` 的 Node 和编译后 CLI 路径替换为机器上的绝对路径。凭证使用前述配置文件；systemd 不会继承交互 shell 的环境变量，需要时通过本机 unit override 设置环境文件。

```sh
systemctl --user daemon-reload
systemctl --user enable --now qqbot.service
systemctl --user status qqbot.service
journalctl --user -u qqbot.service -f
```

退出与重启使用 `systemctl --user stop/restart qqbot.service`。SIGTERM 会停止接收和等待，等待在途发送与日志完成。大文件分片上传可能持续较久，示例允许最多 30 分钟退出等待；强制终止后的未完成发送会记为 `unknown`，不会重放。需要退出登录后继续运行时，可按本机管理策略启用 user lingering。

同一数据目录只能启动一个 daemon；内核锁在进程退出时自动释放，重新启动会清理陈旧 socket。更换数据目录相当于使用另一套历史和游标。

## Agent Skill

可分发的通用 Skill 位于 `skills/qqbot-cli/SKILL.md`。将整个 `qqbot-cli` Skill 文件夹放入客户端支持的技能目录（例如 `~/.agents/skills/qqbot-cli`），并确保 `qqbot` 命令在该 Agent 的 PATH 中。无需 harness 插件或 MCP 服务。

## 开发与验证

```sh
pnpm check
pnpm typecheck
pnpm build
pnpm test
```

测试使用 Node 内置测试工具、可替换的 QQ 适配层和本地 HTTP 服务，覆盖实际 CLI 子进程与 Unix socket，不使用真实 QQ 凭证。NixOS 上若 npm Biome 二进制无法直接运行，可用 `BIOME_BINARY` 指向 Nix 提供的兼容版本，或在支持该二进制的开发环境运行。

真实账号的人工验收：启动服务 → QQ 私聊入库 → 查看历史 → 回复文本和文件 → 用发送前游标等待回复 → 重启后读取旧记录。主动发送被平台拒绝时应得到明确错误。
