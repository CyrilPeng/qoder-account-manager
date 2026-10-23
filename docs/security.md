# 安全、数据目录与边界

## 安全模型

这是本工具唯一的“安全模型”，逐条说清楚，方便你自己判断能不能接受：

- **磁盘上的快照等同于登录态**。`snapshots/<id>/auth.v1.dat`、`creds/<id>.json`、
  `server.json` 里的 token 一旦被别人拿到，对方就能以你的身份使用 Qoder。它们只在当前
  Windows 用户的 ACL 下；代码会尽量按 **目录 0700 / 文件 0600** 创建（Windows 没有 POSIX
  mode 语义，实际以目录 ACL 为准）。**别把 `~/.qoder-account-manager/` 放进网盘/同步目录/
  备份到第三方，也别截图其中的文件。**
  输出侧的脱敏只针对**从凭证里解出来的字段**：uid 掩码、邮箱与手机掩码。
  **昵称按客户端原文显示**，不额外脱敏——Qoder 自己的界面也一直是原文显示昵称，本工具不做得
  比它更保守。用邮箱注册的账号，客户端会把邮箱写进 `user.name`，因此页面、CLI 乃至
  `switch.log` 里出现完整邮箱属于预期行为（那是账号自己的显示名，不是解出来的额外信息）。
  `--name` 存的备注名只影响列表可读性，不会替换客户端给的 `name`。
- **token 全程不输出**：不打印到终端、不写进 `switch.log` / `signin-log.json`、不在任何
  HTTP 响应体里。CLI 的 `--json` 也只含掩码。若你哪天在任何输出里看到明文 token，那是 bug，
  请当安全事故报上来。
- **本地服务面**：只监听 `127.0.0.1`；启动时生成一次性 token，所有 `/api` 请求必须携带
  （`?t=` 或 `x-qam-token` 头），并用时间安全比较；校验 `Host` 头挡 DNS rebinding。
  原因是任意网页都能向 localhost 发请求（CSRF），而这个服务能重启 IDE。
  - 页面加载后 token 会移出地址栏（存 `sessionStorage`），并由服务端换发一个
    **HttpOnly、SameSite=Strict** 的会话 cookie，刷新时凭它过鉴权；cookie 与 token 都绑定
    当前进程，服务重启即失效；
  - 所有响应带 `Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、
    `X-Frame-Options: DENY`；
  - 请求体非合法 UTF-8 直接 400 拒绝（Windows 下经 Git Bash 调 curl 传中文会被转成 GBK，
    静默解码会把备注名存成 U+FFFD 乱码）。
- **路径注入防护**：槽位 id 会拼进 `snapshots/<id>` 做递归删除与文件覆盖，所以
  `save`/`switch`/`rollback`/`remove` 与所有 `/api/*` 入口都强制 `[A-Za-z0-9_-]{1,64}`，
  `../../x`、`a/b`、绝对路径、超长一律拒绝。
- **并发互斥**：同一时刻只允许一个切换。`switch.mjs` 启动即写 `switch.lock`（含 pid），
  退出时清除；`readSwitchLock` 用“pid 是否存活 + 是否超过 15 分钟”两道判据识别陈旧锁
  （进程被 Job Object 连带回收时不会执行清理代码）。锁有效期间
  `/api/save|signin|remove|rollback|config` 一律 409。CLI 侧可用 `--force` 顶掉，日志会
  如实写明顶了谁。
- **破坏性动作都要显式确认**：CLI 侧 `remove`/`rollback` 必须带 `--yes`，页面侧切换必须
  勾选二次确认；agent / 脚本不会代你点切换按钮（该操作会重启你正在用的 IDE）。
- **不越界读写**：只碰快照白名单里的文件，`main.sqlite` 等 29 条禁交换项在任何档位下都不
  交换；`sessions` 只读计数与元信息，不读对话正文。
- **网络行为**：签到、令牌续期与**额度查询**会出网，目标都是 `openapi.qoder.com.cn`；额度
  只走三个 GET（用量 / 套餐 / 活动列表），不携带也不写回令牌。除此之外零遥测、零上报，纯离线
  也能完成保存/切换。claim 之间带 1~3s 随机抖动，额度多账号之间带 300~700ms 间隔。
- **信任边界（诚实说明）**：本工具以「当前 Windows 用户的权限」读取该用户的 DPAPI 密文，
  这正是 Qoder 自己做的事。它不试图解决“这台机器已被其他进程控制”的威胁模型——任何能
  在你的用户会话里执行代码的进程，理论上都能做同样的解密。

## 支持的客户端布局

按目录内容自动识别，两种布局共存：

| 布局 | 数据目录 | 凭证真源 | 适用版本 |
| --- | --- | --- | --- |
| `v2` electron-root | `%APPDATA%\com.qodercn.app.stable` | `auth.v1.dat`（整文件即 v10 密文） | Qoder CN 0.4.3+ |
| `v1` icube / VSCode fork | `%APPDATA%\QoderCN` | `User\globalStorage\state.vscdb` 键 `secret://aicoding.auth.userInfo` | ≤0.4.2 |

**数据目录不写死**：优先解析运行中进程的 `--user-data-dir` 命令行参数，回退候选目录
探测，可用 `QODER_DATA_DIR` 环境变量或 `config.json` 覆盖。

> 客户端升级会换数据目录（0.4.2 及更早在 `%APPDATA%\QoderCN`，0.4.3 起在
> `com.qodercn.app.stable`）。旧布局保存的槽位会被标记「布局不兼容」，切换前预检拦下、
> 不会白关一次 IDE；在新客户端登录该账号后重新 `save` 即可恢复可用。

## 目录与数据

```text
qoder-account-manager/
  .qoder-plugin/plugin.json      # 插件清单
  CHANGELOG.md                   # 版本变更（按 vX.Y.Z 倒序）
  LICENSE                        # MIT
  README.md                      # 首页（安装、速查、边界摘要）
  docs/                          # 本文档目录
  tests/                         # node --test 单测
  assets/avatar.svg              # logo
  assets/console.html            # 控制台前端（单文件、零外部依赖、离线可用）
  skills/account-console/        # 控制台启动
  skills/account-switch/         # 账号切换
  skills/daily-signin/           # 每日签到
  skills/account-status/         # 状态查看与环境自检
  commands/                      # 斜杠命令定义（本构建实际入口是 skill）
  scripts/qoder_lib.mjs          # 共享库（布局探测/解密/快照/额度/API）
  scripts/status.mjs             # 状态汇总（CLI 与控制台共用同一数据出口）
  scripts/accounts.mjs           # 槽位管理 CLI（含 doctor）
  scripts/switch.mjs             # 切换 CLI
  scripts/signin.mjs             # 签到 CLI
  scripts/server.mjs             # 控制台 HTTP 服务
  scripts/console.mjs            # 控制台启动器（detached）
  scripts/release.mjs            # 发版检查与打包
  scripts/dpapi_unprotect.ps1    # DPAPI 解密助手（stdin/stdout base64）
```

插件本体在 IDE 的插件目录下（约 280K，全是可重下的代码；走 IDE 本地安装入口时具体位置是
`~/.qoder-cn/plugins/cache/local/qoder-account-manager/<version>/`，手工放置时是
`~/.qoder-cn/plugins/qoder-account-manager/`）；**运行数据另存在 `~/.qoder-account-manager/`**
（几个槽位约 40K，含登录态快照），两者刻意分开：

- **升级/重装/卸载插件都不能动账号**：插件目录归 IDE 的插件机制管，随时可能被覆盖或删除；
  登录态快照一旦被带走，所有槽位全部作废，只能重新逐个登录。
- **写权限与进程边界**：IDE 加载插件目录时可能持有文件句柄，把频繁读写的日志/锁/快照
  放进去容易撞车；运行时往自己目录写文件也会被插件更新流程覆盖。
- **一份副本可能被多个入口同时读写**（CLI、控制台服务、切换子进程），放在数据目录里路径
  唯一、行为可控。

运行数据：

```text
~/.qoder-account-manager/            # 目录 0700（POSIX）；Windows 靠用户 ACL
  accounts.json        # 账号注册表（id/备注/uid/脱敏身份/布局/exe 路径；不含任何令牌）
  config.json          # 数据目录/exe 覆盖、快照档位、launchArgs、exitAfterNoQoderSec
  server.json          # 控制台服务地址与 token（0600 创建；Windows 上权限继承目录 ACL）
  switch.log           # 最近一次切换的进度输出（每次启动切换都重写）
  switch.lock          # 切换互斥锁（pid/目标/时间戳），进程退出即清除，陈旧锁自动识别
  snapshots/<id>/      # 登录态快照（含凭证密文，等同登录态，勿外传）
  snapshots/<id>.bak   # 上一代快照（可 rollback 换回来）
  snapshots/<id>.meta.json      # 槽位元数据（布局/保存时间/未拷全条目/告警）
  snapshots/<id>.meta.json.bak  # 上一代的元数据（与 .bak 配对，回退时一起换）
  creds/<id>.json      # 令牌缓存（save 时同步、刷新后双写；明文，仅本机，等同登录态）
  signin-log.json      # 签到日志（滚动 200 条）
  credits.json         # 额度缓存（只含数字/日期/掩码 uid，无令牌无邮箱；5 分钟 TTL）
```

想整体挪到别处（换盘、不想在 home 下留目录）：设 `QODER_AM_HOME`，见
[install.md](install.md#数据目录搬家)。

## 已知边界

- 客户端只存单账号，**无原生多账号切换**，本插件靠快照交换实现。
- **「切号后继续之前的对话」已端到端验证过一次**（详见 [design.md](design.md#对话保留已端到端实测)）：
  落地身份由脚本回读核对，会话数据一条没少，IDE 的会话列表里切换前创建的对话仍在。
  这只覆盖 v2 布局 + 默认档位这一条路径的一次切换；v1 旧布局、开 `browser` 档、以及
  多工作区跨账号可见性都还没实测过。若哪天出现“看不到旧对话”，先用
  `accounts.mjs sessions` 对比计数：计数不变就是视图层的事，别盲目改档位或手工动文件。
- **默认档位下运行中保存是完全可靠的**（只碰 4 个小身份文件，0 告警）。若手动打开
  `browser` 档，`Network/Cookies` 会被 Chromium 独占（连共享读都拒绝，字节级
  read/write 回退也失败）而跳过并告警；身份靠 `auth.v1.dat`，缺 cookie 不影响切号后
  登录，且恢复时对不完整目录降级为合并，不会删掉实时 cookie。要完整快照请关闭
  Qoder 后 `save <id> --kill`。
- 默认档位下各账号**共用同一份对话列表**（`main.sqlite` 不交换）——这正是“切号续聊”
  的实现方式，也意味着账号 B 能看到账号 A 的对话。需要隔离时打开 `browser` 档。
- 非当前登录账号的签到凭证来自其槽位快照与令牌缓存，**取更新的那一份**（缓存可能装着已被
  服务端轮换作废的旧 refreshToken）；若该账号在别处登录导致刷新令牌轮换失效，会提示
  `permanent_auth`，需切回该账号重新 `save`。
- **如果你平时用自定义 `--user-data-dir` 启动 Qoder**：请把那个目录同时写进
  `config.json` 的 `dataDir`，并把启动参数放进 `config.launchArgs`（数组），否则切换写的是
  探测到的目录、重启后客户端又读回它自己的默认目录，看起来就像“切换没生效”。
  `accounts.mjs doctor` 会打印当前生效的数据目录，先核对再排障。
- 活跃账号 token 过期时返回 `live_expired` 而不代为刷新（见轮换安全策略）。
- **令牌刷新 + 回写快照这条路径尚未实测**：验证它需要轮换掉当前账号的刷新令牌，
  风险不对等，故刻意未触发。代码含写回前解密自校验与失败回滚。
- **服务生命周期只验过两条路径**：IDE 被强杀后服务仍在（`taskkill` 路径），以及手动
  `--stop` 时服务经 `POST /api/shutdown` 自行退出。IDE 正常退出、崩溃、关机时服务会被怎样，
  没有完整结论，所以文档里不承诺任何一侧。
- `auth.machine-id` 随快照交换（每账号绑定各自设备标识）；未实现浏览器指纹隔离，
  两账号在同一台机器上共享硬件层指纹，风控风险自控。
- 若客户端未来启用 app-bound encryption，外部进程将无法解密，`getAesKey` 会明确报错
  而非静默失败。
- **仅 Windows**：DPAPI / `tasklist` / `taskkill` / 进程探测都是 Win32 的。macOS/Linux
  需要重写解密后端（keychain / libsecret）才能工作，当前没有实现。
