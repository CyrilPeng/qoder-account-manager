# 开发与发版

## 本地开发

- **改前端不用重启**：`assets/console.html` 每次请求现读，浏览器刷新即生效；改 `scripts/*.mjs`
  则要 `console.mjs --restart`（服务进程已把代码载入内存）。
- **沙箱演练**：危险路径（`remove`、`rollback`、保存失败的还原分支）请用独立数据目录试，
  不碰真槽位：

  ```bash
  QODER_AM_HOME=$(mktemp -d) node --no-warnings scripts/accounts.mjs list
  ```

- **看门狗逻辑**：`QAM_QODER_PROC_NAME` 能把“IDE 是否在运行”的探针指向任意进程名，
  `QAM_PORT`/`QAM_TOKEN` 可固定端口与 token，便于脚本化测试。
- **自测入口**：`accounts.mjs status --json` 的 `QAM_JSON:` 一行就是控制台 `/api/status`
  的同一份数据（两者共用 `status.mjs` 的 `collectStatus()`），页面显示异常时先用 CLI 对照。

## 测试

```bash
node --test "tests/*.test.mjs"
```

- `tests/credits.test.mjs`：到期分档、分批合并、滚动账本 FIFO、“到期未知”兜底、
  三种额度语义的归一、脱敏。
- `tests/snapshot.test.mjs`：禁交换清单 29 条、三档不重叠、任意档位组合不混入禁交换项、
  槽位 id 校验。
- `tests/console.test.mjs`：内联脚本可解析、零外部依赖、token 不留在历史、悬停/聚焦提示、
  用户文本经 `esc()`。
- `tests/server.test.mjs`：起一个临时服务，验证 403/Host 校验/安全响应头、token 换发
  HttpOnly cookie、切号锁下额度只回缓存、停机接口自我退出并清理 `server.json`。
- `tests/docs.test.mjs`：README 行数预算、docs 内链与标题锚点、README 覆盖全部文档入口。
- `tests/privacy.test.mjs`：扫描仓库文本，禁止本机用户名、home 路径、完整邮箱、手机号与
  `dt-/drt-/jrt-` 令牌明文进入版本库。

测试使用临时 `QODER_AM_HOME` 与 `QODER_DATA_DIR`，不碰真实槽位；新增逻辑（尤其是到期数学与
脱敏）应先补测试再改实现。

## 同步到生效副本

仓库、IDE 加载的那份（注册表 `installPath`）、以及可能残留的手工放置副本，只有第二处决定实际
跑的是什么。从仓库同步过去，目标路径现取：

```bash
TARGET=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.USERPROFILE+"/.qoder-cn/plugins/installed_plugins_v2.json","utf8")).plugins["qoder-account-manager@local"][0].installPath)')
cp -r .qoder-plugin assets commands scripts skills docs tests README.md CHANGELOG.md LICENSE "$TARGET/" && diff -r . "$TARGET" --exclude=.git
```

改完 `scripts/*.mjs` 要 `console.mjs --restart` 才生效；改 `skills/`、`commands/`、
`.qoder-plugin/` 建议重启 IDE 重新扫描。数据都在 `~/.qoder-account-manager`，同步代码不影响槽位。

## 发版

版本号只有三处必须对齐：`.qoder-plugin/plugin.json` 的 `version`、`CHANGELOG.md` 的版本段
标题、git tag。发版前先把「未发布」改写成 `## vX.Y.Z` 并同步清单版本，提交后运行：

```bash
node scripts/release.mjs            # 检查 + 构建 ../qoder-account-manager-vX.Y.Z.zip
node scripts/release.mjs --publish  # 额外打 tag、推送、创建 Release 并核对 digest
```

脚本会检查（任一失败即中止）：

1. 清单版本格式，以及工作区、`HEAD` 清单、CHANGELOG 版本段三者一致；
2. tag 若已存在必须指向 `HEAD`（防止改了代码没升版本就重发）；
3. 离线校验器（`validate_qoder_plugin.py`，可用 `QAM_VALIDATOR` 指定；发布时必须通过）；
4. `node --test "tests/*.test.mjs"`；
5. 发布包里没有 `creds/`、`snapshots/`、`*.sqlite`、日志、临时文件；
6. HEAD 整棵树里没有本机用户名、home 路径、完整邮箱、手机号、`dt-/drt-/jrt-` 令牌明文；
7. 打包后打印 sha256；`--publish` 会推送、建 Release，并回读 GitHub 的 asset digest 与本地
   sha256 比对。

`--dry-run` 只跑检查、不写 zip。`--publish` 支持 `--title=…` 与 `--branch=main`。

手工兜底（脚本不可用时）：

```bash
git tag -a "vX.Y.Z" -m "vX.Y.Z"
git archive --format=zip --prefix=qoder-account-manager/ \
  -o "../qoder-account-manager-vX.Y.Z.zip" "vX.Y.Z"
git push origin main "vX.Y.Z"
gh release create "vX.Y.Z" "../qoder-account-manager-vX.Y.Z.zip" --title "vX.Y.Z" --notes-file <版本段 md>
```

> GitHub 自动生成的 `Source code (zip/tar.gz)` 同样不含 `.git`，随手用它安装也行；挂上去的
> zip 只是把目录名固定成 `qoder-account-manager/`，解压层级更可预期。
> tag 只指向“清单版本 = tag 版本”的 commit；注册表里的 `version` 只在重装时刷新，两套号
> 一错位就很难对齐。

## 变更记录

影响用户行为的改动先写进 `CHANGELOG.md` 的「未发布」，发版时改写成版本段并同步清单
`version`；分组与写法见文件开头。
