// 07 · 来源列兼容：生产库（sessions.src）与老开源库（sessions.source）都要能读
//
// 背景（2026-11-04）：`recall-core` 曾把来源列写死成 `coalesce(s.source,'local')`，且被两层
// catch 吞掉 ⇒ 拿本仓工具去查生产库（列名叫 `src`）会**永远 0 命中、一句错都不报**
// （实测：生产库 391,368 块、同义查询命中 124,403 块，而 searchChunks 返回 0 条且不抛）。
// 现在改成「探测列名 + 列错就抛」，本文件钉住四条：
//   ① 生产形态（src）能读出命中，source 显示 src 的值
//   ② 老开源形态（source）照样能读（不做改名 —— 改名会让老库立刻哑掉）
//   ③ sessions 表两列都没有 / 没有 sessions 表 ⇒ 来源记 local，查询本身不许废
//   ④ 真的列对不上（chunks 缺列）⇒ 必须抛，不许又是静默空
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertEq, assertThrows, makeTmpDir, rmDir, setSection, test } from './harness.mjs';
import { searchChunks } from '../lib/recall-core.mjs';

setSection('来源列兼容（生产 src / 老库 source）');

const CHUNKS_DDL = `
  CREATE TABLE chunks(
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_no INTEGER, ts INTEGER,
    role TEXT, kind TEXT, ord INTEGER, text TEXT NOT NULL, chars INTEGER, created_ms INTEGER
  );
  CREATE VIRTUAL TABLE chunks_fts USING fts5(text, tokenize='trigram');
  INSERT INTO chunks(session_id, ts, role, kind, ord, text, chars)
    VALUES('session-A', 1788228011000, 'user', 'text', 0, '灯塔我想用暖黄色', 8);
  INSERT INTO chunks_fts(rowid, text) VALUES(1, '灯塔我想用暖黄色');
`;

/** 造一个最小可用库；`sessionsDdl` 传 null 表示干脆没有 sessions 表。 */
function makeDb(sessionsDdl) {
  const dir = makeTmpDir('recall-srccol-');
  const db = new DatabaseSync(path.join(dir, 't.db'));
  db.exec(CHUNKS_DDL);
  if (sessionsDdl) {
    db.exec(sessionsDdl.ddl);
    db.exec(sessionsDdl.seed);
  }
  return { db, dir };
}

test('生产形态（sessions.src）⇒ 能读出来源，不是空结果', () => {
  const { db, dir } = makeDb({
    ddl: 'CREATE TABLE sessions(id TEXT PRIMARY KEY, root TEXT, src TEXT);',
    seed: `INSERT INTO sessions(id,src) VALUES('session-A','workstation-a');`,
  });
  try {
    const hits = searchChunks(db, '暖黄色', { topK: 3 });
    assertEq(hits.length, 1, '必须命中 1 条（写死 s.source 时这里是 0 —— 静默空检索）');
    assertEq(hits[0].source, 'workstation-a', '来源取的是 src 的值');
    assertEq(hits[0].text, '灯塔我想用暖黄色', '正文原样');
  } finally {
    db.close();
    rmDir(dir);
  }
});

test('老开源形态（sessions.source）⇒ 照样能读（改名会把雷挖到另一边）', () => {
  const { db, dir } = makeDb({
    ddl: "CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'local');",
    seed: `INSERT INTO sessions(id,source) VALUES('session-A','workstation-a');`,
  });
  try {
    const hits = searchChunks(db, '暖黄色', { topK: 3 });
    assertEq(hits.length, 1, '老库也必须命中');
    assertEq(hits[0].source, 'workstation-a', '来源取的是 source 的值');
  } finally {
    db.close();
    rmDir(dir);
  }
});

test('sessions 两列都没有 ⇒ 来源记 local，查询不许废', () => {
  const { db, dir } = makeDb({
    ddl: 'CREATE TABLE sessions(id TEXT PRIMARY KEY, note TEXT);',
    seed: `INSERT INTO sessions(id) VALUES('session-A');`,
  });
  try {
    const hits = searchChunks(db, '暖黄色', { topK: 3 });
    assertEq(hits.length, 1, '没有来源列也要出结果');
    assertEq(hits[0].source, 'local', '来源兜底为 local');
  } finally {
    db.close();
    rmDir(dir);
  }
});

test('连 sessions 表都没有 ⇒ 来源记 local（表不在算正常态，不抛）', () => {
  const { db, dir } = makeDb(null);
  try {
    const hits = searchChunks(db, '暖黄色', { topK: 3 });
    assertEq(hits.length, 1, '没有 sessions 表也要出结果');
    assertEq(hits[0].source, 'local', '来源兜底为 local');
  } finally {
    db.close();
    rmDir(dir);
  }
});

test('列真的对不上（chunks 缺 ts 列）⇒ 必须抛，不许静默空', () => {
  const dir = makeTmpDir('recall-badcol-');
  const db = new DatabaseSync(path.join(dir, 't.db'));
  try {
    db.exec(`
      CREATE TABLE chunks(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        role TEXT, kind TEXT, ord INTEGER, text TEXT NOT NULL, chars INTEGER);
      CREATE VIRTUAL TABLE chunks_fts USING fts5(text, tokenize='trigram');
      INSERT INTO chunks(session_id, role, kind, ord, text, chars)
        VALUES('session-A', 'user', 'text', 0, '灯塔我想用暖黄色', 8);
      INSERT INTO chunks_fts(rowid, text) VALUES(1, '灯塔我想用暖黄色');
    `);
    assertThrows(() => searchChunks(db, '暖黄色', { topK: 3 }), '缺列必须抛出来（否则表现为"永远 0 命中"）');
  } finally {
    db.close();
    rmDir(dir);
  }
});
