---
description: 切换 Qoder 登录账号（保留对话历史）
argument-hint: <目标账号id>
---

执行 Qoder 账号切换。使用 account-switch skill 的流程：

1. 运行 `node --no-warnings <插件根>/scripts/accounts.mjs list` 列出槽位，确认目标 id `$ARGUMENTS` 存在且**未标记布局不兼容**（若用户未给参数，列出槽位让用户选择）。
2. **优先建议用户用 `/account-console` 打开图形控制台自己点「切换到此账号」**：切换会关闭并重启 Qoder IDE，若你正运行在该 IDE 内，执行切换会中断你自己的会话、无法汇报结果。注意本构建的斜杠菜单只暴露 skills，不暴露 `commands/`，所以引导时用 skill 名。
3. 仅当用户明确要求由你执行、且知晓会中断会话时：提醒用户先保存未存盘的文件，确认后运行 `node --no-warnings <插件根>/scripts/switch.mjs switch $ARGUMENTS`。
4. 转述结果：当前登录态已备份到哪个槽位、恢复项数、**回读验证到的落地身份**、Qoder 是否已重启。
5. 被 `已有切换在进行中` 挡住时，说明 `switch.lock` 有效：先看是不是真有切换在跑（`accounts.mjs status` 会打印「切换进行中」与目标槽位）。只有确认上一个进程已卡死才加 `--force`。槽位内容想退回上一代用 `accounts.mjs rollback <id> --yes`（与 `.bak` 互换，可再来一次换回）。

绝不要在用户未确认的情况下自动切换。

`<插件根>` = 本命令文件所在插件的根目录（commands/ 的上一级）。
