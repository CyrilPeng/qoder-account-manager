# Qoder 多账号管理（qoder-account-manager）

Qoder CN IDE 的本地多账号管理工具：**图形控制台**、**快照式账号切换（对话历史完整保留）**、
**全部已保存账号每日双活动签到（无需切换）**、账号状态查看与**环境自检**。

数据全部留在本机，不上传任何东西；代码零第三方依赖，只用 Node 内置模块（含 `node:sqlite`）
与系统自带的 PowerShell，拷走即用。

> ⚠️ 非官方插件，仅供个人学习研究。多账号操作可能违反 Qoder 服务条款，
> 风险自担；请仅管理本人合法持有的账号。

**第一部分 · 上手使用** — [功能](#功能) · [环境与安装](#环境与安装) · [快速上手](#快速上手) ·
[控制台](#控制台ui) · [命令参考](#命令参考) · [故障排查](#故障排查) ·
[卸载与数据清理](#卸载与数据清理)

**第二部分 · 数据与边界** — [安全与隐私](#安全与隐私) · [支持的客户端布局](#支持的客户端布局) ·
[目录与数据](#目录与数据) · [已知边界](#已知边界)

**第三部分 · 开发者参考** — [原理](#原理) · [开发与自测](#开发与自测) · [许可](#许可)

版本变更请看 [CHANGELOG.md](CHANGELOG.md)。

## 第一部分 · 上手使用

### 功能

> **入口**：聊天框输入 `/` 选择 skill，`/account-console` 唤出图形控制台（浏览器页面）。
> 本构建的斜杠菜单只列 skills，不列 `commands/`。

| Skill | 说明 |
| --- | --- |
| `account-console` | **打开本地图形控制台**（浏览器 UI）：切换/保存/签到/重命名/删除/档位开关 |
| `account-switch` | 切换登录账号：备份当前登录态 → 恢复目标快照 → 重启 Qoder |
| `daily-signin` | 为所有已保存账号领取每日签到 + 登录奖励（凭证自动续期） |
| `account-status` | 查看槽位、当前登录、凭证有效期、签到状态 |
| —（CLI）`accounts.mjs doctor` | **环境自检**：实际生效的数据目录、布局、exe、不兼容槽位 |
| —（CLI）`accounts.mjs sessions` | **会话可见性诊断**：本地会话/工作区计数，切换前后对比用（控制台内也有面板） |
| —（CLI）`accounts.mjs rollback <id> --yes` | 把槽位与它的上一代 `.bak` **互换**（覆盖保存后找回旧快照；再跑一次即换回） |

图形界面走「本地 HTTP 服务 + 浏览器页面」形态（插件无法在 IDE 内加按钮或菜单）。
**每个界面动作都有等价的命令行入口**，不装插件、不开 IDE 也能用全套功能。

### 环境与安装

#### 要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | **Windows 10/11** | 解密走 DPAPI，进程控制用 `tasklist`/`taskkill`；不支持 macOS/Linux。 |
| Qoder CN IDE | 已安装，且**至少成功登录过一次** | 实测适配 0.4.3（electron-root 布局）；旧版 icube 布局见[支持的客户端布局](#支持的客户端布局)。 |
| Node.js | **≥ 22.13**（或 ≥ 23.4） | 需要内置 `node:sqlite`，这两个版本起免 `--experimental-sqlite`。验证于 v22.23.2 / v24.19.0；`node:sqlite` 是顶层依赖，版本不够整套命令都起不来。 |
| PowerShell | 系统自带 | DPAPI 解密助手 `scripts/dpapi_unprotect.ps1`，经 stdin/stdout 传 base64，不落临时文件。 |

装之前先确认环境：

```bash
node -e "require('node:sqlite'); console.log('node:sqlite OK', process.version)"
```

#### 安装方式 A：作为 Qoder 插件（推荐，能用 `/account-console` 等斜杠入口）

装法二选一（别两条都走，会留下互相不知情的副本）：

**A-1 走 IDE 的本地安装入口（推荐）**：在插件管理里选"从本地安装"，指向本仓库目录。IDE 会把
内容复制进版本化缓存，并写一条注册表记录：

```text
~/.qoder-cn/plugins/cache/local/qoder-account-manager/0.2.0/
installed_plugins_v2.json → "qoder-account-manager@local": { scope, installPath, version, installedAt, … }
```

`version` 从 `.qoder-plugin/plugin.json` 读取，**只有重装时才会刷新**，改代码不会动它。
⚠ 从 git 工作目录安装会连 `.git` 一起复制（约 150KB）；介意就先导出一份干净副本再装：
`git archive --format=zip -o ../qam.zip HEAD`。

**A-2 手工放置**：把插件目录（含 `.qoder-plugin/`）复制进 IDE 的插件目录，落地目录名与清单
`name` 一致：

```bash
cp -r qoder-account-manager "$USERPROFILE/.qoder-cn/plugins/"
```

之后若改走 A-1 重装，注册表会改指缓存目录，手工那份立刻成为没人引用的孤儿副本——"改了代码
不生效"多半是这个原因，删掉孤儿即可。

装完重启 Qoder 让斜杠菜单重新扫描，应能看到 `account-console` / `account-switch` /
`account-status` / `daily-signin` 四项。接着确认当前生效的是哪一份，在那一份里自检：

```bash
cd "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.USERPROFILE+"/.qoder-cn/plugins/installed_plugins_v2.json","utf8")).plugins["qoder-account-manager@local"][0].installPath)')"
node --no-warnings scripts/accounts.mjs doctor
```

`doctor` 打印出生效数据目录、布局 v2 与 exe 路径就可以开始了。注册表由安装流程整体维护，
**不要手工编辑它**。

#### 安装方式 B：纯 CLI / 便携使用（不注册、不重启 IDE）

代码路径全部相对自身解析，运行数据固定在 `~/.qoder-account-manager`（可用 `QODER_AM_HOME`
改），所以放哪儿都能跑，也不必是 git 仓库：

```bash
cd /d/tools/qoder-account-manager     # Git Bash 写法；cmd/PowerShell 里是 D:\tools\qoder-account-manager
node --no-warnings scripts/console.mjs        # 直接开控制台（会打印带 token 的地址）
node --no-warnings scripts/accounts.mjs list
```

需要"插到别的机器就用"时，复制这几个文件即可，无需 npm install、无需构建：
`.qoder-plugin/plugin.json`、`assets/`、`commands/`、`scripts/`、`skills/`、`README.md`。

> **版本库里只有代码。** 运行数据（登录态快照、令牌缓存、注册表、日志）全在
> `~/.qoder-account-manager`，与仓库位置无关，所以 clone、打包、分享这个仓库**不会带走
> 任何账号凭证**；反过来，也不要把那个数据目录放进仓库或同步盘。

### 快速上手

1. `/account-console` 打开控制台（或 `node --no-warnings scripts/console.mjs`）。
2. 在 Qoder 登录账号 A，控制台点「保存当前账号为新槽位」（或
   `node --no-warnings scripts/accounts.mjs save acct1 --name "主账号"`）。
3. 在 Qoder 退出登录并登录账号 B，同样保存为 `acct2`。
4. 之后随时在控制台点「切换到此账号」（会重启 Qoder，对话保留；脚本会回读验证落地身份），
   「一键全员签到」给所有账号领每日奖励；查看状态用 `/account-status` skill，
   或跑 `node --no-warnings scripts/accounts.mjs doctor`。
5. **想确认对话真的续上了**：切换前点「记为切换前基线」，切换后再点「重新检测」——
   面板会直接给「与切换前一致 / ±N 条变化」的标记（基线存在 sessionStorage，页面重载不丢）。
   数字不变即数据层完好；若 IDE 里仍看不到会话，说明过滤发生在视图层，把该面板结果拿去
   精准定位（也可开 `browser` 档做对照实验）。
6. 覆盖保存点错了、想把槽位内容换回上一代：槽位卡片上的「回退到上一代」（或
   `accounts.mjs rollback <id> --yes`），互换是对称的，再执行一次就换回来。

### 控制台（UI）

启动方式与参数见[命令参考](#consolemjs--控制台启动器)。服务输出
`CONSOLE_URL:http://127.0.0.1:<port>/?t=<token>`，**地址必须带 token**（不带会返回 403 提示页）。
页面本身是 `assets/console.html` 单文件，零外部依赖、离线可用，能显示当前登录身份核对、
槽位卡片（切换/单独签到/重命名/回退/删除）、保存当前账号、一键全员签到、签到日志、
快照档位开关、环境自检、会话可见性对比。

- **服务不常驻：IDE 走了 3 分钟后它自己结束**。切换账号通常半分钟内就把 IDE 重新拉起，
  连续 3 分钟探测不到 `Qoder CN.exe` 基本就是用户真退出了，此时留一个能重启 IDE 的 HTTP
  服务在后台只是白占内存（实测约 50MB RSS），于是自行退出并删掉 `server.json`。
  阈值就是 `config.json` 的 `exitAfterNoQoderSec`（默认 180，**0 = 常驻**），控制台
  「快照策略」里可以直接改；倒计时会在页面顶部横幅显示（本地每秒走一格），归零后页面会
  明说"服务已退出，重开 Qoder 再跑 `/account-console`"，不会让人以为是坏了。
  **切换进行中豁免**：`switch.lock` 有效或切换子进程还活着时计时器清零，绝不半路跑路。
  探测失败（tasklist 报错）按"IDE 还在"处理——宁可少杀不可误杀。
- **别把服务当契约**：它是否随 Qoder 一起退出取决于 IDE 的 Job Object，不做承诺；真正可靠的
  是数据全在 `~/.qoder-account-manager/`，与服务无关。token 绑定进程，所以服务没换进程时
  老地址老 token 依旧能用；`--restart` 或重启机器才会变。
- **切换的进程存活问题已被设计消解**：`/api/switch` 以 detached 子进程跑 `switch.mjs`
  并把输出写入 `switch.log` 供前端轮询；同时 `taskkill` **不带 `/T`**（带 `/T` 会连子进程树
  一起杀，而 `node.exe` 正是 Qoder 的后代，会杀掉切换自己）。即便如此，切换进程仍
  可能因 job 回收而在 Qoder 退出时中断——所以恢复流程把 `auth.v1.dat` 放在**第一步**
  且用同卷 `rename` 原子落地。因为各槽位的 `Local State` 字节完全相同（同一把
  os_crypt 钥），换账号实质等价于换这一个文件，故任何中断点都只会得到"已切换成功"
  或"尚未切换"两种完整状态，**不存在半交换的损坏**。
- 切换按钮为**勾选式二次确认**，且当前账号/不兼容槽位/解不开的快照自动置灰。确认块做成
  一整块橙色描边高亮 + 24px 复选框（点文字也能勾），**未勾选时主按钮是锁定的**、文案带
  「（先勾选）」，勾上后整块转绿、按钮亮起、提示行变成「✓ 已确认」。
- **会话可见性面板**：基线存在 `sessionStorage`，切换后页面被重新加载也仍能对比；
  切换完成（或失败/超时）时前端会自动重测一次并给出「与切换前一致 / ±N 条变化」的标记；
  也可以手动点「记为切换前基线」。
- 切换进行中时页面所有写操作按钮置灰（服务端同时返回 409），`--stop` 也会拒绝执行——
  因为停服务用的是 `taskkill /T`，会把正在跑的切换子进程一起杀掉。

### 命令参考

`<插件根>` = 本 README 所在目录。所有命令都写成 `node --no-warnings <插件根>/scripts/xxx.mjs`
（`--no-warnings` 是为了压掉 `node:sqlite` 的实验特性警告，不是必需）。带 `--json` 的命令会在
stdout 末尾多输出一行 `QAM_JSON:{...}`，控制台服务就是靠它解析的，脚本化时按前缀取即可。

#### `accounts.mjs` — 槽位管理

| 命令 | 作用 |
| --- | --- |
| `list [--json]` | 槽位简表 + 当前登录 + Qoder 进程状态 |
| `status [--json]` | 详细状态：凭证缓存、签到记录、快照策略、锁、上一代备份 |
| `save <id> [--name <n>] [--kill] [--json]` | 把当前登录态存进槽位 `<id>`（已存在则覆盖，旧代留成 `.bak`）。`--kill` 先关闭 Qoder 以尽量拷全（默认档位不需要）。 |
| `rollback <id> --yes [--json]` | 槽位与上一代 `.bak` **互换**，可再执行一次换回 |
| `remove <id> --yes [--json]` | 删除槽位（连带 `.bak`、`meta.bak`、凭证缓存） |
| `rename <id> --name <n> [--json]` | 只改注册表里的备注名（不碰快照与凭证；80 字上限，`--name` 值不能以 `-` 开头） |
| `doctor [--json]` | 环境自检：生效数据目录、布局、exe 解析结果、布局不兼容的槽位 |
| `sessions [--json]` | 会话可见性诊断（只读计数与元信息，不读对话正文） |

切换动作在 `switch.mjs`（见下）；`rename` 与控制台的 `/api/rename` 等价。

槽位 id 规则：**字母/数字/`_`/`-`，1~64 字符**（id 会拼进快照目录名，非法 id 在入口直接拒绝，
`../x`、`a/b`、超长一律报错/400）。`--name` 的值不能以 `-` 开头（会被当成开关）。

#### `switch.mjs` — 账号切换

```bash
node --no-warnings scripts/switch.mjs switch <目标id> [--save-as <id>] [--no-save-current]
                                                  [--no-restart] [--no-kill] [--force] [--json]
```

流程：预检（目标槽位存在 + 布局兼容 + **能解密出登录态**）→ 探测当前登录 → 关闭 Qoder →
备份当前登录态到自己槽位 → 恢复目标快照 → **回读验证落地 uid** → 重启 Qoder。

| 参数 | 作用 |
| --- | --- |
| `--save-as <id>` | 当前登录态存到指定槽位（默认按注册表里的当前账号） |
| `--no-save-current` | 不备份当前登录态（**会丢当前账号的最新凭证**，谨慎） |
| `--no-restart` | 切完不自动拉起 Qoder |
| `--no-kill` | Qoder 正在运行就直接中止（避免边写边读损坏数据目录） |
| `--force` | 顶掉别人的 `switch.lock`（只在确认上一个切换进程已卡死时用） |

> ⚠ 切换会**关闭并重启 Qoder IDE**。如果 agent 正运行在这个 IDE 里，执行它就等于自断会话，
> 所以请由用户在控制台点击确认，或在清楚后果的前提下手动跑 CLI。

#### `signin.mjs` — 每日签到

```bash
node --no-warnings scripts/signin.mjs signin [id...] [--json]   # 不传 id = 全部已保存账号
node --no-warnings scripts/signin.mjs history [n] [--json]      # 最近 n 条签到记录
```

签到**不需要切换账号**：当前账号用实时登录态，其余账号解密各自槽位（与令牌缓存比谁新）。
活跃账号**只用不刷**（见[原理](#原理)里的轮换安全策略），非活跃账号过期时自动用
refreshToken 续期并双写回缓存与快照。

#### `console.mjs` — 控制台启动器

```bash
node --no-warnings scripts/console.mjs            # 启动或复用服务，并打开浏览器
node --no-warnings scripts/console.mjs --no-browser
node --no-warnings scripts/console.mjs --restart  # 改过服务端代码后用这个
node --no-warnings scripts/console.mjs --stop     # 按 server.json 里的精确 pid 停止
```

#### 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `QODER_AM_HOME` | 管理数据目录（槽位/注册表/缓存/日志/锁的根） | `~/.qoder-account-manager` |
| `QODER_DATA_DIR` | 覆盖客户端数据目录的自动探测 | 自动（先读进程 `--user-data-dir`，再探候选目录） |
| `QODER_EXE` | 指定 Qoder 可执行文件绝对路径 | 自动解析，顺序见下条说明 |
| `QAM_PORT` | 控制台服务起始端口（占用时自动 +1，最多试 10 次） | `38117` |
| `QAM_TOKEN` | 指定访问 token（不设则启动时随机生成一次性 token） | 随机 |
| `QAM_QODER_PROC_NAME` | 进程名（自测/多实例用，一般别动） | `Qoder CN.exe` |

> `QODER_AM_HOME` 必须对**每一次调用**生效（CLI 与控制台服务是两个进程）。只在某个终端里
> 设一次，就会出现"两个数据目录并存、槽位看起来空了"的错觉。

> **exe 解析顺序**：`QODER_EXE` → `config.exePath` → **运行中进程的镜像路径**（PowerShell 查）
> → 安装根扫描（`%LOCALAPPDATA%\Programs`、`C:\Program Files`、`C:\Program Files (x86)` 下的
> `Qoder CN`/`Qoder`/`qoder-cn`，外加从 `accounts.json` 里已记录过的 exePath **反推出的安装根**，
> 所以支持 `.qoder-versions/<版本>/` 多版本布局并自动取最新版）→ 注册表里那条可能已过期的
> exePath。**装在非常见位置不需要改代码**：设 `QODER_EXE` 或把路径写进 `config.exePath` 就行；
> 只要成功解析过一次，之后靠反推的根目录也能找到。`accounts.mjs doctor` 会打印本次解析结果。

#### `config.json`（管理数据目录下）

```json
{
  "dataDir": null,
  "layout": null,
  "tiers": { "core": true, "browser": false, "appdata": false },
  "exePath": null,
  "launchArgs": [],
  "exitAfterNoQoderSec": 180
}
```

| 字段 | 说明 |
| --- | --- |
| `dataDir` / `exePath` | 手动覆盖自动探测结果（`null` = 自动）。平时用自定义 `--user-data-dir` 启动的人要填这里。 |
| `layout` | 保留字段，布局一律按目录内容实测，写了也不生效。 |
| `tiers` | 快照档位。`core` 不可关；`browser` **默认关**（开着会把会话视图状态一起换走，表现为"切号后原对话不见了"）；`appdata` 默认关。控制台「快照策略」里可切。 |
| `launchArgs` | 重启 Qoder 时附加的命令行参数（字符串数组，非字符串会被丢弃）。 |
| `exitAfterNoQoderSec` | 控制台服务在 Qoder 连续多少秒不在运行后自行退出，`0` = 常驻，默认 180。切换进行中豁免。 |

### 故障排查

| 症状 | 判断与处置 |
| --- | --- |
| 打开页面显示 403 | 地址没带 `?t=<token>`。重新跑 `console.mjs` 拿完整地址；token 绑进程，`--restart` 后会变。 |
| 页面突然点不动 / 连接被拒 | 大概率是服务按设计自退了（Qoder 连续 180s 不在运行）。看 `config.exitAfterNoQoderSec`，想常驻设 `0`。重开 Qoder 再 `/account-console`，槽位数据不受影响。 |
| 显示的「当前登录」不是我正在用的账号 | 先 `accounts.mjs doctor`，核对「生效数据目录」与「布局」。客户端升级换数据目录时，插件可能读到一个已停用的旧目录。 |
| 切完身份没变，像没生效 | ① 看 `switch.log` 是否报 `identity-mismatch`；② 平时用自定义 `--user-data-dir` 启动的，必须把该目录写进 `config.dataDir` 且把参数写进 `config.launchArgs`，否则切换写 A 目录、重启读 B 目录。 |
| 点保存/签到/删除返回 409 | `switch.lock` 有效，说明有一次切换正在跑，这是保护不是坏了；页面写按钮同步置灰。 |
| 明明没在切换却一直报锁 | 上一个切换进程被 IDE 的 Job Object 连带回收时来不及清锁。超过 15 分钟会被识别为陈旧锁自动放行；CLI 急着用可加 `--force`（日志会写明顶掉了谁）。 |
| 槽位标了「布局不兼容」 | 那是旧布局的快照，客户端已升级，**无法恢复**。在新客户端登录该账号后重新 `save`。切换在关闭 IDE **之前**就会预检拦下，不会白关一次。 |
| 签到报 `permanent_auth` | 该账号在别处登录导致 refreshToken 轮换作废。切回该账号登录一次再 `save`（缓存与快照同时刷新）。 |
| 签到报 `live_expired` | 活跃账号的 access token 过期，且刻意不在它背后刷新。打开一次 IDE 让客户端自行续期。 |
| 槽位「全空了」 | 几乎一定是某次调用用了不同的 `QODER_AM_HOME`（或只在某个 shell 里临时设过）。把两个目录都 `ls` 一下对比。 |
| 备注名变成乱码字符 | 请求体非合法 UTF-8 会被 400 拒绝：Git Bash 里用 curl 传中文会被转成 GBK。改用页面输入或 ASCII 名字。 |
| 端口被占用 | 服务从 38117 起自动 +1 探测（最多 10 次），以输出的 `CONSOLE_URL` 为准；要固定端口设 `QAM_PORT`。 |
| 改了 `scripts/*.mjs` 却像没生效 | IDE 加载的是注册表 `installPath` 那份（走本地安装入口时在 `plugins/cache/local/<name>/<version>/`），而你改的可能是仓库或手工副本。用[开发与自测](#开发与自测)里的命令现取目标路径再同步，然后 `console.mjs --restart`。 |
| 版本号显示不对 | 只有**重装**才会把注册表里的 `version` 跟着清单走（加载不刷新它）。走一次 IDE 的本地安装入口即可对齐。 |
| 切号后 IDE 里看不到旧对话 | 先用 `accounts.mjs sessions` 对比计数（或控制台的会话面板）。计数不变就是**视图层**的事，别盲目改档位或手工动文件；默认 `browser` 档关闭正是为了让会话列表保持连续。 |
| 任何命令都报 `No such built-in module: node:sqlite` | Node 低于 22.13/23.4，`node:sqlite` 还在 flag 后面（或压根没有）。这是硬失败，整套命令都起不来，升 Node 而不是绕路。临时验证可试 `node --experimental-sqlite …`。 |

> ⚠ 排障时**绝不要用 `taskkill /IM node.exe`** 去"清理一下"。Qoder 自己派生了很多
> `node.exe` 子进程，一刀切会把 IDE 的正常功能和你自己的控制台服务一起干掉。停服务只用
> `node --no-warnings scripts/console.mjs --stop`（按 `server.json` 里的精确 pid 停）。

### 卸载与数据清理

没有安装器，也就没有卸载器——插件是纯目录：

```bash
# 1) 卸掉插件本体（skills/commands 入口消失；账号数据完好保留）
#    路径以注册表的 installPath 为准：走本地安装入口时在 cache 下，手工放置时在 plugins/ 下
rm -rf ~/.qoder-cn/plugins/cache/local/qoder-account-manager      # IDE 安装入口那份
rm -rf ~/.qoder-cn/plugins/qoder-account-manager                  # 手工放置那份（可能不存在）

# 2) 连运行数据一起清掉（所有槽位作废，每个账号都要重新登录一次再 save）
rm -rf ~/.qoder-account-manager
```

- 走 IDE 的卸载入口更省事（它会自己清注册表条目和缓存目录）；上面两条是给"文件还留着但
  入口没了"或反之的情况兜底用的。
- 只做第 1 步，之后重装回来时 `~/.qoder-account-manager` 里的槽位**原样可用**，
  这正是数据目录与插件目录分开的原因。
- 第 2 步之前想留个念想：`snapshots/` 是登录态密文、`creds/` 是明文令牌，**两者都等同于
  账号本身**，要备份就按"保管密码"的级别处理，不要放同步盘。

## 第二部分 · 数据与边界

### 安全与隐私

这是本工具唯一的"安全模型"，逐条说清楚，方便你自己判断能不能接受：

- **磁盘上的快照等同于登录态**。`snapshots/<id>/auth.v1.dat`、`creds/<id>.json`、
  `server.json` 里的 token 一旦被别人拿到，对方就能以你的身份使用 Qoder。它们只在
  Windows 当前用户的 ACL 下（`server.json` 尽量按 0600 创建，Windows 实际继承目录权限）。
  **别把 `~/.qoder-account-manager/` 放进网盘/同步目录/备份到第三方，也别截图其中的文件。**
  输出侧只给脱敏字段：uid 掩码、邮箱与手机掩码。
  ⚠ 一个例外要知道：**昵称是原样显示的**，而用邮箱注册的账号，客户端把邮箱写进了
  `user.name`——所以页面、CLI 甚至 `switch.log` 里会出现完整邮箱，那是账号自己的显示名，
  不是解密出来的额外信息。截图或分享日志前把它一起当 PII 处理（`--name` 用昵称备注可以
  改善可读性，但不会替换掉客户端给的 name）。
- **token 全程不输出**：不打印到终端、不写进 `switch.log` / `signin-log.json`、不在任何
  HTTP 响应体里。CLI 的 `--json` 也只含掩码。若你哪天在任何输出里看到明文 token，那是 bug，
  请当安全事故报上来。
- **本地服务面**：只监听 `127.0.0.1`；启动时生成一次性 token，所有 `/api` 请求必须携带
  （`?t=` 或 `x-qam-token` 头），并用时间安全比较；校验 `Host` 头挡 DNS rebinding。
  原因是任意网页都能向 localhost 发请求（CSRF），而这个服务能重启 IDE。请求体非合法
  UTF-8 直接 400 拒绝（Windows 下经 Git Bash 调 curl 传中文会被转成 GBK，静默解码会把
  备注名存成 U+FFFD 乱码）。
- **路径注入防护**：槽位 id 会拼进 `snapshots/<id>` 做递归删除与文件覆盖，所以
  `save`/`switch`/`rollback`/`remove` 与所有 `/api/*` 入口都强制 `[A-Za-z0-9_-]{1,64}`，
  `../../x`、`a/b`、绝对路径、超长一律拒绝。
- **并发互斥**：同一时刻只允许一个切换。`switch.mjs` 启动即写 `switch.lock`（含 pid），
  退出时清除；`readSwitchLock` 用「pid 是否存活 + 是否超过 15 分钟」两道判据识别陈旧锁
  （进程被 Job Object 连带回收时不会执行清理代码）。锁有效期间
  `/api/save|signin|remove|rollback|config` 一律 409。CLI 侧可用 `--force` 顶掉，日志会
  如实写明顶了谁。
- **破坏性动作都要显式确认**：CLI 侧 `remove`/`rollback` 必须带 `--yes`，页面侧切换必须
  勾选二次确认；agent / 脚本不会代你点切换按钮（该操作会重启你正在用的 IDE）。
- **不越界读写**：只碰[原理](#原理)里白名单列出的文件，`main.sqlite` 等 29 条禁交换项
  在任何档位下都不交换；`sessions` 只读计数与元信息，不读对话正文。
- **网络行为**：只有签到与令牌续期会出网，目标是 `openapi.qoder.com.cn`；除此之外零遥测、
  零上报，纯离线也能完成保存/切换。claim 之间带 1~3s 随机抖动，避免脚本化高频请求。
- **信任边界（诚实说明）**：本工具以「当前 Windows 用户的权限」读取该用户的 DPAPI 密文，
  这正是 Qoder 自己做的事。它不试图解决"这台机器已被其他进程控制"的威胁模型——任何能
  在你的用户会话里执行代码的进程，理论上都能做同样的解密。

### 支持的客户端布局

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

### 目录与数据

```text
qoder-account-manager/
  .qoder-plugin/plugin.json      # 插件清单
  CHANGELOG.md                   # 版本变更（按 vX.Y.Z 倒序，不在 README 里重复）
  LICENSE                        # MIT
  README.md
  assets/avatar.svg              # logo
  assets/console.html            # 控制台前端（单文件、零外部依赖、离线可用）
  skills/account-console/        # 控制台启动
  skills/account-switch/         # 账号切换
  skills/daily-signin/           # 每日签到
  skills/account-status/         # 状态查看与环境自检
  commands/console.md            # 命令定义（本构建不暴露 commands，实际入口是 skill）
  commands/switch-account.md     # /switch-account
  commands/signin.md             # /signin
  commands/accounts.md           # /accounts
  scripts/qoder_lib.mjs          # 共享库（布局探测/解密/快照/API）
  scripts/status.mjs             # 状态汇总（CLI 与控制台共用同一数据出口）
  scripts/accounts.mjs           # 槽位管理 CLI（含 doctor）
  scripts/switch.mjs             # 切换 CLI
  scripts/signin.mjs             # 签到 CLI
  scripts/server.mjs             # 控制台 HTTP 服务
  scripts/console.mjs            # 控制台启动器（detached）
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

想把它挪到别处（比如换盘、或不想在 home 下留目录）：设环境变量 `QODER_AM_HOME`，所有脚本
与控制台服务都从这里取根路径。

```bash
QODER_AM_HOME=D:\qoder-accounts node --no-warnings scripts/console.mjs
```

> 注意：这个环境变量必须对**每一次调用**都生效（CLI 与控制台服务是两个进程），否则会出现
> 两个数据目录并存、槽位"看起来丢了"的错觉。想长期换位置，建议用系统级环境变量，或做个
> 小启动脚本，别只设在某个终端里。

```text
~/.qoder-account-manager/
  accounts.json        # 账号注册表（id/备注/uid/脱敏身份/布局/exe 路径；不含任何令牌）
  config.json          # 数据目录/exe 覆盖、快照档位、launchArgs、exitAfterNoQoderSec（默认 180，0=常驻）
  server.json          # 控制台服务地址与 token（尽量按 0600 创建；Windows 上实际权限继承目录 ACL）
  switch.log           # 最近一次切换的进度输出（每次启动切换都重写）
  switch.lock          # 切换互斥锁（pid/目标/时间戳），进程退出即清除，陈旧锁自动识别
  snapshots/<id>/      # 登录态快照（含凭证密文，等同登录态，勿外传）
  snapshots/<id>.bak   # 上一代快照（可 rollback 换回来）
  snapshots/<id>.meta.json      # 槽位元数据（布局/保存时间/未拷全条目/告警）
  snapshots/<id>.meta.json.bak  # 上一代的元数据（与 .bak 配对，回退时一起换）
  creds/<id>.json      # 令牌缓存（save 时同步、刷新后双写；明文，仅本机，等同登录态）
  signin-log.json      # 签到日志（滚动 200 条）
```

### 已知边界

- 客户端只存单账号，**无原生多账号切换**，本插件靠快照交换实现。
- **「切号后继续之前的对话」已端到端验证过一次**（acct2 → acct1，见[原理](#原理)里的实测
  记录）：落地身份由脚本回读核对，会话数据一条没少，IDE 的会话列表里切换前创建的对话仍在。
  这只覆盖 v2 布局 + 默认档位这一条路径的一次切换；v1 旧布局、开 `browser` 档、以及
  多工作区跨账号可见性都还没实测过。若哪天出现"看不到旧对话"，先用
  `accounts.mjs sessions` 对比计数：计数不变就是视图层的事，别盲目改档位或手工动文件。
- **默认档位下运行中保存是完全可靠的**（只碰 4 个小身份文件，0 告警）。若手动打开
  `browser` 档，`Network/Cookies` 会被 Chromium 独占（连共享读都拒绝，字节级
  read/write 回退也失败）而跳过并告警；身份靠 `auth.v1.dat`，缺 cookie 不影响切号后
  登录，且恢复时对不完整目录降级为合并，不会删掉实时 cookie。要完整快照请关闭
  Qoder 后 `save <id> --kill`。
- 默认档位下各账号**共用同一份对话列表**（`main.sqlite` 不交换）——这正是"切号续聊"
  的实现方式，也意味着账号 B 能看到账号 A 的对话。需要隔离时打开 `browser` 档。
- 非当前登录账号的签到凭证来自其槽位快照与令牌缓存，**取更新的那一份**（缓存可能装着已被
  服务端轮换作废的旧 refreshToken）；若该账号在别处登录导致刷新令牌轮换失效，会提示
  `permanent_auth`，需切回该账号重新 `save`。
- **如果你平时用自定义 `--user-data-dir` 启动 Qoder**：请把那个目录同时写进
  `config.json` 的 `dataDir`，并把启动参数放进 `config.launchArgs`（数组），否则切换写的是
  探测到的目录、重启后客户端又读回它自己的默认目录，看起来就像"切换没生效"。
  `accounts.mjs doctor` 会打印当前生效的数据目录，先核对再排障。
- 活跃账号 token 过期时返回 `live_expired` 而不代为刷新（见轮换安全策略）。
- **令牌刷新 + 回写快照这条路径尚未实测**：验证它需要轮换掉当前账号的刷新令牌，
  风险不对等，故刻意未触发。代码含写回前解密自校验与失败回滚。
- **服务生命周期只验过 `taskkill` 这一条路径**（IDE 被强杀后服务仍在）。IDE 正常退出、
  崩溃、关机时服务会被怎样，没有实测结论，所以文档里不承诺任何一侧。
- `auth.machine-id` 随快照交换（每账号绑定各自设备标识）；未实现浏览器指纹隔离，
  两账号在同一台机器上共享硬件层指纹，风控风险自控。
- 若客户端未来启用 app-bound encryption，外部进程将无法解密，`getAesKey` 会明确报错
  而非静默失败。
- **仅 Windows**：DPAPI / `tasklist` / `taskkill` / 进程探测都是 Win32 的。macOS/Linux
  需要重写解密后端（keychain / libsecret）才能工作，当前没有实现。
## 第三部分 · 开发者参考

### 原理

- **登录态快照白名单（v2，分档可配）**
  - `core`（不可关，默认开）：`auth.v1.dat`、`Local State`、`auth.machine-id`、
    `auth-profile-overlays.v1.dat`
  - `browser`（**默认关**）：`Preferences`、`first-launch-onboarding.v1.json`、
    `Network`、`Local Storage/leveldb`、`Session Storage`
  - `appdata`（默认关）：`qoder-data.v1.json`、`qoder-data.v1.ext.json`、
    `Partitions`、`app-plugin-data`
  - ⚠ `Local State` 必须与 `auth.v1.dat` **同进同出**：实测不同数据目录的
    `os_crypt.encrypted_key` **不相同**，只换凭证不换密钥会导致恢复后解不开。
  - ⚠ `browser` 档默认关闭是**为了实现"切号后继续之前的对话"**，见下条。
- **快照写入的容错与回退**
  - 写入顺序：预检（当前目录必需文件齐全）→ 旧快照连同 meta 一起挪成 `.bak` → 逐项容错拷贝
    → 校验「必需文件在 + 真能解密出登录态」→ 写令牌缓存 → 写 meta。
  - **校验不通过就还原**：删掉半成品槽位，把 `.bak` 连同 `.meta.json.bak` 一起换回主槽位，
    不会出现「重新保存失败 → 原槽位从列表里消失」；新增槽位失败则整体清干净，不留半成品。
  - `.bak` 是**可操作的**回退点，不只是个提示：控制台槽位卡片有「回退到上一代」按钮，
    CLI 是 `accounts.mjs rollback <id> --yes`，互换对称，再执行一次就换回来。
  - `save` 成功后同步刷新 `creds/<id>.json`：令牌缓存只是副本，快照才是真源；不刷新就会
    留下已被服务端轮换作废的旧 refreshToken，让签到误报 `permanent_auth`。
- **切换有回读验证**：恢复完不会只看"拷了几个文件"，而是把实时目录的登录态重新解一遍，
  确认 uid 与目标一致才继续重启；不一致直接报 `identity-mismatch` 并停止，不给你一个
  「以为切过去了其实没切」的 IDE。验证通过后顺带把实时凭证写回该槽位的缓存。
- **对话保留（已端到端实测）**
  - **实测结论**：2026-10-09 08:06 从 `acct2` 切到 `acct1`，`switch.log` 记录「回读验证 ✓
    实时目录登录态与目标 uid 一致」；切换前后 `main.sqlite` 会话一条没少（15 条 / 307 条消息），
    重启后 IDE 的会话列表里切换前创建的对话仍在列，正在进行的会话也跨过了这次 IDE 重启。
  - 聊天记录在 `main.sqlite`（51MB+）与 `chat-session-*.sqlite`，属**禁交换硬红线**
    （29 条，`snapshotWhitelist` 与 `restoreSnapshot` 双重过滤，任何配置都绕不过）。
  - 更关键的是 `Local Storage/leveldb` 里存着 `workspaceSessions` / `workspaceLayout` /
    `workspace` 等**渲染层视图状态**。它们不是身份，但随账号一起交换就会把目标账号
    上次的视图状态盖上来，表现为"切号后原对话不见了"——所以 `browser` 档默认关闭。
  - 实测结论（0.4.3，可用 `accounts.mjs sessions` 复现）：`chat_sessions` 共 33 列，
    **无任何账号语义列**；会话列表 SQL 为 `SELECT session_id, updated_at FROM
    chat_sessions`（连 WHERE 都没有），其余查询只按 `workspace_id` / `session_id` /
    `archived` / `deleted_at` 过滤；`workspaces` 表也无账号列，`workspace_id` 是随机
    UUIDv4（非账号派生），按 `root_paths` 匹配文件夹；leveldb / Session Storage /
    Partitions 中搜不到任何账号作用域串。**即本地库层面不存在按账号隔离会话的机制。**
  - 客户端确有账号作用域（`qoder:prod:cn:<sha256>`，见 `qoder-data.v1.json` 的
    `agentAccountScope` 与 `.ext.json` 的 `accounts.<scope>`），但它作用于
    **agentProfiles / squads / agentRuntimes**（agent 配置层），不作用于会话。
    `app.asar` 里的 `switchAccountIfNeeded` 也只重置模型目录缓存。
  - v1 旧布局的「最近打开」全局键在切换后自动合并回写；v2 无需处理（该键在
    `main.sqlite` 内，本就不交换）。
- **凭证解密链**（两种布局共用，Electron safeStorage = Chromium os_crypt）：
  `Local State → os_crypt.encrypted_key → base64 → DPAPI → AES-256-GCM 32B 密钥`
  → `'v10' + nonce(12) + ct + tag(16)`。
  v2 明文结构 `{schemaVersion:1, token(dt-), refreshToken(drt-), expiresAt,
  refreshTokenExpiresAt, user:{id,name,email,phone,avatarUrl}}`。
  实测 `app_bound=false`，故也能**反向加密写回**（续期令牌持久化用）。
- **无原生多账号**：客户端只存单账号，`auth-profile-overlays.v1.dat` 仅头像/昵称装饰层
  （≤16 条）；app.asar 内的 `switchAccountIfNeeded` 只是内部缓存失效函数。因此只能走
  快照交换。
- **签到 API**：`openapi.qoder.com.cn` sash 活动体系——
  `GET /sash/api/v1/me/campaigns` 全量列表，`POST .../campaigns/{id}/claim`
  幂等领取（Content-Length: 0）；必带 `Cosy-ClientType: 10`（缺失时返回空列表）。
  零 CLAIMABLE 时先查当日 CLAIMED grant 定真话，再盲发反学/硬编码活动 id 兜底。
- **令牌续期**：`POST /api/v1/deviceToken/refresh`（drt-）/
  `/api/v1/jobToken/refresh`（jrt-）。刷新令牌一次性轮换，成功后新凭证**双写**到
  `creds/` 缓存与该槽位快照的 `auth.v1.dat`，防旧令牌失效锁死账号。
- **轮换安全策略**：**当前活跃账号只用不刷**——在它背后刷新会作废客户端持有的
  refreshToken，等于把正在用的账号踢下线；token 过期时返回 `live_expired` 让用户开一次
  IDE 自行续期。
- **风控内建**：claim 间隔 1~3s 随机抖动；token 全程不输出到终端/日志/HTTP 响应。

### 开发与自测

- **改前端不用重启**：`assets/console.html` 每次请求现读，浏览器刷新即生效；改 `scripts/*.mjs`
  则要 `console.mjs --restart`（服务进程已把代码载入内存）。
- **沙箱演练**：危险路径（`remove`、`rollback`、保存失败的还原分支）请用独立数据目录试，
  不碰真槽位：
  ```bash
  QODER_AM_HOME=$(mktemp -d) node --no-warnings scripts/accounts.mjs list
  ```
- **看门狗逻辑**：`QAM_QODER_PROC_NAME` 能把"IDE 是否在运行"的探针指向任意进程名，
  `QAM_PORT`/`QAM_TOKEN` 可固定端口与 token，便于脚本化测试。
- **自测入口**：`accounts.mjs status --json` 的 `QAM_JSON:` 一行就是控制台 `/api/status`
  的同一份数据（两者共用 `status.mjs` 的 `collectStatus()`），页面显示异常时先用 CLI 对照。
- **变更记进 CHANGELOG.md**：影响用户行为的改动先写进「未发布」，发版时改写成版本段并同步
  清单 `version`；分组与写法见 `CHANGELOG.md` 开头。
- **代码改动要同步到生效副本**：仓库、IDE 加载的那份（注册表 `installPath`）、以及可能残留的
  手工放置副本，只有第二处决定实际跑的是什么。从仓库同步过去，目标路径现取：
  ```bash
  TARGET=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.USERPROFILE+"/.qoder-cn/plugins/installed_plugins_v2.json","utf8")).plugins["qoder-account-manager@local"][0].installPath)')
  cp -r .qoder-plugin assets commands scripts skills README.md CHANGELOG.md LICENSE "$TARGET/" && diff -r . "$TARGET" --exclude=.git
  ```
  改完 `scripts/*.mjs` 要 `console.mjs --restart` 才生效，改 `skills/`、`commands/`、
  `.qoder-plugin/` 建议重启 IDE 重新扫描。数据都在 `~/.qoder-account-manager`，同步代码不影响槽位。
- 发版前用 create-plugin 的离线校验器复核清单与目录结构（`validate_qoder_plugin.py <插件目录>`），
  再确认 `CHANGELOG.md` 的「未发布」已改写成版本段、`.qoder-plugin/plugin.json` 的 `version` 同步。

### 许可

MIT，见 [LICENSE](LICENSE)。作者对因使用本工具导致的账号风控、数据丢失或服务条款纠纷
不承担任何责任；请勿用它访问你不拥有的账号。


