# 命令参考

`<插件根>` = 仓库或安装目录。所有命令都写成 `node --no-warnings <插件根>/scripts/xxx.mjs`
（`--no-warnings` 是为了压掉 `node:sqlite` 的实验特性警告，不是必需）。带 `--json` 的命令会在
stdout 末尾多输出一行 `QAM_JSON:{...}`，控制台服务就是靠它解析的，脚本化时按前缀取即可。

## `accounts.mjs` — 槽位管理

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
| `credits [id...] [--refresh] [--json]` | 各账号 credits 额度分段与到期日；不传 id = 全部槽位，5 分钟内走缓存 |

切换动作在 `switch.mjs`（见下）；`rename` 与控制台的 `/api/rename` 等价。

槽位 id 规则：**字母/数字/`_`/`-`，1~64 字符**（id 会拼进快照目录名，非法 id 在入口直接拒绝，
`../x`、`a/b`、超长一律报错/400）。`--name` 的值不能以 `-` 开头（会被当成开关）。

## `credits` — 额度与到期

```bash
node --no-warnings scripts/accounts.mjs credits                 # 全部槽位
node --no-warnings scripts/accounts.mjs credits acct1 --refresh # 只查一个并强制出网
```

额度**按到期时间分批**：同一到期时刻的剩余额度合成一批，到期时刻不同必然分开——所以“条”本身就是
答案（一格 = 一批，格宽 = 该批额度占比，颜色按紧迫度：≤3 天红、≤7 天橙、≤21 天蓝、更久绿，
到期日未定的画灰斜纹）。三种到期语义要分清：

| 额度池 | 到期语义 | 数据来源 |
| --- | --- | --- |
| 套餐额度 `userQuota` | 随套餐周期固定到期 | `qoderUsage.expiresAt` / `plan.end_date` |
| 加购/赠送 `addOnQuota` | **每日 10:00(UTC+8) 刷新、领取后 N 天有效**（滚动，与套餐周期无关） | 活动接口的 `benefit.validity` + 本地领取账本逐笔拆 |
| 专属资源包 / 组织共享包 | 各自带 `expiresAt`；没带就标“到期由后台决定” | `dedicatedResourcePackages[]` / `orgResourcePackage` |

接口只给 `addOnQuota` 的合计余额、不给逐笔到期，所以逐笔到期由本工具还原：签到日志里每次领取
（`success` / `already` 且带 `reward`）算一笔，到期 = 领取时刻 + `validity.days` 天，按**先到期先扣**
把余额分到各笔上；**在 IDE 里领走、工具没记到的那部分不假装知道**，单列成“到期未定”批次并写明原因。

输出示例：

```text
acct2  100196715***@qq.com · 131****1891  [当前登录 · 凭证=ide-live · 套餐 Pro]
  额度周期：2026/09/14 ~ 2026/10/14（剩 4 天）
  每日赠送：每天领 100 Credits · 每日 10:00（UTC+8）刷新，领取后 30 天有效 · 今日已领
  按到期分批 ░░░░░░░░░░░░░░░░░░░░░░░░░░░░  3 批 · 共 1,052
    ░ 11-08 到期 100（29 天后）← 加购/赠送额度 [领取于 2026-10-09]
    ░ 11-09 到期 100（30 天后）← 加购/赠送额度 [领取于 2026-10-10]
    ? 到期未知 852（到期未定）← 加购/赠送额度 [本地无领取记录，到期未知]
    ▸ 套餐额度 · Pro    ████████████████████ 100.0%  2000/ 2000 剩     0  到期 2026/10/14（4 天后 · 随套餐周期） · 已用尽
    ▸ 加购/赠送额度     ███████████░░░░░░░░░  53.0%  1148/ 2200 剩  1052  每日刷新 · 领取后 30 天到期 · 可用
  合计：剩 1,052 / 4,200 credits（已用 75%，服务端口径 75%）· 2 池 / 3 批 · 最近到期 2026/11/08（29 天后）
  ⓘ 其中 852 是每日赠送但本地没有领取记录，到期日只能待定（在 IDE 里领的不会被本工具记到）
```

控制台展示的是同一份数据，见 [console.md](console.md)。

- **只读**：三个 GET（用量 + 套餐 + 活动列表），都不刷新令牌。活跃账号因此也能直接查，不存在
  “把正在用的账号踢下线”的风险——签到那套「只用不刷」策略在这里天然满足。活动列表拿不到时
  不编造规则：加购/赠送整块标为“到期未知”。
- **缓存**：结果落 `credits.json`，只含数字、日期、活动文案与掩码 uid（无令牌、无邮箱手机）。
  5 分钟内重复调用不出网，`--refresh` 强制。控制台的「刷新额度」共用同一份缓存，签到完成与
  切换落地后会自动强刷一次。
- **失败分类**：`auth`（该槽位登录态失效，需重新登录一次并 `save`，或跑签到让令牌续期）、
  `creds`（解不出可用凭证）、`network`、`server`、`invalid`，以及 `enterprise`——企业版额度归
  组织后台，接口只返回详情页链接，页面与 CLI 都如实说明而不是显示 0。
- 读不到额度**不影响**保存/切换/签到任何一条路径：那是独立的只读分支，失败只在原处告警。
- **切换进行中一律不读**：`switch.lock` 有效时只返回缓存并标注 `switching`——要解的
  `auth.v1.dat` 正是此刻被替换的那个文件，读出来的身份可能半新半旧。页面的「刷新额度」
  在这段时间也是置灰的。

## `switch.mjs` — 账号切换

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

## `signin.mjs` — 每日签到

```bash
node --no-warnings scripts/signin.mjs signin [id...] [--json]   # 不传 id = 全部已保存账号
node --no-warnings scripts/signin.mjs history [n] [--json]      # 最近 n 条签到记录
```

签到**不需要切换账号**：当前账号用实时登录态，其余账号解密各自槽位（与令牌缓存比谁新）。
活跃账号**只用不刷**（见 [design.md](design.md) 的轮换安全策略），非活跃账号过期时自动用
refreshToken 续期并双写回缓存与快照。

## `console.mjs` — 控制台启动器

```bash
node --no-warnings scripts/console.mjs            # 启动或复用服务，只打印地址（不弹系统浏览器）
node --no-warnings scripts/console.mjs --browser  # 额外用系统默认浏览器打开页面
node --no-warnings scripts/console.mjs --restart  # 改过服务端代码后用这个
node --no-warnings scripts/console.mjs --stop     # 让服务自己退出；卡死时才核对身份后按 pid 结束
```

页面默认交给 Qoder 内置浏览器打开（`/account-console` 会自己完成这一步），避免同一个页面
在内置浏览器和系统浏览器里各开一份。`--stop` 会先请求服务端自退（切换进行中或有保存/签到
在执行时会被拒绝）；服务没响应时才走兜底，且兜底前会核对 pid 的命令行确实是 `server.mjs`。

## 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `QODER_AM_HOME` | 管理数据目录（槽位/注册表/缓存/日志/锁的根） | `~/.qoder-account-manager` |
| `QODER_DATA_DIR` | 覆盖客户端数据目录的自动探测 | 自动（先读进程 `--user-data-dir`，再探候选目录） |
| `QODER_EXE` | 指定 Qoder 可执行文件绝对路径 | 自动解析，顺序见下条说明 |
| `QAM_PORT` | 控制台服务起始端口（占用时自动 +1，最多试 10 次） | `38117` |
| `QAM_TOKEN` | 指定访问 token（不设则启动时随机生成一次性 token） | 随机 |
| `QAM_QODER_PROC_NAME` | 进程名（自测/多实例用，一般别动） | `Qoder CN.exe` |

> `QODER_AM_HOME` 必须对**每一次调用**生效（CLI 与控制台服务是两个进程）。只在某个终端里
> 设一次，就会出现“两个数据目录并存、槽位看起来空了”的错觉。

> **exe 解析顺序**：`QODER_EXE` → `config.exePath` → **运行中进程的镜像路径**（PowerShell 查）
> → 安装根扫描（`%LOCALAPPDATA%\Programs`、`C:\Program Files`、`C:\Program Files (x86)` 下的
> `Qoder CN`/`Qoder`/`qoder-cn`，外加从 `accounts.json` 里已记录过的 exePath **反推出的安装根**，
> 所以支持 `.qoder-versions/<版本>/` 多版本布局并自动取最新版）→ 注册表里那条可能已过期的
> exePath。**装在非常见位置不需要改代码**：设 `QODER_EXE` 或把路径写进 `config.exePath` 就行；
> 只要成功解析过一次，之后靠反推的根目录也能找到。`accounts.mjs doctor` 会打印本次解析结果。

## `config.json`（管理数据目录下）

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
| `tiers` | 快照档位。`core` 不可关；`browser` **默认关**（开着会把会话视图状态一起换走，表现为“切号后原对话不见了”）；`appdata` 默认关。控制台「快照策略」里可切。 |
| `launchArgs` | 重启 Qoder 时附加的命令行参数（字符串数组，非字符串会被丢弃）。 |
| `exitAfterNoQoderSec` | 控制台服务在 Qoder 连续多少秒不在运行后自行退出，`0` = 常驻，默认 180。切换进行中豁免。 |
