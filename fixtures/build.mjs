// build.mjs —— 用仓库里的明文语料，造出「三种形态」的假会话树
//
// 为什么要生成而不是直接提交二进制：zstd 文件进 git 就是二进制黑盒，谁也看不懂它里面
// 装了什么。所以仓里只存**明文 JSONL**（人可读、可审），压缩与"坏块"由本脚本按固定内容
// 现场造出来 —— 生成结果可复现（无时间戳、无随机数）。
//
// 造三份，正好覆盖现实里会遇到的三种文件：
//   alpha  明文 session.jsonl                     —— 早期 / 手工导出
//   beta   session.v4.jsonl.zstd（**多帧**）       —— 现行世代：一帧一批事件
//   gamma  session.v4.jsonl.zstd（含坏块 + 撕裂帧）—— 进程被杀 / 正在写的现场
//
// 输出目录结构模拟 DSH 数据根：`<dest>/sessions/<workspace>/session-<id>/<file>`。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RAW_DIR = path.join(HERE, 'raw');
export const DEFAULT_DEST = path.join(HERE, 'build');

/** 三份假会话的说明（测试与文档共用这一份清单）。 */
export const FIXTURE_SPEC = Object.freeze([
  {
    id: 'alpha',
    workspace: 'demo-workspace',
    raw: 'session-alpha.jsonl',
    fileName: 'session.jsonl',
    shape: 'plain',
    note: '明文日志；含一条注入的 user 消息（kind=memory-recall）与一段工具输出，两者都不该进索引',
  },
  {
    id: 'beta',
    workspace: 'demo-workspace',
    raw: 'session-beta.jsonl',
    fileName: 'session.v4.jsonl.zstd',
    shape: 'zstd-frames',
    frames: 3,
    note: '多帧压缩（3 帧）；现行世代文件名',
  },
  {
    id: 'gamma',
    workspace: 'demo-workspace',
    raw: 'session-gamma.jsonl',
    fileName: 'session.v4.jsonl.zstd',
    shape: 'zstd-broken',
    note: '两帧完整 + 1 行坏 JSON + 末尾一个撕裂帧；坏块必须被计数上报，不能静默跳过',
  },
]);

function frameOf(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'));
}

/** 把一份明文按行切成 n 段，每段压成一帧，再首尾拼接（= 现实中追加写入的形态）。 */
function frameSplit(text, n) {
  const lines = text.split('\n').filter((l) => l.trim());
  const per = Math.max(1, Math.ceil(lines.length / n));
  const chunks = [];
  for (let i = 0; i < lines.length; i += per) chunks.push(frameOf(lines.slice(i, i + per).join('\n') + '\n'));
  return Buffer.concat(chunks);
}

/**
 * 造全部 fixture。
 * @param {{destDir?:string, rawDir?:string}} [opts]
 * @returns {{root:string, sessionsDir:string, sessions:object[]}}
 */
export function buildFixtures(opts = {}) {
  const dest = path.resolve(String(opts.destDir || DEFAULT_DEST));
  const rawDir = path.resolve(String(opts.rawDir || RAW_DIR));
  fs.rmSync(dest, { recursive: true, force: true });
  const sessionsDir = path.join(dest, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const made = [];
  for (const spec of FIXTURE_SPEC) {
    const rawPath = path.join(rawDir, spec.raw);
    const text = fs.readFileSync(rawPath, 'utf8');
    const dir = path.join(sessionsDir, spec.workspace, `session-${spec.id}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, spec.fileName);
    const row = { ...spec, dir, file, bytes: 0 };

    if (spec.shape === 'plain') {
      fs.writeFileSync(file, text, 'utf8');
    } else if (spec.shape === 'zstd-frames') {
      fs.writeFileSync(file, frameSplit(text, spec.frames || 3));
    } else if (spec.shape === 'zstd-broken') {
      const lines = text.split('\n').filter((l) => l.trim());
      // ① 第一帧里塞一行坏 JSON（模拟写了一半被中断的既成事实）
      const cut = Math.ceil(lines.length / 2);
      const first = `${lines.slice(0, cut).join('\n')}\n{"type":"user/message","seq":999,"data":{"content":[{"type":"text"`;
      const second = `${lines.slice(cut).join('\n')}\n`;
      // ② 末尾再拼一个"只写了一半"的帧：解压必然失败 / 帧头解析判定撕裂
      const tornSource = frameOf('{"type":"assistant/message","seq":1000,"data":{"message":{"role":"assistant","content":[{"type":"text","text":"这半句话被截断了，读不到结尾。"}]}}}\n');
      const torn = tornSource.subarray(0, Math.max(8, Math.floor(tornSource.length * 0.6)));
      fs.writeFileSync(file, Buffer.concat([frameOf(first), frameOf(second), torn]));
      row.expect = { badLines: 1, tornAt: true, badFrames: 0 };
    } else {
      throw new Error(`未知 fixture 形态：${spec.shape}`);
    }
    row.bytes = fs.statSync(file).size;
    made.push(row);
  }
  return { root: dest, sessionsDir, sessions: made };
}

/** 直接跑：`node fixtures/build.mjs [--dest <目录>]` */
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const i = process.argv.indexOf('--dest');
  const dest = i > 0 ? process.argv[i + 1] : undefined;
  const res = buildFixtures({ destDir: dest });
  console.log(`[fixtures] 已生成到 ${res.root}`);
  for (const s of res.sessions) {
    console.log(`  · ${s.id} · ${s.shape} · ${s.fileName} · ${s.bytes} B · ${s.dir}`);
  }
}
