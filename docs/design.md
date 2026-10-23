# 原理与取证

这一页记录“为什么这样做”，包括从客户端与接口里核实到的契约。结论对应 Qoder CN 0.4.3；
客户端升级后可用 `accounts.mjs sessions`、`doctor` 与本文列出的端点重新核对。

## 登录态快照白名单（v2，分档可配）

- `core`（不可关，默认开）：`auth.v1.dat`、`Local State`、`auth.machine-id`、
  `auth-profile-overlays.v1.dat`
- `browser`（**默认关**）：`Preferences`、`first-launch-onboarding.v1.json`、
  `Network`、`Local Storage/leveldb`、`Session Storage`
- `appdata`（默认关）：`qoder-data.v1.json`、`qoder-data.v1.ext.json`、
  `Partitions`、`app-plugin-data`
- `Local State` 必须与 `auth.v1.dat` **同进同出**：实测不同数据目录的
  `os_crypt.encrypted_key` **不相同**，只换凭证不换密钥会导致恢复后解不开。
- `browser` 档默认关闭是**为了实现“切号后继续之前的对话”**，见下条。

## 快照写入的容错与回退

- 写入顺序：预检（当前目录必需文件齐全）→ 旧快照连同 meta 一起挪成 `.bak` → 逐项容错拷贝
  → 校验「必需文件在 + 真能解密出登录态」→ 写令牌缓存 → 写 meta。
- **校验不通过就还原**：删掉半成品槽位，把 `.bak` 连同 `.meta.json.bak` 一起换回主槽位，
  不会出现「重新保存失败 → 原槽位从列表里消失」；新增槽位失败则整体清干净，不留半成品。
- `.bak` 是**可操作的**回退点，不只是个提示：控制台槽位卡片有「回退到上一代」按钮，
  CLI 是 `accounts.mjs rollback <id> --yes`，互换对称，再执行一次就换回来。
- `save` 成功后同步刷新 `creds/<id>.json`：令牌缓存只是副本，快照才是真源；不刷新就会
  留下已被服务端轮换作废的旧 refreshToken，让签到误报 `permanent_auth`。

## 切换有回读验证

恢复完不会只看“拷了几个文件”，而是把实时目录的登录态重新解一遍，确认 uid 与目标一致才继续
重启；不一致直接报 `identity-mismatch` 并停止，不给你一个「以为切过去了其实没切」的 IDE。
验证通过后顺带把实时凭证写回该槽位的缓存。

## 对话保留（已端到端实测）

- **实测结论**：从 `acct2` 切到 `acct1`，`switch.log` 记录「回读验证 ✓ 实时目录登录态与目标
  uid 一致」；切换前后 `main.sqlite` 会话一条没少（15 条 / 307 条消息），重启后 IDE 的会话
  列表里切换前创建的对话仍在列，正在进行的会话也跨过了这次 IDE 重启。
- 聊天记录在 `main.sqlite`（51MB+）与 `chat-session-*.sqlite`，属**禁交换硬红线**
  （29 条，`snapshotWhitelist` 与 `restoreSnapshot` 双重过滤，任何配置都绕不过）。
- 更关键的是 `Local Storage/leveldb` 里存着 `workspaceSessions` / `workspaceLayout` /
  `workspace` 等**渲染层视图状态**。它们不是身份，但随账号一起交换就会把目标账号
  上次的视图状态盖上来，表现为“切号后原对话不见了”——所以 `browser` 档默认关闭。
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

## 凭证解密链

两种布局共用（Electron safeStorage = Chromium os_crypt）：

```text
Local State → os_crypt.encrypted_key → base64 → DPAPI → AES-256-GCM 32B 密钥
→ 'v10' + nonce(12) + ct + tag(16)
```

v2 明文结构 `{schemaVersion:1, token(dt-), refreshToken(drt-), expiresAt,
refreshTokenExpiresAt, user:{id,name,email,phone,avatarUrl}}`。实测 `app_bound=false`，
故也能**反向加密写回**（续期令牌持久化用）。

## 无原生多账号

客户端只存单账号，`auth-profile-overlays.v1.dat` 仅头像/昵称装饰层（≤16 条）；app.asar 内的
`switchAccountIfNeeded` 只是内部缓存失效函数。因此只能走快照交换。

## 签到 API

`openapi.qoder.com.cn` sash 活动体系：

- `GET /sash/api/v1/me/campaigns` 全量列表；
- `POST .../campaigns/{id}/claim` 幂等领取（Content-Length: 0）；
- 必带 `Cosy-ClientType: 10`（缺失时返回空列表）。

零 CLAIMABLE 时先查当日 CLAIMED grant 定真话，再盲发反学/硬编码活动 id 兜底。

## Credits 与到期

`app.asar` 里 `account.getQuotaUsage` / `account.getUserPlan` 两个调用点及其响应校验函数给出了
确切契约：

- `GET /sash/api/v2/me/usage` 返回 `{displayMode, qoderUsage}`。`qoderUsage` 里
  `userQuota` / `addOnQuota` / `dedicatedResourcePackages[]` / `orgResourcePackage` 各是一段
  额度池，每段 `total/used/remaining/percentage/unit`；专属包还带自己的 `expiresAt`、
  `available`、`status`（如 `QUOTA_DETAIL_STATUS_EXHAUSTED`）与 `displayLabels`（中文标题
  就在这里，取 `dimension==='title'` 的 `valueI18n['zh-CN']`）。顶层 `expiresAt` 与
  `GET /api/v2/user/plan` 的 `end_date` 一起决定额度周期。字段既可能是 camel 也可能是 snake
  （客户端校验就是双取，本工具照做）。
- `displayMode==='enterprise'` 时只有 `enterpriseUsage{openMode,detailUrl}`，本地拿不到数字，
  于是页面与 CLI 都显示“额度在组织后台”并给链接，而不是硬凑一个 0。
- 两个端点都是只读 GET，不触发令牌轮换，所以活跃账号同样可以直接查。

**三种到期语义不同**（这是实测出来的，别想当然）：

- `userQuota` 随套餐周期固定到期；
- `addOnQuota` 是**每日 10:00(UTC+8) 刷新、领取后 N 天有效**的滚动额度，
  `/sash/api/v1/me/campaigns` 的 `benefit.validity = {mode:'RELATIVE_DAYS', days:30}` 与活动
  文案「每日 10:00（UTC+8）刷新，领取后 30 天有效」就是依据——它**不能**套用套餐的
  `expiresAt`；
- 专属资源包各自带 `expiresAt`。

由于用量接口只给 `addOnQuota` 的合计余额、不给逐笔到期，逐笔到期由 `loadClaimLedger` 从签到
日志还原（每次 `success`/`already` 且带 `reward` 的记录算一笔，到期 = 领取时刻 + N 天），
`expiryBatches` 按先到期先扣把余额分到各笔，拆不掉的归入“到期未知”批次——在 IDE 里领走的
那部分工具记不到，宁标未知也不编一个日期。

**展示层再按到期时刻把各池的剩余额度合并成“批次”**：同一 `expiresAt` 的合成一批，一批一条上
的一格；`available===false` 或已过期但仍有余额的额度不进条，单独在合计里点名
（`expiredTotal` / `blockedRemaining`），避免“看着有、实际用不了”。分批在数据层算，
CLI 与页面拿到的是同一份 `batches`，不会两处各算一遍。

## 令牌续期

`POST /api/v1/deviceToken/refresh`（drt-）/ `/api/v1/jobToken/refresh`（jrt-）。刷新令牌一次性
轮换，成功后新凭证**双写**到 `creds/` 缓存与该槽位快照的 `auth.v1.dat`，防旧令牌失效锁死
账号。

## 轮换安全策略

**当前活跃账号只用不刷**——在它背后刷新会作废客户端持有的 refreshToken，等于把正在用的账号
踢下线；token 过期时返回 `live_expired` 让用户开一次 IDE 自行续期。

## 风控内建

claim 间隔 1~3s 随机抖动；额度多账号之间 300~700ms 间隔；token 全程不输出到终端/日志/HTTP
响应。
