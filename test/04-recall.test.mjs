// 04 · 召回：查询表达式 / 命中过滤 / 去重 / 渲染预算 / 降级
import path from 'node:path';
import { setSection, assert, assertEq, assertDeepEq, makeTmpDir, rmDir, test } from './harness.mjs';
import { initDb, openDb, defaultDbPath } from '../lib/schema.mjs';
import { indexSessions } from '../lib/store.mjs';
import { buildFixtures } from '../fixtures/build.mjs';
import {
  buildMatchExpr,
  dedupeHits,
  firstLine,
  formatTime,
  isSystemishQuery,
  recall,
  renderRecallBlock,
  searchChunks,
  SYSTEM_MARKERS,
} from '../lib/recall-core.mjs';

setSection('召回（表达式 / 过滤 / 去重 / 预算）');

const hit = (over = {}) => ({
  id: 1,
  session_id: 'session-x',
  ts: 1788228011000,
  role: 'user',
  kind: 'text',
  text: '灯塔我想用暖黄色',
  source: 'local',
  score: -1,
  ...over,
});

test('查询表达式：太短不查、短句整句短语、长句切 4 字窗口', () => {
  assertEq(buildMatchExpr(''), null, '空串');
  assertEq(buildMatchExpr('??'), null, '全是符号');
  assertEq(buildMatchExpr('灯塔'), null, '两个字太短（trigram 索引根本无法命中）');
  assertDeepEq(buildMatchExpr('暖黄色'), { expr: '"暖黄色"', strategy: 'phrase' }, '三字短句走短语');
  assertDeepEq(buildMatchExpr('你还记得灯塔用什么颜色吗'), { expr: '"你还记得灯塔用什么颜色吗"', strategy: 'phrase' }, '短中文整句仍是短语');

  const long = '你还记得那次我们聊到灯塔的颜色的时候说的那句话吗';
  const plan = buildMatchExpr(long);
  assertEq(plan.strategy, 'grams', '长句切窗口');
  const terms = plan.expr.split(' OR ').map((s) => s.replace(/"/g, ''));
  assertEq(terms.length, 6, '取 6 个窗口');
  for (const t of terms) assertEq(t.length, 4, `每个窗口 4 字：${t}`);
  assert(!plan.expr.includes('你还记得'), '跳过句首套话（从 1/3 处开始取窗）');
});

test('系统通知不召回（否则每轮都会捞回一堆不相干旧话）', () => {
  for (const m of SYSTEM_MARKERS) assert(isSystemishQuery(`本次提醒：${m}，请注意`), `应识别 ${m}`);
  assertEq(isSystemishQuery('你还记得灯塔的颜色吗'), false, '正常句子不该被挡');
});

test('命中过滤：只捡正文，思考链不进召回', async () => {
  const dir = makeTmpDir('life-recall-');
  try {
    const fx = buildFixtures({ destDir: path.join(dir, 'build') });
    const dbPath = defaultDbPath(path.join(dir, 'home'));
    await initDb({ dbPath });
    const db = await openDb(dbPath);
    indexSessions(db, { roots: [fx.sessionsDir], apply: true });

    const hits = searchChunks(db, '暖黄色', { topK: 5 });
    assert(hits.length >= 1, '应命中「暖黄色」那句原话');
    assert(hits.every((h) => h.kind === 'text'), '不能返回 reasoning 块');
    assert(hits.some((h) => h.text.includes('灯塔用暖黄色')), '命中的就是那句原话');
    assert(hits.every((h) => h.ts > 0), '时间要能取到');

    const thought = searchChunks(db, '跑题去聊编程语言选型', { topK: 5 });
    assertEq(thought.length, 0, '想法里的词不该被召回到');
    db.close();
  } finally {
    rmDir(dir);
  }
});

test('长句查询能捞回原话（4 字窗口 OR）', async () => {
  const dir = makeTmpDir('life-recall-');
  try {
    const fx = buildFixtures({ destDir: path.join(dir, 'build') });
    const dbPath = defaultDbPath(path.join(dir, 'home'));
    await initDb({ dbPath });
    const db = await openDb(dbPath);
    indexSessions(db, { roots: [fx.sessionsDir], apply: true });
    const res = recall(db, '我是不是说过灯塔用暖黄色这件事你还记得吗', { topK: 3 });
    assertEq(res.strategy, 'grams', '长句走窗口');
    assert(res.hits.length >= 1, '应当有命中');
    assert(res.text.includes('[人生记忆·旧会话片段]'), '注入段要有固定标题');
    db.close();
  } finally {
    rmDir(dir);
  }
});

test('渲染：标题固定、时间与角色可读、预算内不超', () => {
  const text = renderRecallBlock([hit({ role: 'user' }), hit({ id: 2, role: 'assistant', text: '暖黄配冷蓝很稳：灯塔是唯一的暖色块。' })], {
    maxChars: 400,
  });
  const lines = text.split('\n');
  assertEq(lines.length, 3, '标题 + 两行');
  assert(lines[0].startsWith('[人生记忆·旧会话片段]'), '标题行');
  assert(lines[1].startsWith('- 2026-09-01 10:00 · 用户：'), `时间与角色：${lines[1]}`);
  assert(lines[2].includes('助手：暖黄配冷蓝很稳'), '助手行');

  const tight = renderRecallBlock([hit({ text: 'x'.repeat(200) }), hit({ id: 2, text: '短句' })], { maxChars: 90 });
  assert(tight.length <= 90, `预算必须守住（实际 ${tight.length}）`);
  assert(tight.includes('短句'), '长行装不下就跳过，让短行进去');
});

test('渲染：非本机来源会标出来，本机不标', () => {
  const a = renderRecallBlock([hit({ source: 'local' })], { maxChars: 400 });
  assert(!a.includes('· local'), '本机来源不额外标注');
  const b = renderRecallBlock([hit({ source: 'peer-demo' })], { maxChars: 400 });
  assert(b.includes('· peer-demo ·'), '别的来源要标出来');
});

test('去重：同一段原话命中两次只留一条', () => {
  const same = '这句话在两个会话里都出现过，内容完全一样的开头，后面略有不同';
  const hits = [hit({ id: 1, text: same }), hit({ id: 2, text: same }), hit({ id: 3, text: '另一段完全不同的话' })];
  const out = dedupeHits(hits);
  assertEq(out.length, 2, '去重后两条');
  assertEq(out.map((h) => h.id), [1, 3], '留最先出现的那条');
});

test('formatTime：固定偏移，坏值给"时间未知"', () => {
  assertEq(formatTime(1788228011000), '2026-09-01 10:00', 'UTC+8 默认');
  assertEq(formatTime(1788228011000, 0), '2026-09-01 02:00', 'UTC');
  assertEq(formatTime(null), '时间未知', '空值');
  assertEq(formatTime(0), '时间未知', '零值');
});

test('firstLine：跳过空行取第一行正文', () => {
  assertEq(firstLine('\n\n第一行\n第二行'), '第一行', '跳过空行');
  assertEq(firstLine(''), '', '空串');
});

test('失败降级：库坏了 / 表不在，一律返回空而不是抛', async () => {
  const dir = makeTmpDir();
  try {
    const dbPath = defaultDbPath(path.join(dir, 'home'));
    await initDb({ dbPath });
    const db = await openDb(dbPath);
    db.exec('DROP TABLE chunks_fts'); // 模拟索引表被删
    const res = recall(db, '暖黄色', { topK: 2 });
    assertEq(res.hits, [], 'FTS 不在 ⇒ 命中为空（LIKE 兜底也没有行）');
    assertEq(res.text, '', '不注入');
    db.close();
  } finally {
    rmDir(dir);
  }
});
