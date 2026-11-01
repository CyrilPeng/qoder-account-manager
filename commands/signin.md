---
description: Qoder 每日签到（全部已保存账号，无需切换）
argument-hint: "[账号id...]"
---

执行 Qoder 每日签到。使用 daily-signin skill 的流程：

1. 运行 `node --no-warnings <插件根>/scripts/signin.mjs signin $ARGUMENTS`（参数为空 = 全部账号）。
2. 逐账号转述结果：success（+credits 数额）/ already（今日已领）/ fail（原因与处理建议）。
3. 失败处理（按 `fail_kind` 判读）：`permanent_auth` → 让用户重新登录该账号并 `accounts.mjs save <id>`；`live_expired` → 该账号正被 IDE 使用且 token 过期，按设计不代它刷新（会作废客户端持有的刷新令牌），让用户开一次 Qoder 自行续期后重试；`campaign_not_live` → 今日活动行还没发布（窗口 10:00 起、服务端发布晚于窗口起点，脚本已内置最多 180s 复查），窗口到次日 09:59，告诉用户稍后重跑，不要说成接口变更；`claim_rejected` → 原样转述服务端 errorCode；`empty_campaigns` → 列表整个空了，稍后重试，持续出现再报活动档期可能结束；`transient` → 重试一次。
4. 不要输出 EVENTS_JSON / QAM_JSON 原始内容，不要展示任何 token。

`<插件根>` = 本命令文件所在插件的根目录（commands/ 的上一级）。
