# DeepSeek Harness（DSH）后端

DSH 通过自带的 **ACP（Agent Client Protocol）v1 stdio server** 接入：

```bash
dsh --profile acp
```

bridge 为每个话题启动一个 `dsh --profile acp` 进程、一个 ACP session，复用飞书的项目/话题/卡片/文件交付/⏹ 终止能力。

---

## 1. 安装与探测

按优先级查找 `dsh`：

1. `DSH_BIN` 环境变量（指向可执行文件）
2. macOS 桌面版自带：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`
3. bridge 私装目录：`~/.feishu-codex-bridge/backends/node_modules/.bin/dsh`
4. `PATH` 里的 `dsh`

其他平台 / 没有桌面版时：

```bash
npm i -g @deepseek-ai/dsh
# 或让 bridge 管理（下载较大，约 800MB+）：
# 目前 catalog 把 DSH 标为 external-cli，不提供 Web 一键下载。
```

验证：

```bash
dsh --version                 # 期望 0.2.x
dsh --profile acp --help      # 应打印 ACP 说明并退出 0
```

`doctor` 会检查 CLI 是否存在、`--version` 是否可执行，并提示登录状态：
- 有 `~/.dsh/.credentials.yaml`（桌面版登录）→ 复用该登录；
- 没有 → 提示在 DSH 桌面版登录，或设置 `DEEPSEEK_API_KEY`。

---

## 2. 新建项目

飞书私聊机器人 → 新建项目 → 选 **DeepSeek Harness** → 绑定目录。

权限档只提供：

| 档位 | DSH 模式 | 说明 |
|---|---|---|
| ✏️ 项目内读写 | `DSH_PERMISSION_MODE=workspace-write` | 写限制在项目目录；读/网络仍开放 |
| ⚠️ 完全访问 | `DSH_PERMISSION_MODE=danger-full-access` | 整机读写；仅完全信任的场景 |

**不提供「项目内只读」**：DSH 的 `read-only` 只限制写入，实测仍可读工作区外文件（如 `~/.dsh/.credentials.yaml`）并可联网，无法满足外部群隔离。选择 qa 会在启动前被硬拒绝，不会静默降级。

---

## 3. 模型

`session/new` 返回的配置项里通常有两组：

- `deepseek-account`：复用桌面版 DeepSeek 账号登录（推荐，默认选 `deepseek-account/deepseek-flash`）；
- `deepseek-official`：需要 `DEEPSEEK_API_KEY`（ACP profile 的出厂默认）。

适配器在未显式指定模型时会优先选 `deepseek-account/*`；桥的 `/model` 列表显示为 `provider/model`，切模型走 ACP `session/set_config_option`。`reasoning_effort` 只暴露 DSH 支持的 `none/low/high/max`（内部映射 off/low/high/max）。

---

## 4. 能力边界

| 能力 | 支持 | 说明 |
|---|---|---|
| 流式文本 / 思考 / 工具 / 用量 | ✅ | `session/update` → 卡片 |
| 续聊 / 重启恢复 | ✅ | `session/resume` 保留上下文 |
| ⏹ 终止 | ✅ | `session/cancel` |
| 文件交付 / 图片引用 | ✅ | 复用桥的本地文件交付；**图片输入不支持**（ACP `image:false`，降级为文字路径） |
| `/model` | ✅ | 模型/effort 选择 |
| `/goal` | ❌ | ACP 无目标接口；能力位 false，命令隐藏 |
| 运行中引导（steer） | ❌ | ACP 一次只允许一个 prompt；自动排队到下一轮 |
| `/compact` | ❌ | ACP 无压缩方法；DSH 自动压缩 |
| `/resume` 历史选择 | ❌ | ACP 只给 sessionId/cwd，无标题/转写；重启自动 resume 仍可用 |
| 审批卡 | ❌ | 越权升级默认 **拒绝**；审批卡是后续切片 |
| `/usage` 账号额度 | ❌ | 仅 Codex 有该数据；DSH 只有上下文用量 |
| 自动压缩设置 | — | 项目里的「自动压缩」开关对 DSH 不生效；DSH 内部自行压缩 |
| 长任务 watchdog | ⚠️ | ACP 只在工具开始/结束时发事件；单条命令超过 idle timeout（默认 120s）且无中间通知时，桥可能判卡死。调大 `runIdleTimeoutSeconds`，或把长任务拆成多步/后台作业 |
| 进程内存 | ⚠️ | 每个话题一个 `dsh` 进程，实测约 240MB RSS；多话题并发时留意内存 |

---

## 5. 安全

1. **权限升级默认拒绝**：DSH 在越权时会发 `session/request_permission`。ACP 客户端自动 `allow` 会真的绕过沙箱（实测 read-only + allow-once 可写工作区外）。适配器只发 `reject-once`；不要改成 auto-approve。
2. **读/网络不隔离**：`workspace-write` 只约束写；读整机文件与联网仍可能。不要把 DSH 接到不可信外部群；需要强隔离时用容器/VM。
3. **完全访问 = 整机**：任何能给机器人发消息的人都能以你的身份执行命令；只拉信任的人进群。
4. **凭据共享**：复用 `~/.dsh` 的登录；与桌面版同时运行通常安全，但避免高频重启造成的刷新竞争。

---

## 6. 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_BIN` | 覆盖 dsh 可执行文件路径 |
| `DSH_HOME` | DSH 配置/会话根（默认 `~/.dsh`） |
| `DSH_PERMISSION_MODE` | 由适配器按项目档位设置；不要手工覆盖 |
| `DEEPSEEK_API_KEY` | 使用 `deepseek-official` 路由时的 API key |

---

## 7. 排障

```bash
# CLI 是否存在
dsh --version
dsh --profile acp --help

# 桥日志（文件）
grep -E "dsh-connected|dsh-stderr|dsh-exit|dsh-config|dsh-permission" ~/.feishu-codex-bridge/logs/*.log

# 单测（不依赖真实 DSH）
npx vitest run test/dsh-acp-*.test.ts

# 真机 smoke（需要本机 DSH 登录）
DSH_LIVE=1 npx vitest run test/dsh-acp.live.test.ts
```

常见问题：
- **`no API key for provider route "deepseek-official"`**：适配器没切到 `deepseek-account`，或该机器没有 DSH 登录。检查 `/model` 是否选中 `deepseek-account/*`，或在启动环境设置 `DEEPSEEK_API_KEY`。
- **`dsh --version 执行失败`**：`DSH_BIN` 指向了错误的 shell 包装；用 `dsh --profile acp --help` 直接验证。
- **进程卡住不退出**：适配器用 `session/close` + `stdin.end()`；不要只发 `SIGTERM`（会挂很久）。
