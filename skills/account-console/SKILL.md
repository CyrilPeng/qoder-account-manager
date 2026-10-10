---
name: account-console
version: 2.1.0
description: Launch the local Qoder account console (browser UI) for switching accounts, saving slots, daily sign-in, and per-account credits with expiry dates.
description_zh: 启动 Qoder 多账号本地控制台（浏览器图形界面），用于切换账号、保存槽位、每日签到、查看每个账号的 credits 额度分段与到期日。
user-invocable: true
argument-hint: "[--stop|--restart|--no-browser]"
---

# Qoder 账号控制台

多账号管理的**图形界面入口**。插件清单不支持 IDE 内原生按钮/面板（无 views/menus
贡献点），所以 UI 走「本地 HTTP 服务 + 浏览器页面」形态。

> **本 skill 就是唯一的图形入口**：用户想打开控制台，让他在聊天框敲 `/account-console`。
> 实测 Qoder CN 0.4.3 的斜杠菜单**只暴露插件 skills，不暴露 `commands/` 里的命令**，
> 所以不要向用户提 `/account-ui`、`/switch-account`、`/accounts`、`/signin` 这些命令名
> ——它们在这个菜单里根本不存在，用户找不到会以为功能缺失。要用命令时统一说 skill 名，
> 或直接给 `node --no-warnings scripts/console.mjs` 这类可复制的命令行。

脚本目录 = 本 SKILL.md 所在插件根目录下的 `scripts/`。

## 流程

1. 启动（或复用）服务并打开浏览器：

   ```bash
   node --no-warnings scripts/console.mjs
   ```

   输出 `CONSOLE_URL:http://127.0.0.1:<port>/?t=<token>`。把**完整地址**给用户
   （不带 token 打不开，服务会返回 403 提示页）。

2. 参数：

   | 参数 | 作用 |
   | --- | --- |
   | （无） | 启动或复用服务，并打开浏览器 |
   | `--no-browser` | 只启动服务，打印地址 |
   | `--restart` | 重启服务（改完服务端代码后用） |
   | `--stop` | 停止服务 |

3. 控制台能力：当前登录身份核对、槽位卡片（切换/单独签到/重命名/覆盖/删除/
   **回退到上一代**）、**每张卡片内嵌的 credits 到期分批条**（一格 = 一个到期批次，颜色按紧迫度，
   悬停给来源池/积分/精确到期时间/还剩几天；顶部一行给全部账号合计与最近到期，「刷新额度」按钮强制重取）、
   保存当前账号为新槽位、
   一键全员签到、签到日志、快照档位开关、环境自检、会话可见性前后对比（基线存 sessionStorage，页面重载不丢）。

## 服务生命周期（IDE 退出 3 分钟后自行结束；两侧都不当契约用）

服务启动即启用自动退出看门狗：连续 `config.exitAfterNoQoderSec`（默认 **180s**）探测不到
`Qoder CN.exe`，就打印原因、删掉 `server.json`、`process.exit(0)`。理由是切换账号通常半分钟
内就把 IDE 重新拉起，超过 3 分钟没起来基本就是用户真退出了，此时留一个能重启 IDE 的 HTTP
服务在后台只是白占约 50MB 内存。

- **切换进行中豁免**：`switch.lock` 有效、或本进程起的切换子进程还活着时，计时清零，绝不半路跑路。
- 探测失败（tasklist 异常）按"IDE 还在"处理——宁可少杀不可误杀。
- 阈值可在控制台「快照策略」里改（`/api/config` 的 `exitAfterNoQoderSec`，0 = 常驻，
  范围 0~86400），或直接改 `config.json`；改完立即重新计时并换轮询间隔。
- 页面上有本地每秒递减的倒计时横幅，归零后横幅会明说"服务已退出，重开 Qoder 再跑
  `/account-console`"——别让用户以为页面坏了。

至于"IDE 重启会不会把服务一起带走"：控制台进程确实在 Qoder 的 Job Object 内
（`IsProcessInJob=True`），但 2026-10-09 08:06 一次真实切换（`taskkill /IM "Qoder CN.exe"`
杀掉 13 个 IDE 进程再重启）之后，同一个服务进程仍在监听、`/api/ping` 正常、**一次性 token
也没变**（token 绑进程；用户说"还能用之前的 token 打开 webui"就是这个原因。现在会导致换
token 的动作是：`--restart`/`--stop`、看门狗退出、重启机器）。

所以口径是：**不承诺服务还在，也不承诺服务一定死**。真正要保证的是数据不依赖服务——槽位
全部落在 `~/.qoder-account-manager/`，与插件目录、客户端数据目录解耦，服务没了就重新
`/account-console`，槽位原样可用。

`console.mjs` 用 `spawn(..., {detached:true})` + `unref()`，目的是让启动器（一次性
CLI 进程）退出后服务继续为当前这次会话提供页面与进度。`/api/switch` 以 detached 子进程
跑 `switch.mjs`，输出写入 `switch.log`。

即便切换进程真的被 job 半路回收也不会损坏数据：`taskkill` 已**去掉 `/T`**（`/T` 会连
子进程树一起杀，`node.exe` 正是 Qoder 后代，等于自杀），且恢复流程把 `auth.v1.dat`
放在**第一步**用同卷 `rename` 原子落地。各槽位 `Local State` 字节完全相同，换账号
实质等价于换这一个文件，所以任何中断点都只会得到"已切换"或"尚未切换"，无半交换态。

## 切换互斥（一次只允许一个切换）

`switch.mjs` 启动即写 `~/.qoder-account-manager/switch.lock`（pid/目标/时间戳），退出时
清除；`readSwitchLock` 再用「pid 是否存活 + 是否超过 15 分钟」识别陈旧锁（进程被 job
连带回收时不会执行清理代码，必须有这道判据，否则锁会永久卡住控制台）。

- 锁有效期间：`/api/save|signin|remove|rollback|config` 一律返回 **409**，`/api/status`
  里带 `switching` 字段，前端据此把所有写按钮置灰——所以用户报"按钮全灰了点不动"时，
  先看是不是真有切换在跑，而不是让他重试。
- `console.mjs --stop` / `--restart` 在切换进行中**直接拒绝**（`taskkill /T` 会把正在
  交换文件的切换子进程一起杀掉）。
- CLI 侧被锁挡住时可以加 `--force` 顶掉，日志会如实写出顶了谁。
- 前端轮询 `/api/switch-log` 有三重收尾：出现「切换完成」→ 成功；出现 `错误:`/「已中止」
  → 失败；约 3 分钟无结果或连不上服务 → 提示"服务可能随 Qoder 被回收，重开 Qoder 再跑
  `/account-console`"。不会永久空转。

## 安全约束

- 只监听 `127.0.0.1`；启动时生成一次性 token，所有 `/api` 请求必须携带
  （`?t=` 或 `x-qam-token` 头），并校验 Host 头挡 DNS rebinding。
  原因：任意网页都能向 localhost 发请求（CSRF），而本服务能重启 IDE。
- **槽位 id 必须校验**：id 会拼进 `snapshots/<id>` 参与递归删除与文件覆盖。入口一律要求
  `[A-Za-z0-9_-]{1,64}`（`isValidSlotId` + `assertSlotId`，`snapSlotDir`/`credsFile` 内部
  也会拒绝），`../../x`、`a/b` 一律 400 或明确报错。
- 请求体非合法 UTF-8 时直接 400 拒绝，不静默写入。Windows 下经 Git Bash 调 curl
  传中文会被转成 GBK，静默解码会把备注名存成 U+FFFD 乱码（实测踩坑）。
- 接口只返回脱敏字段（uid 掩码、邮箱/手机掩码），**绝不返回 token 明文**。
- **不要代替用户点击「切换到此账号」**：该操作会重启 IDE，若 agent 正运行其中会
  中断自己的会话。让用户在控制台自行确认——页面是勾选式二次确认，未勾选时主按钮**锁定**
  （文案带「（先勾选）」），勾上才亮起；删除/覆盖槽位走同一套组件。

## 排障

- 打不开页面：确认地址带 `?t=<token>`；`--restart` 重启服务。
- 端口被占：服务会自动 +1 递增探测（最多 10 次），以输出的 CONSOLE_URL 为准。
- 状态显示的不是正在用的账号：先跑 `node --no-warnings scripts/accounts.mjs doctor`，
  核对「生效数据目录」与「识别布局」。
- 写按钮全灰 / 接口返回 409：`switch.lock` 在生效。真有切换在跑就等它结束；确认上一个
  切换进程已死（锁里那个 pid 不在了）会被自动判陈旧并清掉；若时间戳仍在 15 分钟内而
  pid 又活着，可手工删除 `~/.qoder-account-manager/switch.lock`。
- 覆盖保存点错、想找回旧快照：槽位卡片的「回退到上一代」（`accounts.mjs rollback <id> --yes`），
  互换对称，再执行一次即换回。
- 页面过一会儿就点不动了：多半是看门狗在 IDE 退出 3 分钟后把服务收了（顶部横幅会说原因）。
  重新打开 Qoder 再跑 `/account-console` 即可；想让服务常驻就把 `config.json` 的
  `exitAfterNoQoderSec` 设成 0（或在控制台「快照策略」里改，或 `POST /api/config`）。
- **停服务只用 `--stop`，绝不要用 `taskkill /IM node.exe` 一刀切**：机器上叫 node.exe 的
  进程未必属于本插件（其他工具、正在跑的切换子进程都在里面），全杀等于顺手制造一次
  「切换进行到一半被打断」。要精确处理就读 `~/.qoder-account-manager/server.json` 里的 pid。
