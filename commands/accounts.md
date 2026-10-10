---
description: 查看 Qoder 账号槽位与签到状态
argument-hint: ""
---

查看 Qoder 多账号状态。使用 account-status skill 的流程：

1. 运行 `node --no-warnings <插件根>/scripts/accounts.mjs status`。
2. 若槽位为空，引导用户：先在 Qoder 登录账号 A 后运行 `accounts.mjs save acct1 --name "账号A"`，再登录账号 B 运行 `accounts.mjs save acct2 --name "账号B"`。也可以直接建议用户用 `/account-console` 打开图形控制台操作。
3. 用户关心签到历史时补充运行 `node --no-warnings <插件根>/scripts/signin.mjs history 14`。
4. **用户反馈"显示的账号不是我正在用的"、或槽位出现「布局不兼容」时**，运行
   `node --no-warnings <插件根>/scripts/accounts.mjs doctor` 自检，核对生效数据目录与识别布局。
5. 用户问"切号后对话还在不在"：跑 `<插件根>/scripts/accounts.mjs sessions`（只读 main.sqlite 的计数与元信息，绝不读对话正文），切换前后各跑一次做对比。
6. 状态里出现「上一代备份」时，可用 `accounts.mjs rollback <id> --yes` 把主快照与 `.bak` 互换找回旧一代（再执行一次即换回）；出现「切换进行中」说明 `switch.lock` 生效，此时写操作会被 409 拒绝，属正常保护。
7. 用户问"还有多少 credits / 什么时候过期"：跑 `node --no-warnings <插件根>/scripts/accounts.mjs credits`（可跟槽位 id 与 `--refresh`）。它把剩余额度**按到期时间分批**——同一到期时刻的合成一批——一批一行给积分数量、还剩几天与来源额度池，末尾给可用合计与最近到期。注意三种到期语义不同：套餐随周期固定，**加购/赠送是「每日 10:00(UTC+8) 刷新、领取后 N 天有效」的滚动额度**（逐笔到期按本地领取记录还原，工具没记到的那部分会标"到期未定"，别替它编日期），专属包各自带到期时刻。只读三个 GET，不刷新令牌；5 分钟内走 `credits.json` 缓存，数字没变就加 `--refresh` 再看。报 `auth` 说明该槽位登录态已失效（需在新客户端登录并 `save`），报 `enterprise` 说明额度归组织后台、接口只给详情页链接，别当成"额度 0"。

`<插件根>` = 本命令文件所在插件的根目录（commands/ 的上一级）。
