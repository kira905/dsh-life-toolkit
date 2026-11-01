// chunker.mjs —— 把「轮」切成「块」
//
// 为什么要切：一段会话动辄几万字，整段塞进索引会一查一大坨、注入时也塞不下。
// 切成 ~1,200 字一块，召回时只捡真正命中的那一小段，上下文预算才够用。
//
// 切法（三条，按优先级）：
//   ① 按字符数算长度，不按字节 —— 中文一个字算一个，代理对（emoji）算一个，
//      否则切出半个 emoji，注入出去就是乱码；
//   ② 优先在换行处断开（一段一块，读起来才像原话）；
//   ③ 单行超长就在行内硬切（代码块 / 长命令不能被整段丢掉）。
//
// 块的身份：一条块 = (session_id, ord)；ord 是会话内从 0 递增的全局序号。
// turn_no / ts / role / kind 是给它挂的坐标，方便召回后说「这是第几轮、什么时候、谁说的」。
import { DEFAULT_CHUNK_CHARS } from './defaults.mjs';

/** 按字符数切成不超过 max 的若干段（行优先）。 */
export function splitText(text, max = DEFAULT_CHUNK_CHARS) {
  const cap = Math.max(16, Math.floor(Number(max) || DEFAULT_CHUNK_CHARS));
  const s = String(text ?? '');
  if (!s) return [];
  const points = [...s];
  if (points.length <= cap) return [s];

  const out = [];
  let buf = '';
  let bufLen = 0;
  const flush = () => {
    if (buf) out.push(buf);
    buf = '';
    bufLen = 0;
  };
  for (const line of s.split('\n')) {
    const chars = [...line];
    if (bufLen + chars.length + (bufLen ? 1 : 0) > cap) {
      flush();
      if (chars.length > cap) {
        for (let i = 0; i < chars.length; i += cap) out.push(chars.slice(i, i + cap).join(''));
        continue;
      }
    }
    buf = buf ? `${buf}\n${line}` : line;
    bufLen = [...buf].length;
  }
  flush();
  return out;
}

/**
 * 轮数组 → 块数组（可直接入库）。
 * @param {{ts:number|null, turnNo:number|null, user:string, assistant:string, reasoning:string}[]} turns
 * @param {{chunkChars?:number}} [opts]
 * @returns {{ord:number, turn_no:number|null, ts:number|null, role:string, kind:string, text:string, chars:number}[]}
 */
export function buildChunks(turns, opts = {}) {
  const cap = Math.max(16, Math.floor(Number(opts.chunkChars) || DEFAULT_CHUNK_CHARS));
  const rows = [];
  let ord = 0;
  for (const t of Array.isArray(turns) ? turns : []) {
    const parts = [
      ['user', 'text', t.user],
      ['assistant', 'text', t.assistant],
      ['assistant', 'reasoning', t.reasoning],
    ];
    for (const [role, kind, body] of parts) {
      if (!body) continue;
      for (const piece of splitText(body, cap)) {
        rows.push({
          ord: ord++,
          turn_no: t.turnNo ?? null,
          ts: t.ts ?? null,
          role,
          kind,
          text: piece,
          chars: [...piece].length,
        });
      }
    }
  }
  return rows;
}
