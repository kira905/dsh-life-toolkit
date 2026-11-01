// 05 · 召回插件：pre-step 注入协议 / 预算 / fail-open / 配置
import path from 'node:path';
import { setSection, assert, assertEq, makeTmpDir, rmDir, test } from './harness.mjs';
import { initDb, openDb, defaultDbPath } from '../lib/schema.mjs';
import { indexSessions } from '../lib/store.mjs';
import { buildFixtures } from '../fixtures/build.mjs';
import {
  apply,
  createRecallEngine,
  lastUserText,
  makeInjectedMessage,
  resolveDbPath,
  unknownConfigKeys,
} from '../plugin/index.js';

setSection('召回插件（注入协议 / 预算 / fail-open）');

/** 假 ctx：只收集 agent/pre-step 的 handler。 */
function fakeCtx() {
  const handlers = [];
  return {
    handlers,
    on(event, fn, opts) {
      handlers.push({ event, fn, opts });
    },
  };
}

async function sceneWithDb() {
  const dir = makeTmpDir('life-plugin-');
  const fx = buildFixtures({ destDir: path.join(dir, 'build') });
  const dbPath = defaultDbPath(path.join(dir, 'home'));
  await initDb({ dbPath });
  const db = await openDb(dbPath);
  indexSessions(db, { roots: [fx.sessionsDir], apply: true });
  db.close();
  return { dir, fx, dbPath };
}

/** 驱动一次 pre-step（模拟 dsh：先 await next()，再走我们的 handler）。 */
async function drive(handler, { messages, step, decision = { kind: 'enter', messages } }) {
  return handler({ messages, step }, async () => decision);
}

test('取最后一条真人输入：跳过注入消息与空消息', () => {
  assertEq(
    lastUserText([
      { role: 'user', content: [{ type: 'text', text: '第一句' }] },
      { role: 'assistant', content: [{ type: 'text', text: '回一句' }] },
      { role: 'user', content: [{ type: 'text', text: '最末这句才是当前的' }] },
    ]),
    '最末这句才是当前的',
    '取最后一条 user',
  );
  assertEq(lastUserText([{ role: 'user', content: '字符串形态的 content' }]), '字符串形态的 content', '字符串 content');
  assertEq(lastUserText([]), '', '空数组');
});

test('库路径解析：配置 > $DSH_HOME > ~/.dsh', () => {
  assertEq(resolveDbPath({ dbPath: 'D:/x/life.db' }, {}, 'C:/home'), path.resolve('D:/x/life.db'), '配置优先');
  assertEq(resolveDbPath({}, { DSH_HOME: 'D:/y' }, 'C:/home'), path.join(path.resolve('D:/y'), 'memory-life', 'life.db'), 'env 次之');
  assertEq(resolveDbPath({}, {}, 'C:/home'), path.join('C:/home', '.dsh', 'memory-life', 'life.db'), '兜底 ~/.dsh');
});

test('引擎：没库 / 不是第一步 / 查询太短 —— 三种情况都不注入且不抛', async () => {
  const dir = makeTmpDir();
  try {
    const engine = createRecallEngine({ dbPath: path.join(dir, 'nope', 'life.db') });
    let r = await engine.forStep([{ role: 'user', content: [{ type: 'text', text: '灯塔用什么颜色' }] }], 1);
    assertEq(r.text, '', '没库不注入');
    assertEq(r.reason, 'db-unavailable', '原因可读');

    const s = await sceneWithDb();
    try {
      const e2 = createRecallEngine({ dbPath: s.dbPath });
      r = await e2.forStep([{ role: 'user', content: [{ type: 'text', text: '灯塔用什么颜色' }] }], 2);
      assertEq(r.reason, 'not-first-step', '只在第一轮召回');
      r = await e2.forStep([{ role: 'user', content: [{ type: 'text', text: '嗯' }] }], 1);
      assertEq(r.reason, 'query-too-short', '太短不查');
      e2.close();
    } finally {
      rmDir(s.dir);
    }
  } finally {
    rmDir(dir);
  }
});

test('引擎：有命中时给出「标题 + 原话」，且守住预算', async () => {
  const s = await sceneWithDb();
  try {
    const engine = createRecallEngine({ dbPath: s.dbPath, topK: 2, maxChars: 320 });
    const r = await engine.forStep([{ role: 'user', content: [{ type: 'text', text: '我说灯塔要用暖黄色那种你还记得吗' }] }], 1);
    assert(r.text, '应当注入');
    assert(r.text.startsWith('[人生记忆·旧会话片段]'), '固定标题');
    assert(r.text.includes('暖黄色'), '要带上原话片段');
    assert(r.text.length <= 320, `预算：${r.text.length}`);
    assert(r.hits.length >= 1 && r.hits[0].id > 0, '要带命中块 id（便于事后核对）');
    engine.close();
  } finally {
    rmDir(s.dir);
  }
});

test('apply：注入一条带标记的 user 消息，原有消息一条不少', async () => {
  const s = await sceneWithDb();
  try {
    const ctx = fakeCtx();
    apply(ctx, { dbPath: s.dbPath, topK: 1, maxChars: 200 });
    assertEq(ctx.handlers.length, 1, '挂了一个 pre-step');
    assertEq(ctx.handlers[0].event, 'agent/pre-step', '事件名');
    assertEq(ctx.handlers[0].opts?.prepend, false, '追加在末尾');

    const ctx2 = fakeCtx();
    apply(ctx2, { dbPath: s.dbPath, topK: 1, maxChars: 200 });
    const messages = [{ role: 'user', content: [{ type: 'text', text: '我说灯塔要用暖黄色那种你还记得吗' }] }];
    const out = await drive(ctx2.handlers[0].fn, { messages, step: 1 });
    assertEq(out.kind, 'enter', '仍然是 enter');
    assertEq(out.messages.length, messages.length + 1, '多一条注入消息');
    assertEq(out.messages[0], messages[0], '原有消息原样保留');
    const injected = out.messages[out.messages.length - 1];
    assertEq(injected.role, 'user', '注入的是 user 消息');
    assertEq(injected.source.kind, 'life-memory', '带来源标记（事件流里可追溯）');
    assert(injected.content[0].text.includes('暖黄色'), '正文是原话段');
    assert(Object.isFrozen(injected), '注入消息要冻结（下游别改它）');
  } finally {
    rmDir(s.dir);
  }
});

test('apply：没命中 / 系统通知 / next 被拒 —— 一律原样放行', async () => {
  const s = await sceneWithDb();
  try {
    const ctx = fakeCtx();
    apply(ctx, { dbPath: s.dbPath });
    const fn = ctx.handlers[0].fn;

    const noHit = [{ role: 'user', content: [{ type: 'text', text: '一个完全不存在的词组组合' }] }];
    let out = await drive(fn, { messages: noHit, step: 1 });
    assertEq(out.messages.length, noHit.length, '没命中不注入');

    const sys = [{ role: 'user', content: [{ type: 'text', text: '队列推进：本卡已进入 review，无需回复' }] }];
    out = await drive(fn, { messages: sys, step: 1 });
    assertEq(out.messages.length, sys.length, '系统通知不注入');

    const reject = await fn({ messages: noHit, step: 1 }, async () => ({ kind: 'reject', reason: 'x' }));
    assertEq(reject.kind, 'reject', 'reject 原样透传');

    out = await drive(fn, { messages: [{ role: 'user', content: [{ type: 'text', text: '暖黄色那个还想再问问细节' }] }], step: 3 });
    assertEq(out.messages.length, 1, '非第一步不注入');
  } finally {
    rmDir(s.dir);
  }
});

test('apply：next 抛错 / 库被删 —— fail-open，绝不把这一轮搞挂', async () => {
  const ctx = fakeCtx();
  apply(ctx, { dbPath: 'D:/definitely/not/here/life.db' });
  const fn = ctx.handlers[0].fn;
  const messages = [{ role: 'user', content: [{ type: 'text', text: '我说灯塔要用暖黄色那种你还记得吗' }] }];
  const out = await drive(fn, { messages, step: 1 });
  assertEq(out.messages.length, messages.length, '库不在也要正常对话');
});

test('注入消息构造：带 items 便于事后核对命中块', () => {
  const m = makeInjectedMessage('测试文本', [7, 9]);
  assertEq(m.source.items, [7, 9], '命中块 id');
  assertEq(m.content[0].text, '测试文本', '正文');
  assert(/^[0-9a-f-]{36}$/.test(m.id), 'id 是 uuid');
});

test('配置键自查：拼错的键能被点名', () => {
  assertEq(unknownConfigKeys({ dbPath: 'x', topK: 2 }), [], '认识的键不报');
  assertEq(unknownConfigKeys({ dbpath: 'x', maxChar: 3 }), ['dbpath', 'maxChar'], '大小写/拼错要点名');
});
