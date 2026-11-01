// session-log.mjs —— 会话日志的读取层：认得文件名、解得开压缩、抽得出「轮」
//
// 会话日志是一行一个 JSON 事件、追加写入的文件。三种形态并存于现实里：
//   session.jsonl                 明文（早期 / 手工导出 / 本仓 fixture）
//   session.jsonl.zstd            旧世代压缩名
//   session.v3.jsonl.zstd         0.1.5 世代
//   session.vN.jsonl.zstd         之后任意世代（**判据认任意 N，换代不用改代码**）
//
// 压缩文件是「一个帧接一个帧追加」的：每次 flush 压一小批事件，多个 zstd 帧首尾相连。
// 想读全，必须先把这段字节流切回帧边界（见 readZstdBytes），再逐帧解压。
// 🔴 半截帧（进程被杀 / 正在写）不许静默跳过：调用方拿到 `torn=true` 与偏移，必须计数上报。
//
// 只读，不写盘、不联网。
import fs from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** 明文会话日志名：`session.jsonl` / `session.vN.jsonl`。 */
export const PLAIN_LOG_RE = /^session(?:\.v(\d+))?\.jsonl$/;
/** 压缩会话日志名：`session.jsonl.zstd` / `session.vN.jsonl.zstd`（N 任意，未来世代也认）。 */
export const ZSTD_LOG_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/** zstd 帧魔数（小端读成 32 位无符号数）。 */
export const ZSTD_MAGIC = 0xfd2fb528;

/**
 * 文件名 → `{ kind: 'plain'|'zstd', generation }`；不认识 ⇒ null。
 * generation：旧名 = 0，`session.vN.*` = N。
 */
export function classifyLogName(name) {
  const base = String(name ?? '');
  let m = ZSTD_LOG_RE.exec(base);
  if (m) return { kind: 'zstd', generation: m[1] ? Number(m[1]) : 0 };
  m = PLAIN_LOG_RE.exec(base);
  if (m) return { kind: 'plain', generation: m[1] ? Number(m[1]) : 0 };
  return null;
}

/** 一个目录里的会话日志候选（只 stat，不读内容）。 */
export function listLogsInDir(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of ents) {
    if (!e.isFile()) continue;
    const kindInfo = classifyLogName(e.name);
    if (!kindInfo) continue;
    const full = path.join(dir, e.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    out.push({ file: full, name: e.name, bytes: st.size, mtimeMs: Math.round(st.mtimeMs), ...kindInfo });
  }
  return out;
}

/**
 * 挑「当前那份」日志：mtime 最新 → 平局取代际大者 → 再平局取名字典序小者（确定性）。
 *
 * ⚠️ 「当前那份」不等于「内容最全的那份」：换代时新名文件可能只是补写壳（几十字节），
 * 完整对话还在旧名文件里。本仓的做法是「主读当前那份」，并在 `listLogsInDir` 的结果里
 * 保留全部候选 —— 需要"内容最全"的调用方可以按 bytes 再挑一次。
 */
export function pickCurrentLog(dir) {
  const logs = listLogsInDir(dir);
  if (!logs.length) return null;
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs || b.generation - a.generation || (a.name < b.name ? -1 : 1));
  return logs[0];
}

/* ───────────────────────────── zstd 帧切分 ───────────────────────────── */

const BLOCK_HEADER_BYTES = 3;

/**
 * 从一个帧起点算出「这一帧到哪儿结束」。
 * 帧结构（RFC 8878）：magic(4) · 帧头描述符(1) · [window 描述符] · [字典 id] ·
 * [内容长度] · 若干 block（每块 3 字节头 + 负载）· [4 字节校验]。
 * 返回 null 表示这个位置不是帧 / 帧残缺 ⇒ 调用方记为撕裂点，**绝不猜长度补齐**。
 */
function frameEndAt(buf, at) {
  if (buf.length - at < 4) return null;
  if (buf.readUInt32LE(at) !== ZSTD_MAGIC) return null;
  let p = at + 4;
  if (p >= buf.length) return null;
  const descriptor = buf.readUInt8(p);
  p += 1;
  // 保留位：帧头里 bit3/bit4 必须为 0，否则不是我们认识的帧
  if (descriptor & 0b1_1000) return null;
  const singleSegment = (descriptor & 0b10_0000) !== 0;
  const checksum = (descriptor & 0b100) !== 0;
  const contentSizeFlag = descriptor >>> 6;
  const dictFlag = descriptor & 0b11;
  const dictBytes = dictFlag === 0b11 ? 4 : dictFlag;
  // flag=0 时：单段帧固定 1 字节内容长度，非单段帧干脆不写这个字段
  const contentBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  p += (singleSegment ? 0 : 1) + dictBytes + contentBytes;
  if (p > buf.length) return null;

  for (;;) {
    if (buf.length - p < BLOCK_HEADER_BYTES) return null;
    const header = buf.readUIntLE(p, BLOCK_HEADER_BYTES);
    p += BLOCK_HEADER_BYTES;
    const last = (header & 0b1) !== 0;
    const type = (header >>> 1) & 0b11;
    const size = header >>> 3;
    if (type === 3) return null; // 保留类型：帧头已经错了
    p += type === 1 ? 1 : size; // RLE 块在流里只占 1 字节
    if (p > buf.length) return null;
    if (last) break;
  }
  if (checksum) {
    p += 4;
    if (p > buf.length) return null;
  }
  return p;
}

/**
 * 把一块缓冲切成完整帧。
 * @returns {{frames:{start:number,end:number}[], tornAt:number|null}}
 *   tornAt = 第一处残缺帧的起点；null 表示整块都完整。
 */
export function splitZstdFrames(buf) {
  const frames = [];
  let at = 0;
  while (at < buf.length) {
    const end = frameEndAt(buf, at);
    if (end === null) return { frames, tornAt: at };
    frames.push({ start: at, end });
    at = end;
  }
  return { frames, tornAt: null };
}

/**
 * 解压一块 zstd 字节流（可含多帧）为文本。
 * 帧级失败逐帧计数，不整份放弃；撕裂帧整帧丢弃并上报偏移。
 */
export function readZstdBytes(buf) {
  if (typeof zstdDecompressSync !== 'function') {
    const err = new Error('当前 Node 没有 node:zlib 的 zstd 支持（需要 Node ≥ 22.15 或 ≥ 23.8）；明文 .jsonl 仍可索引');
    err.code = 'NO_ZSTD';
    throw err;
  }
  const { frames, tornAt } = splitZstdFrames(buf);
  const parts = [];
  let badFrames = 0;
  for (const f of frames) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'));
    } catch {
      badFrames += 1;
    }
  }
  return { text: parts.join(''), frames: frames.length, badFrames, tornAt };
}

/* ───────────────────────────── 读一份日志 ───────────────────────────── */

/**
 * 读一个会话日志文件。
 * @param {string} file
 * @returns {{file:string, kind:string, records:object[], stats:object, error?:string}}
 */
export function readSessionLog(file) {
  const base = path.basename(String(file));
  const kindInfo = classifyLogName(base);
  const stats = {
    kind: kindInfo ? kindInfo.kind : 'unknown',
    generation: kindInfo ? kindInfo.generation : null,
    bytes: 0,
    frames: 0,
    tornAt: null,
    badFrames: 0,
    badLines: 0,
    lines: 0,
  };
  if (!kindInfo) return { file, kind: 'unknown', records: [], stats, error: 'unknown-file-name' };

  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { file, kind: kindInfo.kind, records: [], stats, error: `read:${e?.code || e?.message || e}` };
  }
  stats.bytes = buf.length;

  let text;
  if (kindInfo.kind === 'zstd') {
    try {
      const z = readZstdBytes(buf);
      text = z.text;
      stats.frames = z.frames;
      stats.badFrames = z.badFrames;
      stats.tornAt = z.tornAt;
    } catch (e) {
      return { file, kind: 'zstd', records: [], stats, error: `zstd:${e?.code || e?.message || e}` };
    }
  } else {
    text = buf.toString('utf8');
  }

  const records = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    stats.lines += 1;
    try {
      records.push(JSON.parse(t));
    } catch {
      stats.badLines += 1;
    }
  }
  return { file, kind: kindInfo.kind, records, stats };
}

/* ───────────────────────────── 记录 → 轮 ───────────────────────────── */

/**
 * 会被当成「注入」丢掉的 `data.source.kind`。
 * 这些不是人说的话：时间上下文、技能目录、运行时快照、记忆召回段、工具任务、坑提醒、注入指令。
 * 🔴 这是一张封闭清单：将来出现新的注入 kind，本表不认它 ⇒ 会被当人话收进来。
 *    发现新形态就往这里加一条，别改判断方向。
 */
export const INJECTION_SOURCE_KINDS = Object.freeze([
  'time-context',
  'skill-catalog',
  'runtime-context',
  'memory-recall',
  'tool-jobs',
  'l3-pitfall-reminder',
  'agent-instructions',
  'life-memory',
  'postcard-notice',
]);

function textPartsOf(value) {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((c) => c && typeof c.text === 'string').map((c) => c.text);
}

/** 取一条消息记录里的正文（user 在 data.content，assistant 在 data.message.content）。 */
export function recordText(rec) {
  if (!rec || typeof rec !== 'object') return '';
  if (rec.type === 'assistant/message') return textPartsOf(rec?.data?.message?.content).join('\n').trim();
  if (rec.type === 'user/message') return textPartsOf(rec?.data?.content).join('\n').trim();
  // 🔴 其余事件（tool/call、tool/result、turn/start…）不是"谁说的话"，一律给空串：
  //    它们的 data.content 里可能装着长文，漏出去就变成"我根本没说过的原话"。
  return '';
}

/**
 * 记录流 → 轮数组。
 * 一轮 = 一条真人输入（以及在它之后、下一条真人输入之前的助手发言与想法）。
 * 只收真人 user 正文 + assistant 正文 + assistant 想法；工具输出 / 注入段一律不进。
 * @returns {{ts:number|null, turnNo:number|null, user:string, assistant:string, reasoning:string}[]}
 */
export function extractTurns(records) {
  const turns = [];
  let cur = null;
  const open = (rec) => {
    cur = { ts: Number(rec?.time ?? 0) || null, turnNo: Number.isFinite(Number(rec?.data?.turn)) ? Number(rec.data.turn) : null, user: '', assistant: '', reasoning: '' };
    turns.push(cur);
  };
  for (const rec of Array.isArray(records) ? records : []) {
    if (rec?.type === 'user/message') {
      const kind = rec?.data?.source?.kind;
      // kind 缺省 ⇒ 当真人（老日志没有这个字段）；明确是注入 ⇒ 丢
      if (typeof kind === 'string' && INJECTION_SOURCE_KINDS.includes(kind.trim())) continue;
      const text = recordText(rec);
      if (!text) continue;
      open(rec);
      cur.user = text;
      continue;
    }
    if (rec?.type === 'assistant/message') {
      const msg = rec?.data?.message;
      if (!msg || !Array.isArray(msg.content)) continue;
      const said = msg.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
      const thought = msg.content.filter((c) => c && c.type === 'reasoning' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
      if (!said && !thought) continue;
      if (!cur) open(rec);
      if (said) cur.assistant += (cur.assistant ? '\n' : '') + said;
      if (thought) cur.reasoning += (cur.reasoning ? '\n' : '') + thought;
    }
  }
  return turns.filter((t) => t.user || t.assistant || t.reasoning);
}

/* ───────────────────────────── 扫树 ───────────────────────────── */

/**
 * 递归找出「含会话日志的目录」（一个目录 = 一个会话）。
 * 不跟随软链（`withFileTypes` 的 isDirectory 对 junction 为 false ⇒ 天然不进去）。
 * @returns {{dir:string, id:string, root:string, source:string}[]} 按 dir 字典序
 */
export function findSessionDirs(roots) {
  const out = [];
  const seen = new Set();
  for (const rootSpec of Array.isArray(roots) ? roots : [roots]) {
    const root = path.resolve(String(rootSpec));
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      let ents;
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      const logs = ents.filter((e) => e.isFile() && classifyLogName(e.name));
      if (logs.length) {
        let key;
        try {
          key = fs.realpathSync(d);
        } catch {
          key = d;
        }
        if (!seen.has(key)) {
          seen.add(key);
          const id = path.basename(d).replace(/^session-/, '');
          out.push({ dir: d, id, root, source: sourceOf(root) });
        }
        continue; // 会话目录不再往下钻（会话文件就在这一层）
      }
      for (const e of ents) if (e.isDirectory()) stack.push(path.join(d, e.name));
    }
  }
  out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return out;
}

/**
 * 「这条会话是从哪儿来的」：默认本机；额外根路径里若含 `peer/<名字>/` 段，
 * 就用那个名字做来源标记（多机共用一本账时用来区分，单机永远只有 `local`）。
 */
export function sourceOf(root) {
  const parts = path.resolve(String(root)).split(path.sep);
  const i = parts.lastIndexOf('peer');
  if (i >= 0 && parts[i + 1]) return parts[i + 1];
  return 'local';
}
