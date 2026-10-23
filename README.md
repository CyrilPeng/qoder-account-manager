# Qoder 多账号管理（qoder-account-manager）

Qoder CN IDE 的本地多账号管理工具：**图形控制台**、**快照式账号切换（对话历史完整保留）**、
**全部已保存账号每日签到（无需切换）**、账号状态与 **credits 到期**查看、环境自检。

数据全部留在本机，不上传任何东西；代码零第三方依赖，只用 Node 内置模块（含 `node:sqlite`）
与系统自带的 PowerShell，拷走即用。

> ⚠️ 非官方插件，仅供个人学习研究。多账号操作可能违反 Qoder 服务条款，风险自担；
> 请仅管理本人合法持有的账号。

版本变更见 [CHANGELOG.md](CHANGELOG.md)。

## 能做什么

聊天框输入 `/` 选择 skill（本构建的斜杠菜单只列 skills，不列 `commands/`）：

| Skill | 说明 |
| --- | --- |
| `account-console` | **打开本地图形控制台**（浏览器 UI）：切换/保存/签到/重命名/回退/删除/档位开关 |
| `account-switch` | 切换登录账号：备份当前登录态 → 恢复目标快照 → 重启 Qoder |
| `daily-signin` | 为所有已保存账号领取每日签到 + 登录奖励（凭证自动续期） |
| `account-status` | 查看槽位、当前登录、凭证有效期、credits 额度与到期、签到状态 |

命令行有等价入口（不装插件也能用全套）：
`accounts.mjs list|status|doctor|sessions|credits|save|rollback|remove|rename`、
`switch.mjs`、`signin.mjs`、`console.mjs`。完整参数见[命令参考](docs/commands.md)。

图形界面走「本地 HTTP 服务 + 浏览器页面」形态（插件无法在 IDE 内加按钮或菜单）。

## 环境要求

| 项 | 要求 |
| --- | --- |
| 操作系统 | Windows 10/11（DPAPI + `taskkill`，不支持 macOS/Linux） |
| Qoder CN IDE | 已安装并至少登录过一次；适配 0.4.3 electron-root，兼容旧 icube 布局 |
| Node.js | ≥ 22.13（或 ≥ 23.4），需要内置 `node:sqlite` |
| PowerShell | 系统自带（DPAPI 解密助手用） |

确认环境：`node -e "require('node:sqlite'); console.log('OK', process.version)"`

## 安装

从 [Releases](https://github.com/CyrilPeng/qoder-account-manager/releases) 下载
`qoder-account-manager-v<版本>.zip`，解压后在插件管理里选“从本地安装”，指向解压出的
`qoder-account-manager/` 目录；重启 Qoder，斜杠菜单出现上面 4 个 skill。

- 发布包按版本号命名，不含 git 历史，也不含任何账号数据。
- IDE 注册表里的 `version` 只有重装时才会刷新，改代码不会动它。
- 手工放置、纯 CLI 便携使用、换数据目录、卸载与清理：见[安装与卸载](docs/install.md)。

装完在当前生效的副本里自检：

```bash
node --no-warnings scripts/accounts.mjs doctor
```

## 快速上手

1. `/account-console` 打开控制台（或 `node --no-warnings scripts/console.mjs`）。
2. 在 Qoder 登录账号 A，点「保存当前账号为新槽位」。
3. 退出登录、登录账号 B，同样保存。
4. 之后在控制台切换账号、一键全员签到、查看 credits 到期。切换会重启 Qoder，对话保留。

## 命令速查

```bash
node --no-warnings scripts/accounts.mjs list          # 槽位 + 当前登录
node --no-warnings scripts/accounts.mjs credits       # 各账号额度与到期（5 分钟缓存）
node --no-warnings scripts/accounts.mjs save acct1 --name "主账号"
node --no-warnings scripts/switch.mjs switch acct2    # 会关闭并重启 Qoder
node --no-warnings scripts/signin.mjs signin          # 全员签到，无需切换
node --no-warnings scripts/console.mjs                # 启动控制台，打印带 token 的地址
```

## 控制台

页面是 `assets/console.html` 单文件，零外部依赖、离线可用：

- 槽位卡片支持切换、单独签到、重命名、覆盖、删除与**回退到上一代**。
- 每张卡片内嵌 **credits 到期分批条**：一格 = 一个到期批次，颜色按紧迫度。默认只留总量条，
  悬停或 Tab 聚焦看来源池、积分、精确到期时间；批次表与额度池表收在「明细」里默认折叠。
  最近到期、今日未领、到期未定、已过期未扣完等提醒以小标签常驻。
- 服务不常驻：Qoder 连续 3 分钟不在运行会自行退出（`exitAfterNoQoderSec` 可调，0 = 常驻）。
- 地址里的 token 加载后会移出地址栏（换发同站 HttpOnly cookie），刷新仍可用；服务重启后需用新地址。

细节见[控制台](docs/console.md)。

## 安全与隐私

- **快照与 `creds/`、`server.json` 等同登录态**：别把 `~/.qoder-account-manager/` 放进网盘、
  同步盘或第三方备份。目录按 0700、文件按 0600 创建（Windows 实际以用户 ACL 为准）。
- **token 不输出**：不进终端、日志、HTTP 响应；本地服务只监听 `127.0.0.1`，校验 Host 头，
  页面加载后 token 移出 URL。
- **只交换白名单文件**：`main.sqlite` 等 29 条禁交换项任何档位都不动；槽位 id 强制
  `[A-Za-z0-9_-]{1,64}`，防路径穿越。
- **破坏性操作显式确认**：`remove`/`rollback` 必须 `--yes`，切换必须勾选；agent 不会代你点。
- **出网只有签到、续期与额度查询**（`openapi.qoder.com.cn`），其余操作离线可用。

完整安全模型、数据目录结构与信任边界见[安全、数据目录与边界](docs/security.md)。

## 已知边界（摘要）

- **仅 Windows**；令牌刷新 + 回写快照尚未实测；`browser` 档默认关闭是刻意为之。
- “切号后继续之前的对话”只端到端验证过一次（v2 + 默认档位）；默认档位下各账号共用同一份
  对话列表。
- 企业版额度由组织后台管理，本地拿不到数字，如实显示而不是 0。
- 客户端升级可能更换数据目录或加密方式；先跑 `doctor` 核对。

更多见[已知边界](docs/security.md#已知边界)。

## 文档

- [安装、升级与卸载](docs/install.md)
- [命令参考](docs/commands.md)
- [控制台](docs/console.md)
- [安全、数据目录与边界](docs/security.md)
- [原理与取证](docs/design.md)
- [故障排查](docs/troubleshooting.md)
- [开发与发版](docs/dev.md)
- [更新日志](CHANGELOG.md)

## 许可

MIT，见 [LICENSE](LICENSE)。作者对因使用本工具导致的账号风控、数据丢失或服务条款纠纷
不承担任何责任；请勿用它访问你不拥有的账号。
