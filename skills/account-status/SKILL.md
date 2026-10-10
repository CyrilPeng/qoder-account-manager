---
name: account-status
version: 2.1.0
description: Show Qoder account slots, current login, credential expiry, per-account credits segments with expiry dates, sign-in status, and diagnose which client data directory is actually in use.
description_zh: 查看 Qoder 账号槽位、当前登录账号、凭证有效期、每个账号的 credits 额度分段与到期日、签到状态，并自检实际生效的客户端数据目录与布局。
user-invocable: true
argument-hint: ""
---

# Qoder 账号状态

查看多账号管理的全局状态。脚本目录 = 本 SKILL.md 所在插件根目录下的 `scripts/`。

## 流程

1. **环境自检（遇到"显示的账号不是我正在用的"时先跑这个）**：

   ```bash
   node --no-warnings scripts/accounts.mjs doctor
   ```

   输出生效数据目录、识别布局、候选目录对照、exe 解析结果、以及哪些槽位因客户端
   升级而布局不兼容。

2. 详细状态（含凭证缓存、签到记录、快照策略）：

   ```bash
   node --no-warnings scripts/accounts.mjs status
   ```

3. 简表（槽位 + 当前登录 + 进程状态）：

   ```bash
   node --no-warnings scripts/accounts.mjs list
   ```

4. 最近签到历史：

   ```bash
   node --no-warnings scripts/signin.mjs history 14
   ```

5. **会话可见性诊断**（用户问"切号后对话还在不在"时必跑，切换前后各一次做对比）：

   ```bash
   node --no-warnings scripts/accounts.mjs sessions
   ```

   只读 `main.sqlite` 的计数与元信息，不读对话正文。输出会话总数、按工作区分布，
   以及 `chat_sessions` 是否存在账号语义列（实测为无 → 会话不按账号隔离）。

6. **额度与到期**（用户问"还有多少 credits / 什么时候过期"时跑这个）：

   ```bash
   node --no-warnings scripts/accounts.mjs credits              # 全部槽位
   node --no-warnings scripts/accounts.mjs credits acct1 --refresh
   ```

   每个账号把剩余额度**按到期时间分批**输出（同一到期时刻的合成一批），一批一行，给积分数量、
   还剩几天与来源池。三种到期语义不同，别混着跟用户讲：套餐额度随周期固定到期；**加购/赠送是
   「每日 10:00(UTC+8) 刷新、领取后 N 天有效」的滚动额度**（N 取自活动接口，实测 30 天），逐笔到期
   由本地签到领取记录还原，工具没记到的那部分标"到期未定"——不要替它编一个日期；专属包用各自
   `expiresAt`。走三个**只读 GET**（用量/套餐/活动列表），不刷新令牌，所以活跃账号也能直接查；
   5 分钟内命中 `credits.json` 缓存不出网。

   - 报 `auth` = 该槽位登录态失效，额度只读不会替它续期，需在新客户端登录一次并 `save`
     （或先跑签到让令牌轮换回新鲜）。
   - 报 `enterprise` = 企业版额度在组织后台，接口只给详情页链接，别报成"额度为 0"。
   - 数字没变化多半是缓存，加 `--refresh` 再看。

7. 想要图形界面就用 account-console skill（`/account-console`），控制台里每张槽位卡片
   内嵌同款 credits 分段条，另有「会话可见性」面板与切换前后对比。

## 布局与数据目录（务必理解，否则容易误判）

插件支持两种客户端布局，按目录内容自动识别：

| 布局 | 数据目录 | 凭证真源 | 适用版本 |
| --- | --- | --- | --- |
| `v2` electron-root | `%APPDATA%\com.qodercn.app.stable` | `auth.v1.dat`（整文件即 v10 密文） | Qoder CN 0.4.3+ |
| `v1` icube | `%APPDATA%\QoderCN` | `User\globalStorage\state.vscdb` 键 `secret://aicoding.auth.userInfo` | ≤0.4.2 |

数据目录**不写死**：优先从运行中进程的 `--user-data-dir` 命令行参数解析，回退到候选
目录探测。客户端升级换目录时会自动跟随——旧版本把目录写死成 `%APPDATA%\QoderCN`，
0.4.3 升级后就读到了一个停用目录，报出来的全是过期登录态。

## 输出解读

- `当前登录`: IDE 正在使用的账号（昵称 / 脱敏邮箱或手机 / uid 掩码 / token 过期）。
  **本地凭证的 email 字段可能为空**（手机号注册时邮箱存服务端），此时以 uid + 昵称
  为准；用户报的邮箱对不上不一定是 bug，让他核对 uid。
- `布局不兼容` 标记：该槽位是旧布局快照，客户端已升级，**无法恢复**。只能在新客户端
  登录该账号后重新 `save`。切换脚本会在关闭 IDE **之前**预检并拦下，不会白关一次。
- `凭证缓存`: 该账号最近一次已知的 token 状态。**save 成功即同步刷新**（缓存只是副本，
  快照才是真源），所以「重新登录该账号 + 重新 save」之后缓存里就是有效令牌；签到时在
  缓存与快照之间**取更新的一份**，避免用已被服务端轮换掉的旧 refreshToken 误报 `permanent_auth`。
- `未拷全条目`: 这次保存因文件被占用没进快照的白名单项。恢复时对这些目录只做**合并**、
  不整目录替换，所以实时数据不会被删掉又没有备份可补。
- `上一代备份: 存在 → <身份> · 保存于…`: 覆盖式保存留下的 `.bak`（单代）。要换回来用
  `node --no-warnings scripts/accounts.mjs rollback <id> --yes`（主槽位与 `.bak` 互换，
  再执行一次即换回；只动本地快照，不碰 IDE 当前登录态）。
- `切换进行中`: `switch.lock` 有效（pid 活着且未超过 15 分钟）。期间 save/signin/remove/
  rollback/config 会被 409 拒绝，控制台写按钮置灰——这是保护，不是坏了。
- `token过期` 不代表账号失效——非活跃账号签到时会自动用刷新令牌续期；只有提示
  `permanent_auth` 才需要重新登录并 save 槽位。
- `← 当前登录` 表示该槽位就是 IDE 当前账号，无需切换。判据是**槽位快照解出的 uid**
  与实时目录一致，不再只信注册表。
- 启动参数一栏（若有）来自 `config.launchArgs`，用于平时用自定义 `--user-data-dir`
  启动 Qoder 的用户；没配就别提它。
- `管理目录: …`（「环境」块的最后一行，JSON 字段 `install.mgrDir`）= 插件**自己的**数据目录，默认
  `~/.qoder-account-manager`。它和上面的「客户端数据目录」（IDE 的登录数据）、插件安装
  目录 `~/.qoder-cn/plugins/qoder-account-manager` 是三处不同的东西：槽位快照、注册表、
  凭证缓存、签到日志、`switch.lock` 都在管理目录里。刻意与安装目录解耦，升级/卸载插件
  不会带走登录态。可用 `QODER_AM_HOME` 整体搬家，但必须**每次调用都设**（CLI 与控制台
  服务是两个进程），漏设会读到另一个空目录，看起来像"槽位莫名其妙空了"。
- 控制台服务默认在 Qoder 连续 180s 不在运行后自行退出（`config.exitAfterNoQoderSec`，
  0 = 常驻；切换进行中不会退）。用户说"网页点不动了/打不开了"，先按这条判断是不是服务
  已经按设计收了，让他重开 Qoder 再跑 `/account-console`，别当成数据丢了。

## 约束

- 本 skill 只读，不执行任何切换/签到动作；用户要求操作时转用 account-switch /
  daily-signin / account-console skill。
- 不要读取或展示 `~/.qoder-account-manager/creds/` 内的凭证文件内容，也不要直接
  dump `auth.v1.dat` 字节——用 `accounts.mjs` 的脱敏输出。
