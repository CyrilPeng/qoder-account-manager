---
name: account-switch
version: 2.0.0
description: Switch Qoder CN IDE login accounts via local snapshots while preserving chat history and workspaces.
description_zh: 通过本地登录态快照切换 Qoder CN IDE 账号，对话历史与工作区完整保留。
user-invocable: true
argument-hint: <目标账号id>
---

# Qoder 账号切换

在多个已保存的 Qoder CN IDE 账号之间切换登录态。原理：登录态相关文件按白名单做快照
交换。**对话历史存于 `main.sqlite` / `chat-session-*.sqlite`，属禁交换硬红线，切换后
完整保留**（v1 旧布局则存于 workspaceStorage，同样不在白名单内）。

脚本目录 = 本 SKILL.md 所在插件根目录下的 `scripts/`。

## ⚠ 首要约束：切换会重启 IDE，可能中断你自己

切换流程包含「关闭 Qoder → 交换文件 → 重启 Qoder」。**若你（agent）正运行在这个
Qoder 里，执行切换会终止你自己的会话**，后续步骤无法完成、结果也无法汇报。

因此：

- **优先引导用户用图形控制台自己点**（account-console skill / `/account-console`）。
  控制台会显示切换进度；即便服务随 Qoder 退出被回收也无妨，数据都在磁盘上，重启
  Qoder 后重新 `/account-console` 即可。
- 只有在用户明确要求、且知晓会中断会话时，才由 agent 直接跑 CLI。
- 绝不要在用户没确认的情况下自动切换。

## 流程

1. 列出槽位并确认目标存在、布局兼容：

   ```bash
   node --no-warnings scripts/accounts.mjs list
   ```

   若目标标记为「布局不兼容」，说明它是客户端升级前的旧快照，**无法恢复**——
   引导用户在新客户端登录该账号后重新 `save`，不要尝试切换。

2. 提醒用户：切换会**关闭并重启 Qoder IDE**，未保存的编辑器内容会丢失，请先存盘。
   用户确认后执行：

   ```bash
   node --no-warnings scripts/switch.mjs switch <目标id>
   ```

   脚本自动完成：预检（槽位存在 + 布局兼容 + 快照完整 + **快照必须能解密出登录态**，
   **全部在关闭 IDE 之前**）→ 抢切换锁 → 探测当前登录（目标就是当前账号则直接 noop，
   判据用快照解出的 uid，不信注册表）→ 关闭 Qoder → 备份当前登录态到其槽位（防丢号）→
   恢复目标快照（`auth.v1.dat` 最先、同卷 rename 原子落地）→ **回读实时目录验证落地身份**
   → 重启 Qoder。exe 路径动态解析（运行中进程 > 版本扫描 > registry 兜底），
   客户端升级后不会失效。

   恢复后脚本会把写回去的登录态**重新解密一遍核对 uid**：不一致就报 `identity-mismatch`
   并**停止重启**，不会留给你一个"以为切过去了其实没切"的 IDE。

3. 转述结果：当前登录态备份到了哪个槽位、恢复项数、回读验证到的身份、Qoder 是否已重启。

## 切换互斥与快照回退

- 同一时刻只允许一个切换：`switch.mjs` 启动即写 `~/.qoder-account-manager/switch.lock`，
  退出时清除；陈旧判定靠「pid 是否存活 + 是否超过 15 分钟」，所以进程被 Job Object 连带
  回收也不会把锁永久卡死。被挡住时报 `已有切换在进行中`；**只有确认上一个切换进程确实已卡死**
  才加 `--force`（它会顶掉旧锁并如实打印顶了谁）。控制台在此期间对
  save/signin/remove/rollback/config 一律返回 409，`console.mjs --stop` 也会拒绝停止
  （`taskkill /T` 会把正在交换文件的切换子进程一起杀）。
- 覆盖保存点错了想找回旧快照：
  `node --no-warnings scripts/accounts.mjs rollback <id> --yes` —— 主槽位与 `.bak`
  （连同各自 meta）**互换**，只动本地快照、不碰实时登录态，因此 Qoder 运行中也能执行；
  互换是对称的，再跑一次就换回来。回退后同样校验新主快照可解密，解不开会自动换回原状。
- 主快照缺失但 `.bak` 还在时，`switch` 不再只说"请人工确认"，而是直接指向 `rollback`。
- id 校验是硬性的：`switch`/`remove`/`rollback` 的 id 只接受 `[A-Za-z0-9_-]{1,64}`，
  因为 id 会拼进快照目录路径参与删除与覆盖，`../` 之类必须挡在门口。

## 首次使用（保存账号槽位）

用户当前登录的账号必须先保存成槽位才能参与切换：

```bash
node --no-warnings scripts/accounts.mjs save acct1 --name "主账号"
```

第二个账号：让用户在 Qoder 里退出并登录另一账号，再 `save acct2 --name "小号"`。

**默认档位下运行中保存是完全可靠的**：只碰 4 个小身份文件，实测 0 告警。
若手动打开 `browser` 档，Chromium 独占 `Network/Cookies`（连共享读都拒绝，字节级
read/write 回退也失败），该项会被跳过并如实告警；身份靠 `auth.v1.dat`，缺 cookie
不影响切号后登录，且恢复时对不完整目录降级为**合并**而非整目录替换，避免把实时
cookie 删掉又没有备份可补。要 100% 完整快照就 `save <id> --kill`（会关闭 IDE，
同样注意上面的自我中断约束）。

## 快照白名单（v2 布局，分档可配）

- **core（不可关，默认开）**：`auth.v1.dat`、`Local State`、`auth.machine-id`、
  `auth-profile-overlays.v1.dat`
- **browser（默认关）**：`Preferences`、`first-launch-onboarding.v1.json`、
  `Network`、`Local Storage/leveldb`、`Session Storage`
- **appdata（默认关）**：`qoder-data.v1.json`、`qoder-data.v1.ext.json`、
  `Partitions`、`app-plugin-data`

⚠ `Local State` 必须与 `auth.v1.dat` **同进同出**：实测不同数据目录的
`os_crypt.encrypted_key` 不相同，只换凭证不换密钥会导致恢复后解不开。

档位可在控制台「快照策略」里开关，或直接改 `~/.qoder-account-manager/config.json`。

## 安全约束

- 切换前脚本总会先备份当前登录态；备份失败会中止且不碰目标快照——如实转述错误。
- 保存/恢复失败会自动清理半成品槽位并把上一代 `.bak`（连同 `.meta.json.bak`）**还原回主
  槽位**，不会留下"看着存在却不可用"的槽位，也不会因为一次失败的重新保存就让原槽位从
  列表里消失。判据是「轮转前主槽位存在」——只要这次确实把上一代挪进了 `.bak` 就必须还回去。
- 快照里没拷全的条目记录在 meta 的 `incomplete` 里（白名单项粒度）。恢复时对这些目录只做
  **合并**而不是整目录替换，避免"把实时数据删掉又没有备份可补"。空目录同样不得充当备份去
  覆盖实时目录。
- 不要手工复制/删除客户端数据目录下的文件来"修复"问题；一律走脚本。
- 凭证与 token 不出现在输出里；不要读取或展示 `~/.qoder-account-manager/creds/`
  内容，也不要 dump `auth.v1.dat` 字节。
- 默认档位下**对话列表是所有账号共用的**（`main.sqlite` 不交换）。这是"切号续聊"的
  实现方式，也意味着切到账号 B 后仍能看到账号 A 的对话。用户在意隔离时要如实说明，
  并告知可打开 `browser` 档换取隔离（代价是可能看不到原对话）。

## 切号后能否继续之前的对话（实测依据）

这是本插件的核心诉求，结论建立在实测而非推测上：

- `chat_sessions` 共 33 列，**无任何账号语义列**；会话列表 SQL 是
  `SELECT session_id, updated_at FROM chat_sessions`（连 WHERE 都没有），其余查询只按
  `workspace_id` / `session_id` / `archived` / `deleted_at` 过滤。
- `workspaces` 表也无账号列，`workspace_id` 是随机 UUIDv4（非账号派生），按
  `root_paths`（文件夹路径）匹配。
- leveldb / Session Storage / Partitions 中搜不到任何账号作用域串。
- 客户端确有账号作用域 `qoder:prod:cn:<sha256>`（`agentAccountScope`），但只作用于
  **agentProfiles / squads / agentRuntimes**；`switchAccountIfNeeded` 也只重置模型目录
  缓存，不碰会话表。

⟹ **本地库层面不存在按账号隔离会话的机制**，因此只要 `main.sqlite` 与 leveldb 视图
状态都不参与交换，切号后原对话应照常可见可续。

**这条已经端到端验证过一次**（2026-10-09 08:06，acct2 → acct1）：`switch.log` 里
「回读验证 ✓ 实时目录登录态 = 目标槽位身份（uid 与目标一致）」，切换前后 `main.sqlite`
会话数一条没少（15 条 / 307 条消息），重启后 IDE 自己的会话列表里**切换前创建的对话仍在列**，
连当时正在进行的那条会话都跨过 IDE 重启接着跑下去了。所以可以按"切号后能继续聊"来回答用户。

不过覆盖范围只有 v2 布局 + 默认档位的一次切换：v1 旧布局、开了 `browser` 档、以及多工作区
跨账号可见性都还没实测。用户若反馈"看不到旧对话"，让他这样取证再定位：

```bash
node --no-warnings scripts/accounts.mjs sessions   # 切换前，记下会话总数
# …在控制台完成切换…
node --no-warnings scripts/accounts.mjs sessions   # 切换后对比
```

计数不变 = 数据层完好，问题在视图层（尚未识别的渲染状态/作用域过滤）——把 `sessions` 输出
拿来继续定位，不要盲目改档位或手工动客户端数据目录里的文件。
