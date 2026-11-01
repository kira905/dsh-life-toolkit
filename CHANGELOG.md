# Changelog

本仓从 0.1.0 开始（此前这套能力只存在于本机生产环境，未对外发布）。

## 0.1.0 · 2026-11-02

**首个公开版：人生记忆（会话原文索引 + 按需召回）。**

### 新增

- **库结构** `lib/schema.mjs`：`sessions` / `chunks` / `chunks_fts`（FTS5 trigram）/ `meta`；
  `SCHEMA_VERSION` + `MIGRATIONS` 迁移入口；库比代码新时拒写（`SCHEMA_TOO_NEW`）。
- **日志读取** `lib/session-log.mjs`：
  - 文件名认 `session.jsonl` / `session.jsonl.zstd` / `session.vN.jsonl.zstd`（任意世代）；
  - **多帧 zstd 拆帧**（按帧结构解析，不靠搜魔数）；撕裂帧整帧丢弃并上报偏移；
  - 记录 → 「轮」：只收真人正文与助手正文/想法，注入段与工具事件丢弃。
- **切块** `lib/chunker.mjs`：按字符数、优先按行、代理对不切半。
- **索引写入** `lib/store.mjs`：
  - 两层增量（`mtime + bytes` 未变就不解压 / 变了走**双端收缩**保住块 id）；
  - 坏块（撕裂帧 / 坏帧 / 坏行）计数并写进 `sessions.note`，绝不静默跳过。
- **召回** `lib/recall-core.mjs`：
  - 短句短语匹配 / 长句 4 字窗口 OR；只捡正文（`kind='text'`）；
  - 去重、系统通知过滤、预算闸（整行跳过而不是截半句）、`LIKE` 兜底。
- **三个 CLI**：`dsh-life-init` / `dsh-life-index`（默认 dry-run）/ `dsh-life-recall`。
  `--help` 一律不动作；未知参数退出码 2。
- **召回插件** `plugin/index.js`：`agent/pre-step` 注入 1~2 段旧原话，`fail-open`，
  库不可用 60 秒冷却重试；`cordis.patch.yml` 提供 bundle 挂载（`id: kira905-life-memory`）。
- **假语料** `fixtures/`：三份手写会话（明文 / 多帧 zstd / 含坏块 + 撕裂帧），由 `build.mjs` 现场生成，可复现。
- **回归** `test/`：53 项，含 CLI 真实进程、多帧解压、坏块计数、块 id 稳定、插件注入协议。
- **灵魂判据** `tools/verify-clean-home.mjs`：空 `DSH_HOME` 里走完 建库 → 建索引 → 召回，
  并证明命中的块**逐字存在于 fixture 原话**中（13 项检查）。

### 说明

- 只走词法通道（FTS5），不含向量/语义检索；schema 中**不留**半成品向量表。
- 仅代码与 schema 开源：`life.db`、任何真实会话原文永远不进仓。
- 环境要求 Node ≥ 22.15（`node:sqlite` 与 `node:zlib` 的 zstd）。
