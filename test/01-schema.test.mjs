// 01 · 库结构：建库、幂等、版本闸、只读打开
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setSection, assert, assertEq, assertThrows, makeTmpDir, rmDir, test } from './harness.mjs';
import {
  SCHEMA_DDL,
  SCHEMA_VERSION,
  dbSummary,
  defaultDbPath,
  initDb,
  migrate,
  openDb,
  readSchemaVersion,
  resolveHome,
} from '../lib/schema.mjs';

setSection('库结构（schema / 建库 / 迁移 / 只读）');

test('建库：四张表齐全，schema 版本落到 meta', async () => {
  const dir = makeTmpDir();
  try {
    const dbPath = path.join(dir, 'memory-life', 'life.db');
    const res = await initDb({ dbPath });
    assert(res.created, '应当是新建');
    assertEq(res.from, 0, '新库起始版本');
    assertEq(res.to, SCHEMA_VERSION, '目标版本');
    for (const t of ['meta', 'sessions', 'chunks', 'chunks_fts']) assert(res.tables.includes(t), `缺表 ${t}`);
    assertEq(res.counts, { sessions: 0, chunks: 0 }, '新库应为空');

    const db = new DatabaseSync(dbPath, { readOnly: true });
    assertEq(readSchemaVersion(db), SCHEMA_VERSION, 'meta 里的版本');
    db.close();
  } finally {
    rmDir(dir);
  }
});

test('建库幂等：第二次跑什么都不改', async () => {
  const dir = makeTmpDir();
  try {
    const dbPath = path.join(dir, 'life.db');
    await initDb({ dbPath });
    const before = fs.statSync(dbPath).size;
    const again = await initDb({ dbPath });
    assertEq(again.created, false, '第二次不是"新建"');
    assertEq(again.from, SCHEMA_VERSION, '第二次起始版本已经是当前版本');
    assertEq(again.applied, [], '不该有迁移动作');
    assertEq(fs.statSync(dbPath).size, before, '库文件体积不该变（只跑了 IF NOT EXISTS）');
  } finally {
    rmDir(dir);
  }
});

test('半初始化库：meta 在但没写版本 ⇒ 补齐（不丢数据）', async () => {
  const dir = makeTmpDir();
  try {
    const dbPath = path.join(dir, 'half.db');
    const raw = new DatabaseSync(dbPath);
    // 模拟 initDb 跑到一半被杀的现场：表都建好了，但版本还没写进 meta
    raw.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    raw.exec(SCHEMA_DDL.join(';\n'));
    raw.exec("INSERT INTO sessions(id, source) VALUES('s-1','local')");
    raw.close();

    const db = await openDb(dbPath);
    const res = migrate(db);
    assertEq(res.from, 0, '没有版本键 ⇒ 视为 0');
    assertEq(readSchemaVersion(db), SCHEMA_VERSION, '补齐后的版本');
    assertEq(Number(db.prepare('SELECT count(*) n FROM sessions').get().n), 1, '原有行要还在');
    db.close();
  } finally {
    rmDir(dir);
  }
});

test('版本闸：库比代码新 ⇒ 拒写（不让旧代码写坏新库）', async () => {
  const dir = makeTmpDir();
  try {
    const dbPath = path.join(dir, 'future.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    raw.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION + 5));
    raw.close();

    const db = await openDb(dbPath);
    const err = await assertThrows(() => migrate(db), '应当拒绝');
    assertEq(err.code, 'SCHEMA_TOO_NEW', '错误码');
    db.close();
  } finally {
    rmDir(dir);
  }
});

test('只读打开不存在的库 ⇒ 明确报错（不悄悄建一个空库）', async () => {
  const dir = makeTmpDir();
  try {
    const err = await assertThrows(() => openDb(path.join(dir, 'nope.db'), { readOnly: true }), '应当抛错');
    assertEq(err.code, 'ENOENT_DB', '错误码');
    assert(!fs.existsSync(path.join(dir, 'nope.db')), '不该凭空建出文件');
  } finally {
    rmDir(dir);
  }
});

test('dbSummary 读数与库内实际一致', async () => {
  const dir = makeTmpDir();
  try {
    const dbPath = path.join(dir, 'life.db');
    await initDb({ dbPath });
    const db = await openDb(dbPath);
    db.exec("INSERT INTO chunks(session_id,turn_no,ts,role,kind,ord,text,chars,created_ms) VALUES('s1',1,1,'user','text',0,'一句话',3,1)");
    const id = Number(db.prepare("SELECT id FROM chunks WHERE session_id='s1'").get().id);
    db.prepare('INSERT INTO chunks_fts(rowid,text) VALUES(?,?)').run(id, '一句话');
    db.exec("INSERT INTO sessions(id,source) VALUES('s1','local')");
    db.close();

    const sum = await dbSummary(dbPath);
    assertEq(sum.sessions, 1, 'sessions');
    assertEq(sum.chunks, 1, 'chunks');
    assertEq(sum.ftsRows, 1, 'fts 行数');
    assertEq(sum.chars, 3, '字数');
    assertEq(sum.human, 1, '人话块数（kind=text）');
  } finally {
    rmDir(dir);
  }
});

test('路径解析：--home > $DSH_HOME > ~/.dsh', () => {
  const saved = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = 'D:/demo-dsh-home';
    assertEq(resolveHome(), path.resolve('D:/demo-dsh-home'), 'env 优先');
    assertEq(defaultDbPath(), path.join(path.resolve('D:/demo-dsh-home'), 'memory-life', 'life.db'), '默认库路径');
    assertEq(resolveHome('E:/explicit'), path.resolve('E:/explicit'), '--home 最高优先');
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
  }
});
