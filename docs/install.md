# 安装、升级与卸载

## 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | **Windows 10/11** | 解密走 DPAPI，进程控制用 `tasklist`/`taskkill`；不支持 macOS/Linux。 |
| Qoder CN IDE | 已安装，且**至少成功登录过一次** | 适配 0.4.3（electron-root 布局），并兼容旧 icube 布局。 |
| Node.js | **≥ 22.13**（或 ≥ 23.4） | 需要内置 `node:sqlite`。验证于 v22.23.2 / v24.19.0；版本不够整套命令都起不来。 |
| PowerShell | 系统自带 | DPAPI 解密助手 `scripts/dpapi_unprotect.ps1`，经 stdin/stdout 传 base64，不落临时文件。 |

装之前先确认环境：

```bash
node -e "require('node:sqlite'); console.log('node:sqlite OK', process.version)"
```

## 安装

### 方式 A：作为 Qoder 插件（推荐，能用 `/account-console` 等斜杠入口）

装法二选一，**别两条都走**，否则会留下互相不知情的副本。

**A-1 走 IDE 的本地安装入口（推荐）**：从
[Releases](https://github.com/CyrilPeng/qoder-account-manager/releases) 下载
`qoder-account-manager-v<版本>.zip`，解压后在插件管理里选“从本地安装”，指向解压出来的
`qoder-account-manager/` 目录。发布包按版本号命名，不含 git 历史，也不含任何账号数据。

IDE 会把内容复制进版本化缓存，并写一条注册表记录：

```text
~/.qoder-cn/plugins/cache/local/qoder-account-manager/<version>/
installed_plugins_v2.json → "qoder-account-manager@local": { scope, installPath, version, installedAt, … }
```

`version` 从 `.qoder-plugin/plugin.json` 读取，**只有重装时才会刷新**，改代码不会动它。

> 直接指向 `git clone` 出来的工作目录也能装上，但 IDE **不会剥离 `.git`**，会把整份 git
> 历史复制进缓存目录。要干净副本就用 Release 包，或在仓库里跑 `node scripts/release.mjs`。

**A-2 手工放置**：把插件目录（含 `.qoder-plugin/`）复制进 IDE 的插件目录，落地目录名与清单
`name` 一致：

```bash
cp -r qoder-account-manager "$USERPROFILE/.qoder-cn/plugins/"
```

之后若改走 A-1 重装，注册表会改指缓存目录，手工那份立刻成为没人引用的孤儿副本——“改了代码
不生效”多半是这个原因，删掉孤儿即可。

装完重启 Qoder 让斜杠菜单重新扫描，应能看到 `account-console` / `account-switch` /
`account-status` / `daily-signin` 四项。接着确认当前生效的是哪一份，在那一份里自检：

```bash
cd "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.USERPROFILE+"/.qoder-cn/plugins/installed_plugins_v2.json","utf8")).plugins["qoder-account-manager@local"][0].installPath)')"
node --no-warnings scripts/accounts.mjs doctor
```

`doctor` 打印出生效数据目录、布局 v2 与 exe 路径就可以开始了。注册表由安装流程整体维护，
**不要手工编辑它**。

### 方式 B：纯 CLI / 便携使用（不注册、不重启 IDE）

代码路径全部相对自身解析，运行数据固定在 `~/.qoder-account-manager`（可用 `QODER_AM_HOME`
改），所以放哪儿都能跑，也不必是 git 仓库：

```bash
cd /d/tools/qoder-account-manager     # Git Bash 写法；cmd/PowerShell 里是 D:\tools\qoder-account-manager
node --no-warnings scripts/console.mjs        # 直接开控制台（会打印带 token 的地址）
node --no-warnings scripts/accounts.mjs list
```

需要“插到别的机器就用”时，复制这几个文件即可，无需 npm install、无需构建：
`.qoder-plugin/plugin.json`、`assets/`、`commands/`、`scripts/`、`skills/`、`README.md`。
`docs/` 与 `tests/` 只在开发时需要。

> **版本库里只有代码。** 运行数据（登录态快照、令牌缓存、注册表、日志）全在
> `~/.qoder-account-manager`，与仓库位置无关，所以 clone、打包、分享这个仓库**不会带走
> 任何账号凭证**；反过来，也不要把那个数据目录放进仓库或同步盘。

## 数据目录搬家

设环境变量 `QODER_AM_HOME`，所有脚本与控制台服务都从这里取根路径：

```bash
QODER_AM_HOME=D:\qoder-accounts node --no-warnings scripts/console.mjs
```

> 这个变量必须对**每一次调用**生效（CLI 与控制台服务是两个进程），否则会出现两个数据目录
> 并存、槽位“看起来丢了”的错觉。想长期换位置，建议用系统级环境变量或写个小启动脚本。

## 卸载与数据清理

没有安装器，也就没有卸载器——插件是纯目录：

```bash
# 1) 卸掉插件本体（skills/commands 入口消失；账号数据完好保留）
#    路径以注册表的 installPath 为准：走本地安装入口时在 cache 下，手工放置时在 plugins/ 下
rm -rf ~/.qoder-cn/plugins/cache/local/qoder-account-manager      # IDE 安装入口那份
rm -rf ~/.qoder-cn/plugins/qoder-account-manager                  # 手工放置那份（可能不存在）

# 2) 连运行数据一起清掉（所有槽位作废，每个账号都要重新登录一次再 save）
rm -rf ~/.qoder-account-manager
```

- 走 IDE 的卸载入口更省事（它会自己清注册表条目和缓存目录）；上面两条是给“文件还留着但
  入口没了”或反之的情况兜底用的。
- 只做第 1 步，之后重装回来时 `~/.qoder-account-manager` 里的槽位**原样可用**，
  这正是数据目录与插件目录分开的原因。
- 第 2 步之前想留个念想：`snapshots/` 是登录态密文、`creds/` 是明文令牌，**两者都等同于
  账号本身**，要备份就按“保管密码”的级别处理，不要放同步盘。
