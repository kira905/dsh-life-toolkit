// 03 · 建索引：dry-run / 坏块上报 / 增量 / 块 id 稳定 / 时间窗
import fs from 'node:fs';
import path from 'node:path';
import { setSection, assert, assertEq, makeTmpDir, rmDir, test } from './harness.mjs';
import { openDb, defaultDbPath, initDb } from '../lib/schema.mjs';
import { indexSessions, syncSessionChunks } from '../lib/store.mjs';
import { buildFixtures } from '../fixtures/build.mjs';

setSection('建索引（dry-run / 坏块 / 增量 / id 稳定）');

/** 准备一份 fixture 树 + 一个已建好结构的空库（= CLI 的 `life-db-init` 之后）。 */
async function scene({ withDb = true } = {}) {
  const dir = makeTmpDir('life-index-');
  const fx = buildFixtures({ destDir: path.join(dir, 'build') });
  const home = path.join(dir, 'home');
  const dbPath = defaultDbPath(home);
  if (withDb) await initDb({ dbPath });
  return { dir, fx, home, dbPath, roots: [fx.sessionsDir] };
}

function count(db, sql) {
  return Number(db.prepare(sql).get().n);
}

test('dry-run 一个字节都不写：不建库、不建目录', async () => {
  const s = await scene({ withDb: false });
  try {
    const res = indexSessions(null, { roots: s.roots, apply: false });
    assertEq(res.sessions, 3, '三份 fixture 都会被扫到');
    assertEq(res.discovered, 3, '发现三个会话目录');
    assert(res.chunks.ins > 0, 'dry-run 也要报"本来会写多少块"');
    assertEq(fs.existsSync(s.dbPath), false, '不该建出库文件');
    assertEq(fs.existsSync(path.dirname(s.dbPath)), false, '连目录都不该建');
  } finally {
    rmDir(s.dir);
  }
});

test('建索引：三份 fixture 全进库，FTS 与 chunks 行数一致', async () => {
  const s = await scene();
  try {
    const db = await openDb(s.dbPath);
    const res = indexSessions(db, { roots: s.roots, apply: true });
    assertEq(res.sessions, 3, '写入三个会话');
    assertEq(res.failed, 0, '不该有失败');
    assertEq(res.chunks.ins, res.chunks.keep + res.chunks.meta + res.chunks.upd + res.chunks.ins, '首次入库全是新增');
    const chunks = count(db, 'SELECT count(*) n FROM chunks');
    const fts = count(db, 'SELECT count(*) n FROM chunks_fts');
    const sessions = count(db, 'SELECT count(*) n FROM sessions');
    assertEq(sessions, 3, 'sessions 表三行');
    assert(chunks >= 12, `块数应足够多（实际 ${chunks}）`);
    assertEq(fts, chunks, 'FTS 行数必须等于块数');
    assertEq(res.chunks.ins, chunks, '统计与库内一致');
    db.close();
  } finally {
    rmDir(s.dir);
  }
});

test('注入段与工具输出绝不进库', async () => {
  const s = await scene();
  try {
    const db = await openDb(s.dbPath);
    indexSessions(db, { roots: s.roots, apply: true });
    const all = db.prepare('SELECT text FROM chunks').all().map((r) => r.text).join('\n');
    assert(!all.includes('这段是系统注入的假记忆'), '注入段不该进库');
    assert(!all.includes('这是一段工具输出'), '工具输出不该进库');
    assert(all.includes('暖黄色'), '真人原话要进库');
    const kinds = db.prepare('SELECT DISTINCT kind FROM chunks ORDER BY kind').all().map((r) => r.kind);
    assertEq(kinds, ['reasoning', 'text'], '只有正文与想法两类块');
    db.close();
  } finally {
    rmDir(s.dir);
  }
});

test('坏块必须报出来：problems 有记录、sessions.note 写上', async () => {
  const s = await scene();
  try {
    const db = await openDb(s.dbPath);
    const res = indexSessions(db, { roots: s.roots, apply: true });
    assertEq(res.broken.badLines, 1, '坏行计数');
    assert(res.broken.torn >= 1, '撕裂帧计数');
    const gammaProblem = res.problems.find((p) => p.session === 'gamma');
    assert(gammaProblem, '必须点名是哪份文件');
    const note = db.prepare("SELECT note FROM sessions WHERE id='gamma'").get().note;
    assert(String(note || '').includes('broken:'), `sessions.note 要写坏块（实际 ${note}）`);
    const okNote = db.prepare("SELECT note FROM sessions WHERE id='alpha'").get().note;
    assertEq(okNote, null, '好会话不该有 note');
    db.close();
  } finally {
    rmDir(s.dir);
  }
});

test('增量：文件没变就整份跳过，块动作全 0', async () => {
  const s = await scene();
  try {
    const db = await openDb(s.dbPath);
    indexSessions(db, { roots: s.roots, apply: true });
    const before = count(db, 'SELECT count(*) n FROM chunks');
    const again = indexSessions(db, { roots: s.roots, apply: true });
    assertEq(again.sessions, 0, '第二次一个都不处理');
    assertEq(again.skipped, 3, '三份全跳过');
    assertEq(again.chunks, { keep: 0, meta: 0, upd: 0, ins: 0, del: 0 }, '零写');
    assertEq(count(db, 'SELECT count(*) n FROM chunks'), before, '块数不变');
    db.close();
  } finally {
    rmDir(s.dir);
  }
});

test('尾部追加：前缀块 id 全保住，只插新增的', async () => {
  const s = await scene();
  try {
    const db = await openDb(s.dbPath);
    indexSessions(db, { roots: s.roots, apply: true });
    const alpha = s.fx.sessions.find((x) => x.id === 'alpha');
    const idsBefore = db.prepare("SELECT id, text FROM chunks WHERE session_id='alpha' ORDER BY ord").all();
    assert(idsBefore.length >= 4, '前置条件：alpha 至少 4 块');

    const extra = [
      { type: 'turn/start', seq: 12, time: 1788228020000 },
      {
        type: 'user/message',
        seq: 13,
        time: 1788228021000,
        data: { turn: 3, content: [{ type: 'text', text: '再加一句：画板的默认背景用米白色，别用纯白。' }], source: { kind: 'user' } },
      },
      {
        type: 'assistant/message',
        seq: 14,
        time: 1788228022000,
        data: { turn: 3, message: { role: 'assistant', content: [{ type: 'text', text: '米白更耐看，长时间画眼睛不累。' }] } },
      },
      { type: 'turn/end', seq: 15, time: 1788228022500 },
    ];
    fs.appendFileSync(alpha.file, extra.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(alpha.file, future, future);

    const res = indexSessions(db, { roots: s.roots, apply: true });
    assertEq(res.sessions, 1, '只有 alpha 变了');
    assertEq(res.chunks.del, 0, '不该删块');
    assertEq(res.chunks.keep, idsBefore.length, '原有块全部原样保留');
    assertEq(res.chunks.ins, 2, '只插两条新块');
    assertEq(res.chunks.upd, 0, '不该改写已有块');

    const after = db.prepare("SELECT id, ord FROM chunks WHERE session_id='alpha' ORDER BY ord").all();
    for (let i = 0; i < idsBefore.length; i += 1) {
      assertEq(Number(after[i].id), Number(idsBefore[i].id), `第 ${i} 块 id 必须不变`);
    }
    assertEq(Number(db.prepare("SELECT turns FROM sessions WHERE id='alpha'").get().turns), 3, '轮数更新');
    db.close();
  } finally {
    rmDir(s.dir);
  }
});

test('中间改写：按位置改写同一 block id，不新增不删除', async () => {
  const s = await scene();
  try {
    const db = await openDb(s.dbPath);
    indexSessions(db, { roots: s.roots, apply: true });
    const alpha = s.fx.sessions.find((x) => x.id === 'alpha');
    const before = db.prepare("SELECT id, text FROM chunks WHERE session_id='alpha' ORDER BY ord").all();
    const target = before.find((r) => r.text.includes('潮汐画板这个名字挺好'));
    assert(target, '前置条件：找到要改写的那块');

    const raw = fs.readFileSync(alpha.file, 'utf8').replace('潮汐画板这个名字挺好', '潮汐画板这名字更顺');
    fs.writeFileSync(alpha.file, raw, 'utf8');
    const future = new Date(Date.now() + 3000);
    fs.utimesSync(alpha.file, future, future);

    const res = indexSessions(db, { roots: s.roots, apply: true });
    assertEq(res.chunks.del, 0, '不该删块');
    assertEq(res.chunks.ins, 0, '不该插块');
    assert(res.chunks.upd >= 1, '至少改写一块');

    const after = db.prepare("SELECT id, text FROM chunks WHERE session_id='alpha' ORDER BY ord").all();
    assertEq(after.length, before.length, '块数不变');
    assertEq(Number(after.find((r) => r.text.includes('这名字更顺')).id), Number(target.id), '改写落在同一个 block id 上');
    const fts = count(db, 'SELECT count(*) n FROM chunks_fts');
    assertEq(fts, count(db, 'SELECT count(*) n FROM chunks'), 'FTS 不能漏行');
    db.close();
  } finally {
    rmDir(s.dir);
  }
});

test('时间窗 / 单会话过滤', async () => {
  const s = await scene();
  try {
    const db = await openDb(s.dbPath);
    const beta = s.fx.sessions.find((x) => x.id === 'beta');
    const old = new Date(Date.now() - 30 * 86400000);
    fs.utimesSync(beta.file, old, old);

    const windowed = indexSessions(db, { roots: s.roots, apply: true, sinceDays: 7 });
    assertEq(windowed.sessions, 2, '只处理窗口内的两份');
    assertEq(count(db, "SELECT count(*) n FROM sessions WHERE id='beta'"), 0, 'beta 在窗口外');

    const only = indexSessions(db, { roots: s.roots, apply: true, onlySession: 'session-gamma' });
    assertEq(only.selected, 1, '只把指定的那一份放进候选');
    assertEq(only.discovered, 3, '树上仍然看见三份');
    assertEq(only.sessions + only.skipped, 1, '其余两份根本没进这一轮');
    db.close();
  } finally {
    rmDir(s.dir);
  }
});

test('syncSessionChunks 纯函数级：删尾块 / 删光 / 空入', async () => {
  const s = await scene();
  try {
    const db = await openDb(s.dbPath);
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ ord: i, turn_no: 1, ts: 1000 + i, role: 'user', kind: 'text', text: `块${i}`, chars: 2 }));
    let st = syncSessionChunks(db, 'unit', mk(3));
    assertEq(st.ins, 3, '三条新增');
    st = syncSessionChunks(db, 'unit', mk(2));
    assertEq(st.del, 1, '少一条 ⇒ 删一条');
    st = syncSessionChunks(db, 'unit', []);
    assertEq(st.del, 2, '传空 ⇒ 全删');
    assertEq(count(db, "SELECT count(*) n FROM chunks WHERE session_id='unit'"), 0, '库里清空');
    assertEq(count(db, "SELECT count(*) n FROM chunks_fts"), 0, 'FTS 也要清空（不能留孤儿）');
    db.close();
  } finally {
    rmDir(s.dir);
  }
});
