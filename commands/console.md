---
description: 打开 Qoder 账号控制台（图形界面切换账号/签到/管理槽位）
argument-hint: "[--stop|--restart]"
---

启动 Qoder 多账号本地控制台（浏览器图形界面），这是切换账号的**首选入口**。

1. 运行启动器（`<插件根>` = 本命令文件所在插件根目录，即 commands/ 的上一级）：

   ```bash
   node --no-warnings <插件根>/scripts/console.mjs $ARGUMENTS
   ```

   启动器会以 **detached** 方式拉起服务并自动打开浏览器，输出形如
   `CONSOLE_URL:http://127.0.0.1:<port>/?t=<token>`。若服务已在运行则直接复用。

2. 把 `CONSOLE_URL` 完整地址转述给用户（含 token，缺 token 打不开）。
   告知：服务**不需要常驻**——登录数据固化在 `~/.qoder-account-manager/`，服务随 Qoder
   退出被关掉也没关系，下次打开 Qoder 重新执行本命令，所有槽位原样可用。

3. 参数：`--stop` 停止服务，`--restart` 重启服务，`--no-browser` 只启动不开浏览器。

## 注意

- **本构建的斜杠菜单只暴露插件 skills，不暴露 `commands/`**：引导用户时说 `/account-console`
  这个 skill 名，或直接给可复制的 `node --no-warnings scripts/console.mjs` 命令行。
- 控制台只监听 127.0.0.1，且所有接口需 token 校验（防其他网页对 localhost 发 CSRF）。
- 用户在控制台点「切换到此账号」会关闭并重启 Qoder IDE。若你正运行在该 IDE 内，
  会话会随之中断——因此**不要代替用户点击切换**，让用户自己在控制台确认。
- 页面还有「回退到上一代」（把槽位与它的 `.bak` 互换，覆盖保存点错时用）与
  「会话可见性」前后对比（切换前点「记为切换前基线」）。
- 有切换在跑时 `switch.lock` 生效，页面上写操作按钮会全部置灰、接口返回 409；
  这是防止两个进程同时交换同一个数据目录，不是坏了。此时 `--stop` 也会被拒绝。
- 服务不常驻：Qoder 连续 180s 不在运行就自动退出（省内存）。阈值在 `config.json` 的
  `exitAfterNoQoderSec`，设 0 变常驻；切换进行中不会退。页面顶部有倒计时横幅。
- 需要停止服务时用 `--stop`，**不要** `taskkill /IM node.exe`：机器上叫 node.exe 的
  进程未必都属于本插件，一刀切会连带杀掉别的（包括正在跑的切换）。用 `--stop` 或按
  `server.json` 里的 pid 精确处理。
