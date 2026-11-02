# dsh-life-toolkit

> ### 这是什么
> **让 Agent 记得「日子」**：把历史会话原文切成块建索引，需要时按需召回。
>
> ### 它解决什么
> 工作记忆记的是"台账"（这件事做到哪一步），人生记忆记的是"日子"（三个月前那次为什么那么决定）。后者更需要原文而不是摘要 —— 摘要会丢语气、丢上下文、丢当时的理由。这里给的是：`life.db` 的结构 + 增量索引器 + 召回插件 + **一份假语料夹具**，所以外人手上没有真实会话也能把整条链跑通。
>
> ### 一条命令跑起来
> ```powershell
> npm i -g @kira905/dsh-life-toolkit
> dsh-life-init           # 建库（默认 <DSH_HOME>/memory-life/life.db）
> dsh-life-index --apply  # 增量索引
> dsh-life-recall "那次为什么要换方案"
> ```
>
> ### 先看它长什么样（真实输出）
> ```text
> usage: node cli/life-db-init.mjs [--home <DSH 根>] [--db <库文件>] [--json] [--help]
>   --home <目录>    DSH 数据根（默认 $DSH_HOME，再默认 ~/.dsh）
>   --db <文件>      库文件（默认 <home>/memory-life/life.db）
>   --json           机器可读输出
>   --help           只看这个帮助；不读库、不建库、不写任何文件
> ```
>
> 🔴 **只开源代码与 schema**：`life.db` 与任何真实会话原文永不进仓。

---

> **人生记忆：把历史会话原文变成"查得到、捡得回"的旧原话。**
> 工作记忆（`memory.db`）记的是**结论**；这里记的是**日子** —— 你在某天某轮里，具体是怎么说的。

三个 CLI + 一个插件 + 一份假语料：

| 命令 | 干什么 |
|---|---|
| `dsh-life-init` | 建 / 升级人生记忆库（`life.db`，SQLite + FTS5） |
| `dsh-life-index` | 扫会话日志（`.jsonl` / `.jsonl.zstd`，多世代）→ 切块 → 建索引（**默认 dry-run**，`--apply` 才写） |
| `dsh-life-recall` | 按一句话，从旧原话里捞回几段（带时间、谁说的、上下文） |
| 插件 `plugin/index.js` | 每轮 pre-step 自动捡 1~2 段原话注入；没命中就不注入；fail-open |

一次全链跑通（干净目录，零真实数据）：

```bash
export DSH_HOME=/tmp/fresh-home          # 一个全新的空目录
node cli/life-db-init.mjs                # 建库
node cli/life-index.mjs --apply --root ./fixtures/build/sessions   # 建索引
node cli/life-recall.mjs "灯塔用暖黄色"    # 召回 → 打印命中的原话
```

## 装完自检（三条只读验法）

`<profile>` 换成你实际用的 profile（默认 `web`），`<数据根>` 换成你的 DSH 数据根（默认 `~/.dsh`）。

```powershell
# ① 组合树里有没有它（只读、约 0.6 秒、不启服务）
dsh --profile <profile> --dump-config | Select-String "dsh-life-toolkit"
# 期望：insert 层出现一行 "- id: kira905-life-memory"；且该 id 只出现一次

# ② 组合列表里有没有它（只读）
Get-Content <数据根>/profiles/<profile>/package.json | Select-String "@kira905/dsh-life-toolkit"
# 期望：dependencies 与 dsh.profile.bundles 两处都有

# ③ 库建出来没有（只读查询，不建库）
node cli/life-recall.mjs --help
# 期望：打印用法、退出码 0、**不会**创建任何文件（--help 一律不动作）
```

> 探针只做存在性检查与只读查询。真要验"能不能想起一句旧话"，
> 请跑 `node tools/verify-clean-home.mjs`（见下「怎么复现」）。

---

## 一、里面有什么

| 路径 | 是什么 |
|---|---|
| [`lib/schema.mjs`](./lib/schema.mjs) | `life.db` 的结构：`sessions` / `chunks` / `chunks_fts`(FTS5 trigram) / `meta`，建库、版本闸、迁移入口 |
| [`lib/session-log.mjs`](./lib/session-log.mjs) | 会话日志读取层：文件名世代判据、**多帧 zstd 拆帧**、撕裂帧检测、记录 → 「轮」 |
| [`lib/chunker.mjs`](./lib/chunker.mjs) | 文本分块（按字符、优先按行、代理对不切半） |
| [`lib/store.mjs`](./lib/store.mjs) | 索引写入：增量判据、**双端收缩**保住块 id、坏块计数上门 |
| [`lib/recall-core.mjs`](./lib/recall-core.mjs) | 召回：查询表达式（短语 / 4 字窗口 OR）、命中过滤、去重、注入渲染、预算闸 |
| [`lib/defaults.mjs`](./lib/defaults.mjs) | 所有可调数值集中一处（块大小 / topK / 预算 / 时区偏移） |
| [`cli/`](./cli) | 三个命令（`--help` 一律不动作；未知参数退出码 2） |
| [`plugin/index.js`](./plugin/index.js) | DSH 插件：`agent/pre-step` 注入一段「旧会话片段」，fail-open |
| [`fixtures/`](./fixtures) | 手写的假语料（3 个会话）+ 生成器：明文 / 多帧 zstd / 含坏块三种形态 |
| [`test/`](./test) | 53 项回归（零依赖 runner） |
| [`tools/verify-clean-home.mjs`](./tools/verify-clean-home.mjs) | **灵魂判据**取证脚本：空 home 里走完整链，并证明召回结果指得回 fixture 原话 |

## 二、`life.db` 长什么样

```sql
sessions(id, source, workspace, dir, file, file_kind, bytes, mtime_ms,
         started_ms, ended_ms, turns, chunk_count, chars, indexed_ms, note)
chunks  (id, session_id, turn_no, ts, role, kind, ord, text, chars, created_ms)
chunks_fts(text)  -- FTS5, tokenize='trigram'
meta(key, value)  -- schema_version 等
```

- **一行 `chunks` = 一段原话**：`role` 是 `user`/`assistant`，`kind` 是 `text`（说的）/ `reasoning`（想的），`ord` 是会话内递增序号。
- **`chunks_fts.rowid == chunks.id`**：没有触发器，插入/改写/删除时由代码同步维护。索引表与块表**行数必须相等**，`life-index` 每次都会核一遍并提示。
- **`tokenize='trigram'`**：中文没有空格，`unicode61` 会把整句当一个词。trigram 按三字窗口建索引，中文短语（≥3 字）能直接命中；代价是索引体积约为正文的 2~3 倍。
- **`sessions.note`**：坏块（撕裂帧 / 坏行 / 坏帧）的记账位。`NULL` = 这份日志干净可解。

迁移：`lib/schema.mjs` 的 `SCHEMA_VERSION` + `MIGRATIONS`。**库比代码新时拒绝写入**（`SCHEMA_TOO_NEW`），不让旧代码按旧列去写新库。

## 三、索引器：读什么、丢什么、怎么增量

**读**：会话目录里的 `.jsonl` / `.jsonl.zstd`（`session.jsonl`、`session.vN.jsonl.zstd` 任意世代都认）。

**只留「人话」**：

| 收 | 不收 |
|---|---|
| 真人 `user/message` 的正文 | 注入段（`data.source.kind` ∈ 时间上下文 / 技能目录 / 运行时快照 / 记忆召回 / 工具任务 / 坑提醒 / 注入指令 …） |
| `assistant/message` 的正文 | 工具调用与工具输出（`tool/call`、`tool/result`） |
| `assistant/message` 的 `reasoning`（当时的想法） | 空消息、非消息事件 |

> 注入段那张表是**封闭清单**（`INJECTION_SOURCE_KINDS`）。将来出现新的注入 kind，就往里加一条 —— 判断方向别反过来。

**增量（两层）**：

1. `sessions.mtime_ms + bytes` 没变 ⇒ **整份不解压**，直接跳过。
2. 变了就重算，但块 id 尽量不动：**双端收缩** —— 先比开头能对上多少块，再从末尾往回比；中间对不上的按位置改写，多的删、新的插。
   会话日志是追加型文件，所以"纯追加"= 前缀全 keep + 尾部少量 ins；"尾部补全一段" = 前缀 keep + 中间少量 upd。
   ⇒ **块 id 稳定**，任何引用过某块的东西（命中留痕、你手抄的摘录、将来接上的向量表）不会变成悬空 id。

**坏块（不许静默跳过）**：

| 形态 | 处理 | 上报 |
|---|---|---|
| 撕裂帧（进程被杀 / 正在写） | 该帧整帧丢弃，**绝不猜长度补齐** | `torn ≥ 1` + 偏移写进 `sessions.note` |
| 坏帧（结构对、解压失败） | 逐帧计数，其余帧照解 | `badFrames` |
| 坏 JSON 行 | 跳过该行 | `badLines` |

## 四、召回：注入格式、预算、降级

注入段（每轮最多 1~2 段、≤320 字）：

```
[人生记忆·旧会话片段] 下面是从我以前的会话原文里找回来的（不是记忆摘要，是原话），可能和现在这句有关：
- 2026-09-01 10:00 · 用户：配色我想好了：灯塔用暖黄色，海面用冷一点的蓝，这样对比明显。
```

- **短句**（≤12 字）整句当短语匹配；**长句**切 4 字窗口、从中段取 6 个做 `OR`，交给 bm25 排序。
  为什么：日常提问常带"你还记得…吗"这种套话，整句短语会 0 命中；窗口 OR 让排序器干活。
- **只捡 `kind='text'`**：思考链词频天然高，会把真话挤下去。
- **去重**：同一段原话在多个会话里都出现过 ⇒ 只留第一条（前 60 字比对）。
- **系统通知不召回**：`队列推进` / `无需回复` / `自动提醒` … 这些捞旧话只会捞出一堆不相干的通知。
- **预算**：装不下的整行跳过（**绝不截半句**），继续试后面的短行。
- **降级**：`MATCH` 表达式出错 → 退回 `LIKE`；库打不开 → 插件 60 秒后再试；任何异常 → 插件 fail-open，原样放行。
- **时区**：显示时间用固定偏移（默认 `+480` = UTC+8），这样输出可复现；`--tz-offset` 可改。

## 五、设计取舍（为什么不那么做）

| 取舍 | 为什么不 |
|---|---|
| **只走词通道，不做向量** | 召回每轮都要跑，不能有网络请求或几百毫秒编码延迟。语义检索留给离线 CLI（你可以自己接编码服务）；**schema 里故意不留半成品的向量表**。 |
| **不整段 DELETE + INSERT** | 那会让块 id 全换，任何引用过块的东西立刻悬空。多花一点计算换 id 稳定，值。 |
| **索引默认 dry-run** | 它扫的是你**全部历史会话**、写的是你**唯一的人生存档**：这种命令不该因为手滑回车就动真格。 |
| **`--help` 一律不动作** | 帮助是给人看的；`--help` 顺手建个库 / 写个文件，是最容易埋雷的一种"贴心"。 |
| **注入失败不重试到死** | 库可能被别的进程占着（另一本库正在索引）。失败后 60 秒冷却再试，既不自旋也不永久放弃。 |
| **fixture 只存明文** | zstd 文件进 git 就是看不懂的二进制黑盒。压缩版与"坏块版"由 `fixtures/build.mjs` 现场造，结果可复现（无时间戳、无随机数）。 |

## 六、隐私边界（这个仓的硬底线）

- 🔴 **代码与 schema 进仓，数据一个字节都不进**：`life.db`、任何真实会话原文、任何真实记忆条目都不在本仓。
- 🔴 **fixture 全部手写**：三个假会话是虚构的（画板命名 / 书架刷漆 / 跑步膝盖），不含任何真实人、设备、路径、会话 id。
- 索引器**只读**你的会话日志，不修改、不移动、不上传；唯一写入的是 `life.db`。
- 插件只做只读查询（`readOnly: true`）。

## 同源说明

本仓与一套内部生产实现是**同一件事的两个落点**，但这次是**独立重写**，不是逐字搬运。

- **口径**：行级同源度 = 同名可比件里，本仓非空行能在参照件中找到的比例（多重集扣减）。
- **实测（2026-11-02）**：同名可比件 **7** 个，**≥50% 行同占比 = 0%**（无逐字节同、无 ≥90%、无 50–90%）。
  逐件最高的是 `plugin/index.js` **42.7%**（对应参照件的那份插件）—— 高的是"注入协议 + fail-open + 预算"这些**由框架事件名决定**的骨架，业务逻辑（查询、渲染、去重、冷却重试）是重写的。
- **怎么复跑**：`node <dsh-quality-toolkit>/dsh-sim-scan.mjs --repo <本仓> --prod-root <生产根> --baseline none`。
- **限定**：本条只覆盖"同名可比件"。**不同名但同职责**的件（如 `lib/session-log.mjs` 对应参照实现里的 zstd 拆帧 + 会话文件名 + 记录抽取三件）不计入这个数；其中 **zstd 帧切分**与参照实现**算法同源**（帧结构由 RFC 8878 定死，位运算写法没有第二种），代码是按同一规范重写的，这一条在 `lib/session-log.mjs` 顶部也写明了。

## 怎么复现结论

```bash
node fixtures/build.mjs            # 造三份假语料（明文 / 多帧 zstd / 含坏块）
node test/run.mjs                  # 53 项回归（含 CLI 真实进程、多帧解压、坏块计数）
node tools/verify-clean-home.mjs   # 灵魂判据：空 home 全链 + 召回结果指回 fixture 原话
```

`verify-clean-home.mjs` 会打印每一步的证据（命中块 id、命中的原话、可注入形态），全链 13 项。

## 环境要求

- **Node.js ≥ 22.15**（`node:sqlite` 与 `node:zlib` 的 zstd 都在这个版本线上）。明文 `.jsonl` 不依赖 zstd，但仍需要 `node:sqlite`。
- 无第三方依赖；无网络请求。
- Windows / Linux / macOS 均可（时间显示用固定偏移，跨平台输出一致）。

## 许可

[AGPL-3.0-only](./LICENSE)。

## 相关仓

本仓是**开源支线**同批发布的一员，另外几个仓与它同属一条线：

- **主文档仓** [`ops-handoff-design`](https://github.com/kira905/ops-handoff-design)：这套体系的方法论与设计稿（唯一权威叙述）。本仓的定位与登记见其中的 [`发布说明.md`](https://github.com/kira905/ops-handoff-design/blob/main/发布说明.md) **§4.5 组件索引表**（本仓是表里的一行）。镜像：[Gitee](https://gitee.com/kira905/ops-handoff-design)。
- **姊妹仓** [`dsh-peer-toolkit`](https://github.com/kira905/dsh-peer-toolkit)：多机协同五件（信箱 / 选路 / 文本同步 / 按需隧道 + `transportProfile` 三档）。同一批首发；它管"机器之间"，本仓管"日子"。镜像：[Gitee](https://gitee.com/kira905/dsh-peer-toolkit)。

> 三个仓各自**独立打 tag、独立发版**；跨仓引用一律给链接，不复制对方的正文。
