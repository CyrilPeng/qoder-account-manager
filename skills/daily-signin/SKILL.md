---
name: daily-signin
version: 2.0.0
description: Run Qoder daily sign-in (check-in + login reward campaigns) for all saved accounts without switching.
description_zh: 为所有已保存的 Qoder 账号执行每日签到（签到 + 登录奖励双活动），无需切换账号。
user-invocable: true
argument-hint: [账号id...]
---

# Qoder 每日签到

为已保存槽位的账号领取 Qoder 每日奖励（双活动：每日签到 + 登录奖励，接口全量列表
自然覆盖）。**无需切换账号**：当前 IDE 登录态直接用它自己的令牌；其余账号在「本地凭证
缓存」与「槽位快照解密」之间**取更新的那一份**（缓存可能是已被服务端轮换作废的旧令牌，
快照才是客户端的真源；`save` 成功时会同步刷新缓存）。

脚本目录 = 本 SKILL.md 所在插件根目录下的 `scripts/`。

## 流程

1. 执行签到（不传 id = 全部账号）：

   ```bash
   node --no-warnings scripts/signin.mjs signin
   ```

   或只签指定账号：`node --no-warnings scripts/signin.mjs signin acct1 acct2`

2. 转述每个账号的结果：`success`（领取成功，含 +credits 数额）/ `already`（今日已领）/
   `fail`（含原因）。末行 `EVENTS_JSON:` 与 `QAM_JSON:` 是结构化结果，转述时用人类
   可读摘要即可，不要把 JSON 原样贴给用户。

   想确认奖励真的到账，签完跑一次额度（只读、不动令牌，`--refresh` 跳过 5 分钟缓存）：
   `node --no-warnings scripts/accounts.mjs credits --refresh`。控制台的「刷新额度」在签到
   成功后也会自动触发一次。

3. 失败处理指引：
   - `permanent_auth` / 「需重新登录」：该账号刷新令牌已失效。让用户在 Qoder 登录
     该账号后重新执行 `accounts.mjs save <id>` 更新快照。
   - `live_expired`：该账号正被 IDE 使用且 access token 已过期。**按设计不代它续期**
     （见下方轮换策略），让用户打开一次 Qoder 由客户端自行刷新，再重新签到。
   - `empty_campaigns`：活动未开始或接口变更，稍后重试；持续出现则告知用户活动
     档期可能结束。
   - `transient`（网络/5xx）：直接重试一次即可。
   - 盲发兜底阶段遇到 401 现在会被单独定性成 `permanent_auth`（旧实现把它混进"失败"里，
     看起来像"活动没开始"，实际是凭证已死、需要重新登录）。
   - 控制台里点「签到」返回 **409**：说明有切换正在跑（`switch.lock` 有效），等它结束再签。
     切换过程中交换文件的同时去刷令牌会读到半份状态，这是刻意拦的。

4. 查询历史：

   ```bash
   node --no-warnings scripts/signin.mjs history 14
   ```

## 令牌轮换安全策略（勿绕过）

refreshToken 是**一次性轮换**的：刷新成功后旧的那个立刻作废。由此产生两条硬规则：

- **当前活跃账号（uid == IDE 登录）只用不刷。** 若在它背后刷新，客户端
  `auth.v1.dat` 里存的 refreshToken 会立刻失效，等于把用户正在用的账号踢下线。
  access token 过期时返回 `live_expired` 而不是偷偷续期。
- **非活跃账号刷新后必须双写**：新令牌除写入 `creds/<id>.json` 缓存外，还要回写该
  槽位快照的 `auth.v1.dat`（用该快照自带的 `Local State` 密钥重新 AES-GCM 加密）。
  否则日后切过去，恢复出来的是已作废的 refreshToken —— 账号被锁死，只能重新登录。
  回写失败会如实告警（`writebackWarn`），不要静默吞掉。

## 风控内建（勿绕过）

- claim 间隔 1~3s 随机抖动已内置；不要并行发起多个签到进程。
- claim 接口幂等，重复调用无副作用；但不要循环轰炸重试。
- 必带 `Cosy-ClientType: 10`，缺失时 sash 返回空 campaigns（最隐蔽的坑）。
- token/refreshToken 全程不落终端输出；不要读取或展示 creds 缓存文件内容。

## 定时自动签到

用户要求"每天自动签到"时，用 Windows 计划任务（不要引入其他调度器）：

```powershell
schtasks /Create /TN "QoderDailySignin" /SC DAILY /ST 10:15 /TR "node --no-warnings '<插件根>\scripts\signin.mjs' signin"
```

10:15 单次调度同时覆盖「0 点签到」与「10:00 登录奖励」双活动（上游实测结论）。

⚠ 计划任务在 IDE 关闭时也会跑，此时无「活跃账号」，所有槽位都按非活跃路径处理
（可刷新 + 回写快照），这是预期行为。
