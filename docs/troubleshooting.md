# 故障排查

| 症状 | 判断与处置 |
| --- | --- |
| 打开页面显示 403 | 地址没带 `?t=<token>`。重新跑 `console.mjs` 拿完整地址；token 绑进程，`--restart` 后会变。 |
| 页面突然点不动 / 连接被拒 | 大概率是服务按设计自退了（Qoder 连续 180s 不在运行）。看 `config.exitAfterNoQoderSec`，想常驻设 `0`。重开 Qoder 再 `/account-console`，槽位数据不受影响。 |
| 服务停不掉 | 先试 `node --no-warnings scripts/console.mjs --stop`。切换进行中或有保存/签到在执行时会被拒绝（这是保护）；服务卡死时才走兜底，且会先核对 pid 命令行。不要用 `taskkill /IM node.exe`。 |
| 显示的「当前登录」不是我正在用的账号 | 先 `accounts.mjs doctor`，核对「生效数据目录」与「布局」。客户端升级换数据目录时，插件可能读到一个已停用的旧目录。 |
| 切完身份没变，像没生效 | ① 看 `switch.log` 是否报 `identity-mismatch`；② 平时用自定义 `--user-data-dir` 启动的，必须把该目录写进 `config.dataDir` 且把参数写进 `config.launchArgs`，否则切换写 A 目录、重启读 B 目录。 |
| 点保存/签到/删除返回 409 | `switch.lock` 有效，说明有一次切换正在跑，这是保护不是坏了；页面写按钮同步置灰。 |
| 明明没在切换却一直报锁 | 上一个切换进程被 IDE 的 Job Object 连带回收时来不及清锁。超过 15 分钟会被识别为陈旧锁自动放行；CLI 急着用可加 `--force`（日志会写明顶掉了谁）。 |
| 槽位标了「布局不兼容」 | 那是旧布局的快照，客户端已升级，**无法恢复**。在新客户端登录该账号后重新 `save`。切换在关闭 IDE **之前**就会预检拦下，不会白关一次。 |
| 签到报 `permanent_auth` | 该账号在别处登录导致 refreshToken 轮换作废。切回该账号登录一次再 `save`（缓存与快照同时刷新）。 |
| 签到报 `live_expired` | 活跃账号的 access token 过期，且刻意不在它背后刷新。打开一次 IDE 让客户端自行续期。 |
| 额度查询报 `auth` | 该槽位存下来的登录态已经失效（额度只读、不会替它续期）。在新客户端登录该账号后重新 `save`，或先跑一次签到让令牌轮换回新鲜。 |
| 额度显示“企业版额度在组织后台” | `displayMode==='enterprise'` 的正常表现：这类账号的额度不在公开接口里，页面只给详情页链接，不会伪造一个数字。 |
| 数字像没变 | 命中了 5 分钟缓存。点页面上的「刷新额度」或 CLI 加 `--refresh`；也可直接删掉 `credits.json`（下次重取）。 |
| 槽位「全空了」 | 几乎一定是某次调用用了不同的 `QODER_AM_HOME`（或只在某个 shell 里临时设过）。把两个目录都 `ls` 一下对比。 |
| 备注名变成乱码字符 | 请求体非合法 UTF-8 会被 400 拒绝：Git Bash 里用 curl 传中文会被转成 GBK。改用页面输入或 ASCII 名字。 |
| 端口被占用 | 服务从 38117 起自动 +1 探测（最多 10 次），以输出的 `CONSOLE_URL` 为准；要固定端口设 `QAM_PORT`。 |
| 改了 `scripts/*.mjs` 却像没生效 | IDE 加载的是注册表 `installPath` 那份（走本地安装入口时在 `plugins/cache/local/<name>/<version>/`），而你改的可能是仓库或手工副本。同步方法见 [dev.md](dev.md#同步到生效副本)，然后 `console.mjs --restart`。 |
| 版本号显示不对 | 只有**重装**才会把注册表里的 `version` 跟着清单走（加载不刷新它）。走一次 IDE 的本地安装入口即可对齐。 |
| 切号后 IDE 里看不到旧对话 | 先用 `accounts.mjs sessions` 对比计数（或控制台的会话面板）。计数不变就是**视图层**的事，别盲目改档位或手工动文件；默认 `browser` 档关闭正是为了让会话列表保持连续。 |
| 任何命令都报 `No such built-in module: node:sqlite` | Node 低于 22.13/23.4，`node:sqlite` 还在 flag 后面（或压根没有）。这是硬失败，整套命令都起不来，升 Node 而不是绕路。临时验证可试 `node --experimental-sqlite …`。 |

> ⚠ 排障时**绝不要用 `taskkill /IM node.exe`** 去“清理一下”。Qoder 自己派生了很多
> `node.exe` 子进程，一刀切会把 IDE 的正常功能和你自己的控制台服务一起干掉。停服务只用
> `node --no-warnings scripts/console.mjs --stop`（优先让服务自己退出）。
