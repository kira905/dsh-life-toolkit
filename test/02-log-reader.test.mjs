// 02 · 日志读取：文件名判据 / 多帧 zstd / 坏块计数 / 记录→轮
import fs from 'node:fs';
import path from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { setSection, assert, assertEq, assertDeepEq, makeTmpDir, rmDir, test } from './harness.mjs';
import {
  classifyLogName,
  extractTurns,
  listLogsInDir,
  pickCurrentLog,
  readSessionLog,
  readZstdBytes,
  recordText,
  splitZstdFrames,
} from '../lib/session-log.mjs';
import { buildFixtures } from '../fixtures/build.mjs';

setSection('日志读取（文件名 / zstd 多帧 / 坏块 / 抽轮）');

function fixtureTree() {
  const dir = makeTmpDir('life-fixture-');
  const fx = buildFixtures({ destDir: path.join(dir, 'build') });
  return { dir, fx };
}

function writeJsonl(file, records) {
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(file, text, 'utf8');
  return text;
}

test('文件名判据：三个世代 + 明文 + 未来世代都认，别的都不认', () => {
  assertDeepEq(classifyLogName('session.jsonl'), { kind: 'plain', generation: 0 }, '明文旧名');
  assertDeepEq(classifyLogName('session.v2.jsonl'), { kind: 'plain', generation: 2 }, '明文带世代');
  assertDeepEq(classifyLogName('session.jsonl.zstd'), { kind: 'zstd', generation: 0 }, '压缩旧名');
  assertDeepEq(classifyLogName('session.v3.jsonl.zstd'), { kind: 'zstd', generation: 3 }, 'v3');
  assertDeepEq(classifyLogName('session.v4.jsonl.zstd'), { kind: 'zstd', generation: 4 }, 'v4');
  assertDeepEq(classifyLogName('session.v9.jsonl.zstd'), { kind: 'zstd', generation: 9 }, '未来世代不用改代码');
  for (const bad of ['session.jsonl.zstd.bak', 'other.jsonl', 'session.txt', 'session.jsonl.gz']) {
    assertEq(classifyLogName(bad), null, `不该认 ${bad}`);
  }
});

test('挑当前那份：mtime 最新优先，平局取代际大', () => {
  const dir = makeTmpDir();
  try {
    const d = path.join(dir, 'session-x');
    fs.mkdirSync(d, { recursive: true });
    const old = path.join(d, 'session.v3.jsonl.zstd');
    const cur = path.join(d, 'session.v4.jsonl.zstd');
    fs.writeFileSync(old, Buffer.from([1, 2, 3]));
    fs.writeFileSync(cur, Buffer.from([4, 5, 6]));
    fs.utimesSync(old, new Date(2026, 0, 1), new Date(2026, 0, 1));
    fs.utimesSync(cur, new Date(2026, 0, 2), new Date(2026, 0, 2));
    assertEq(pickCurrentLog(d).name, 'session.v4.jsonl.zstd', 'mtime 新的胜');

    // 同一时刻 ⇒ 比代际
    fs.utimesSync(old, new Date(2026, 0, 3), new Date(2026, 0, 3));
    fs.utimesSync(cur, new Date(2026, 0, 3), new Date(2026, 0, 3));
    assertEq(pickCurrentLog(d).name, 'session.v4.jsonl.zstd', '平局时代际大的胜');
    assertEq(listLogsInDir(d).length, 2, '两个候选都要列出来（判"内容最全"的调用方要用）');
  } finally {
    rmDir(dir);
  }
});

test('读明文日志：记录条数、种类、坏行', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(
      file,
      '{"type":"session","seq":0}\n{"type":"user/message","seq":1}\nnot-json\n\n{"type":"turn/end","seq":2}\n',
      'utf8',
    );
    const res = readSessionLog(file);
    assertEq(res.error, undefined, '不该有错误');
    assertEq(res.kind, 'plain', '种类');
    assertEq(res.records.length, 3, '三条能解析的记录');
    assertEq(res.stats.badLines, 1, '坏行要计数');
    assertEq(res.stats.lines, 4, '非空行数');
    assertEq(res.stats.tornAt, null, '明文没有撕裂帧概念');
  } finally {
    rmDir(dir);
  }
});

test('读多帧 zstd：帧数、记录全还原、无撕裂', () => {
  const { dir, fx } = fixtureTree();
  try {
    const beta = fx.sessions.find((s) => s.id === 'beta');
    const res = readSessionLog(beta.file);
    assertEq(res.error, undefined, '不该有错误');
    assertEq(res.kind, 'zstd', '种类');
    assertEq(res.stats.frames, 3, '三帧');
    assertEq(res.stats.tornAt, null, '不该有撕裂帧');
    assertEq(res.stats.badFrames, 0, '不该有坏帧');
    assertEq(res.stats.badLines, 0, '不该有坏行');
    // beta 源里有 13 行 JSON（session 头 + 3 轮 × 4 行，末轮 turn/end 收尾）
    assertEq(res.records.length, 13, '记录条数与源文件一致');
    assert(res.records.some((r) => r.type === 'session'), '头事件要读出来');
  } finally {
    rmDir(dir);
  }
});

test('坏块会话：撕裂帧必须被上报（不是静默跳过）', () => {
  const { dir, fx } = fixtureTree();
  try {
    const gamma = fx.sessions.find((s) => s.id === 'gamma');
    const res = readSessionLog(gamma.file);
    assert(res.stats.tornAt !== null && res.stats.tornAt !== undefined, '必须报出撕裂点偏移');
    assertEq(res.stats.badLines, 1, '那行半截 JSON 要计入坏行');
    assert(res.records.length > 0, '坏块之前的完整记录仍要读出来');
    assert(res.records.every((r) => typeof r === 'object' && r), '读出来的都得是对象');
  } finally {
    rmDir(dir);
  }
});

test('撕裂帧整帧丢弃：残字节绝不当完整帧解压', () => {
  const one = zstdCompressSync(Buffer.from('第一帧的内容\n', 'utf8'));
  const two = zstdCompressSync(Buffer.from('第二帧的内容\n', 'utf8'));
  const torn = two.subarray(0, Math.floor(two.length / 2));
  const buf = Buffer.concat([one, torn]);

  const { frames, tornAt } = splitZstdFrames(buf);
  assertEq(frames.length, 1, '只认第一帧');
  assertEq(tornAt, one.length, '撕裂点 = 第二帧起点');

  const out = readZstdBytes(buf);
  assertEq(out.text, '第一帧的内容\n', '只解出完整帧的文本');
  assertEq(out.badFrames, 0, '撕裂的那帧不计入"解压失败"（它根本没被当成帧）');
});

test('坏帧（帧结构对、解压失败）逐帧计数，不整份放弃', () => {
  // 用一段够长、可压缩的文本：短文本会被压成"原样存放块"（raw block），
  // 那样改坏负载也解不失败 —— 构造不出"解压失败"这种坏帧。
  const TEXT = '好帧内容好帧内容好帧内容\n'.repeat(6);
  const good = zstdCompressSync(Buffer.from(TEXT, 'utf8'));
  const buf = Buffer.concat([good, corruptKeepingStructure(good), good]);
  const out = readZstdBytes(buf);
  assertEq(out.frames, 3, '三帧都被认出');
  assertEq(out.badFrames, 1, '坏帧计数 1');
  assertEq(out.text, `${TEXT}${TEXT}`, '两帧好的照样解出来');
});

/**
 * 造一个「帧结构合法、但解压必然失败」的帧（模拟磁盘坏道）：
 * 逐字节往后填 0xFF，直到找到一个既让帧结构解析通过、又让解压抛错的破坏点。
 * 这样不依赖具体压缩输出的字节布局。
 */
function corruptKeepingStructure(frame) {
  for (let from = 6; from < frame.length - 1; from += 1) {
    const b = Buffer.from(frame);
    b.fill(0xff, from);
    const { frames, tornAt } = splitZstdFrames(b);
    if (tornAt !== null || frames.length !== 1) continue;
    try {
      zstdDecompressSync(b);
      continue; // 还能解出来 ⇒ 不算坏帧
    } catch {
      return b;
    }
  }
  throw new Error('没找到"结构合法但解压失败"的破坏点');
}

test('抽轮：只收真人话与想法，注入段与工具事件全丢', () => {
  const { dir, fx } = fixtureTree();
  try {
    const alpha = fx.sessions.find((s) => s.id === 'alpha');
    const res = readSessionLog(alpha.file);
    const turns = extractTurns(res.records);
    assertEq(turns.length, 2, '两轮');
    assertEq(turns[0].user.includes('潮汐画板'), true, '第一轮用户正文');
    assertEq(turns[0].reasoning.includes('别顺着名字跑题'), true, '想法要收进 reasoning');
    assertEq(turns[0].assistant.includes('潮汐画板这个名字挺好'), true, '助手正文');
    assertEq(turns[1].user.includes('暖黄色'), true, '第二轮用户正文');
    // 注入与工具输出绝不能出现
    const all = JSON.stringify(turns);
    assert(!all.includes('这段是系统注入的假记忆'), '注入段不该进轮');
    assert(!all.includes('这是一段工具输出'), '工具输出不该进轮');
  } finally {
    rmDir(dir);
  }
});

test('抽轮：没有 assistant 先说话时也能开轮；缺 source.kind 视为真人话', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'session.jsonl');
    writeJsonl(file, [
      { type: 'assistant/message', seq: 1, time: 1000, data: { message: { content: [{ type: 'text', text: '我先开口的一句话' }] } } },
      { type: 'user/message', seq: 2, time: 2000, data: { content: [{ type: 'text', text: '没有 kind 字段的老日志' }] } },
      { type: 'user/message', seq: 3, time: 3000, data: { content: [{ type: 'text', text: '注入块' }], source: { kind: 'skill-catalog' } } },
    ]);
    const turns = extractTurns(readSessionLog(file).records);
    assertEq(turns.length, 2, '两轮（assistant 自己开了一轮 + user 那轮）');
    assertEq(turns[0].assistant, '我先开口的一句话', 'assistant 先说话');
    assertEq(turns[1].user, '没有 kind 字段的老日志', '缺 kind 视为真人');
    assert(!JSON.stringify(turns).includes('注入块'), 'skill-catalog 要丢');
  } finally {
    rmDir(dir);
  }
});

test('recordText 兼容 content 数组与字符串两种形态', () => {
  assertEq(recordText({ type: 'user/message', data: { content: [{ type: 'text', text: '数组形态' }] } }), '数组形态');
  assertEq(recordText({ type: 'user/message', data: { content: '字符串形态' } }), '字符串形态');
  assertEq(
    recordText({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } } }),
    'a\nb',
    '多段拼接',
  );
  assertEq(recordText({ type: 'tool/result', data: { content: 'x' } }), '', '非消息类型给空串');
});

test('不认的文件名：明确报错，不猜', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'session.txt');
    fs.writeFileSync(file, 'hello');
    const res = readSessionLog(file);
    assertEq(res.error, 'unknown-file-name', '错误码');
    assertEq(res.records.length, 0, '不产出记录');
  } finally {
    rmDir(dir);
  }
});
