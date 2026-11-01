// schema.mjs —— 人生记忆库（life.db）的结构定义、建库与迁移
//
// 一句话：把「聊过的话」切成块，存两张表 + 一张 FTS5 索引表，能按关键词秒查。
//
// 三张表的职责（别混）：
//   sessions   —— 一行 = 一个会话目录（哪份文件、多大、几轮、什么时候建的索引）
//   chunks     —— 一行 = 一段原话（谁说的 / 说 / 想 / 第几轮 / 第几块）
//   chunks_fts —— FTS5(trigram) 外部内容表，rowid 就是 chunks.id
//
// 为什么用 trigram 分词器：中文没有空格，`unicode61` 会把「今天天气不错」当成一个
// 整词，查「天气」命中不了；trigram 按三字窗口建索引，中文短语（≥3 字）能直接命中。
// 代价是索引体积约为正文的 2~3 倍，这个代价在「查得到」面前是值的。
//
// 库默认位置：$DSH_HOME/memory-life/life.db（与工作记忆 $DSH_HOME/memory/memory.db 分开，
// 两本账别混：工作记忆记台账，人生记忆记日子）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 当前 schema 版本。加列 / 加表 / 改索引时 +1，并在 MIGRATIONS 里补一步。 */
export const SCHEMA_VERSION = 1;

/** 建表 DDL。全部 IF NOT EXISTS ⇒ 在已有库上跑一遍只是空转，不会破坏数据。 */
export const SCHEMA_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS meta(
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions(
     id TEXT PRIMARY KEY,
     source TEXT NOT NULL DEFAULT 'local',
     workspace TEXT,
     dir TEXT,
     file TEXT,
     file_kind TEXT,
     bytes INTEGER,
     mtime_ms INTEGER,
     started_ms INTEGER,
     ended_ms INTEGER,
     turns INTEGER,
     chunk_count INTEGER,
     chars INTEGER,
     indexed_ms INTEGER,
     note TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS chunks(
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     turn_no INTEGER,
     ts INTEGER,
     role TEXT NOT NULL,
     kind TEXT NOT NULL,
     ord INTEGER NOT NULL,
     text TEXT NOT NULL,
     chars INTEGER NOT NULL,
     created_ms INTEGER
   )`,
  'CREATE INDEX IF NOT EXISTS idx_chunks_session_ord ON chunks(session_id, ord)',
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, tokenize='trigram')`,
]);

/**
 * 迁移表：`{ [目标版本]: (db) => void }`。
 * 版本号 = 执行完这一步之后库应处于的版本。空表 = 还没有第二版，
 * 但入口、断言与测试都已就位 —— 将来加列时只补一个键，不用改调用方。
 */
export const MIGRATIONS = Object.freeze({});

/** 解析 home（`--home` > `$DSH_HOME` > `~/.dsh`，与 DSH 生态同一口径）。 */
export function resolveHome(home) {
  if (home) return path.resolve(String(home));
  const env = process.env.DSH_HOME || process.env.BUTLER_DSH_HOME;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return path.join(os.homedir(), '.dsh');
}

/** 库文件默认路径：`<home>/memory-life/life.db`。 */
export function defaultDbPath(home) {
  return path.join(resolveHome(home), 'memory-life', 'life.db');
}

/** 读 meta 里的 schema 版本（没有 meta 表 / 没有该键 ⇒ 0，表示"这是一本老库"）。 */
export function readSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    const n = Number(row?.value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 库里已有的物理表名（用于判断"空库 / 老库 / 新库"）。 */
export function listTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => String(r.name));
}

/**
 * 建库 / 升级到当前版本（幂等）。
 * @param {import('node:sqlite').DatabaseSync} db 已打开的库（可写）
 * @returns {{from:number,to:number,applied:number[],tables:string[]}}
 */
export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const from = readSchemaVersion(db);
  // 库比代码新 ⇒ 停下来。老代码写新库会按旧列拼 SQL，轻则写坏、重则把新列的数据悄悄丢掉。
  if (from > SCHEMA_VERSION) {
    const err = new Error(`库的 schema 版本 ${from} 高于本代码支持的 ${SCHEMA_VERSION}：请升级本仓，别用旧代码写新库`);
    err.code = 'SCHEMA_TOO_NEW';
    throw err;
  }
  const applied = [];
  for (let v = from + 1; v <= SCHEMA_VERSION; v += 1) {
    const step = MIGRATIONS[v];
    if (step) {
      step(db);
      applied.push(v);
    }
  }
  db.exec(SCHEMA_DDL.join(';\n'));
  db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    String(SCHEMA_VERSION),
  );
  return { from, to: SCHEMA_VERSION, applied, tables: listTables(db) };
}

/**
 * 打开库（默认自动建目录、自动迁移；`readOnly` 时只读打开且不迁移）。
 * @param {string} dbPath
 * @param {{readOnly?:boolean}} [opts]
 */
export async function openDb(dbPath, opts = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.resolve(String(dbPath));
  if (opts.readOnly) {
    if (!fs.existsSync(file)) {
      const err = new Error(`库不存在：${file}（先跑 dsh-life-init / life-index --apply）`);
      err.code = 'ENOENT_DB';
      throw err;
    }
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // 库可能很大（几十万块），别让别的读事务把本轮 COMMIT 直接顶成 SQLITE_BUSY。
  db.exec('PRAGMA busy_timeout = 15000');
  // journal_mode=DELETE：库常常被"只读插件"同时打开，WAL 会留下 -wal/-shm 两个伴生文件，
  // 备份/复制时容易只搬走一半。DELETE 模式在这个写入频率下完全够用。
  db.exec('PRAGMA journal_mode = DELETE');
  return db;
}

/**
 * 建库（CLI 与测试共用）。
 * @param {{dbPath:string, quiet?:boolean}} opts
 */
export async function initDb(opts) {
  const file = path.resolve(String(opts.dbPath));
  const existed = fs.existsSync(file);
  const db = await openDb(file);
  const res = migrate(db);
  const counts = {
    sessions: Number(db.prepare('SELECT count(*) n FROM sessions').get().n),
    chunks: Number(db.prepare('SELECT count(*) n FROM chunks').get().n),
  };
  db.close();
  return { dbPath: file, created: !existed, ...res, counts };
}

/** 只读摘要（给 CLI / 报告用）。 */
export async function dbSummary(dbPath) {
  const db = await openDb(dbPath, { readOnly: true });
  try {
    const g = (sql) => Number(db.prepare(sql).get().n);
    return {
      dbPath: path.resolve(String(dbPath)),
      bytes: fs.statSync(path.resolve(String(dbPath))).size,
      schemaVersion: readSchemaVersion(db),
      sessions: g('SELECT count(*) n FROM sessions'),
      chunks: g('SELECT count(*) n FROM chunks'),
      chars: g('SELECT coalesce(sum(chars),0) n FROM chunks'),
      human: g("SELECT count(*) n FROM chunks WHERE kind='text'"),
      ftsRows: g('SELECT count(*) n FROM chunks_fts'),
    };
  } finally {
    db.close();
  }
}
