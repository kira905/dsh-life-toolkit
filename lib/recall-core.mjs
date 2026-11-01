// recall-core.mjs —— 召回：把当前这句话，变成"从旧原话里捞回哪几段"
//
// 三步，纯函数 + 一个只读查询，好测：
//   ① buildMatchExpr：查询串 → FTS5 的 MATCH 表达式
//   ② searchChunks：执行查询，拿回若干块（只捡 kind='text'，不捡思考链）
//   ③ renderRecallBlock：命中块 → 注入用的那段文字（带时间、谁说的、原话第一行）
//
// 为什么长句要切 4 字窗口做 OR（短句整句当短语）：
//   trigram 索引下，整句短语 = 要求用户这句话在旧话里逐字出现过。日常提问常带
//   "你还记得…吗""帮我看看"这种套话，整句匹配直接 0 命中；切成 4 字窗口取几个中段
//   做 OR，让 bm25 去排序，命中率立刻回来。这不是"模糊匹配凑数"，是让排序器干活。
//
// 失败一律降级，不抛：召回是"顺手想起点什么"，它挂了也不能影响本轮对话。
import {
  DEDUPE_PREFIX_CHARS,
  DEFAULT_MAX_CHARS,
  DEFAULT_TOP_K,
  DEFAULT_TZ_OFFSET_MINUTES,
  GRAM_COUNT,
  GRAM_SIZE,
  GRAM_START_RATIO,
  MIN_QUERY_CHARS,
  PHRASE_QUERY_CHARS,
} from './defaults.mjs';

/** 系统类消息的识别词：这些不是"我在问你"，捞旧话只会捞出一堆不相干的通知。 */
export const SYSTEM_MARKERS = Object.freeze([
  '自动通知',
  '自动提醒',
  '上下文看门',
  '队列推进',
  '无需回复',
  '本条为自动',
  '刚完成重启',
  '重启完成',
]);

/** 是不是系统通知（是就不召回）。 */
export function isSystemishQuery(text) {
  const t = String(text ?? '');
  if (!t) return false;
  return SYSTEM_MARKERS.some((m) => t.includes(m));
}

/**
 * 查询串 → MATCH 表达式。
 * @returns {{expr:string, strategy:'phrase'|'grams'}|null} null = 这句话不该查（太短 / 清洗后为空）
 */
export function buildMatchExpr(query) {
  // 只保留汉字、字母、数字：FTS 的语法字符（引号、AND、OR、*、括号）出现在用户句子里
  // 会把 MATCH 表达式整个搞坏，清洗掉最省事，也不会误伤（这些字符本身不承载语义）。
  const clean = String(query ?? '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  if (clean.length < MIN_QUERY_CHARS) return null;
  if (clean.length <= PHRASE_QUERY_CHARS) {
    return { expr: `"${clean}"`, strategy: 'phrase' };
  }
  const grams = [];
  for (let i = 0; i + GRAM_SIZE <= clean.length; i += 1) grams.push(clean.slice(i, i + GRAM_SIZE));
  const start = Math.max(0, Math.floor(grams.length * GRAM_START_RATIO));
  const picked = grams.slice(start, start + GRAM_COUNT);
  if (!picked.length) return { expr: `"${clean}"`, strategy: 'phrase' };
  return { expr: picked.map((g) => `"${g}"`).join(' OR '), strategy: 'grams' };
}

/**
 * 查库。只读、失败返回空数组。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} query
 * @param {{topK?:number, dedupe?:boolean}} [opts]
 * @returns {Array<{id:number, session_id:string, ts:number|null, role:string, kind:string,
 *                  text:string, source:string, score:number}>}
 */
export function searchChunks(db, query, opts = {}) {
  const plan = buildMatchExpr(query);
  if (!plan) return [];
  const topK = Math.max(1, Math.floor(Number(opts.topK) || DEFAULT_TOP_K));
  const limit = Math.max(topK * 4, 12);
  const sql = `
    SELECT c.id, c.session_id, c.ts, c.role, c.kind, c.text,
           coalesce(s.source,'local') AS source,
           bm25(chunks_fts) AS score
    FROM chunks_fts f
    JOIN chunks c ON c.id = f.rowid
    LEFT JOIN sessions s ON s.id = c.session_id
    WHERE chunks_fts MATCH ?
      AND c.kind = 'text'
    ORDER BY bm25(chunks_fts)
    LIMIT ?`;
  let rows = [];
  try {
    rows = db.prepare(sql).all(plan.expr, limit);
  } catch {
    // FTS 表达式仍不合语法（极少数符号组合）⇒ 退回字面包含，慢但能出结果
    try {
      const clean = String(query).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
      rows = db
        .prepare(
          `SELECT c.id, c.session_id, c.ts, c.role, c.kind, c.text,
                  coalesce(s.source,'local') AS source, 0 AS score
           FROM chunks c LEFT JOIN sessions s ON s.id = c.session_id
           WHERE c.kind='text' AND c.text LIKE ?
           ORDER BY c.ts DESC LIMIT ?`,
        )
        .all(`%${clean}%`, limit);
    } catch {
      return [];
    }
  }
  const hits = rows.map((r) => ({
    id: Number(r.id),
    session_id: String(r.session_id ?? ''),
    ts: r.ts === null || r.ts === undefined ? null : Number(r.ts),
    role: String(r.role ?? ''),
    kind: String(r.kind ?? ''),
    text: String(r.text ?? ''),
    source: String(r.source ?? 'local'),
    score: Number(r.score ?? 0),
  }));
  const deduped = opts.dedupe === false ? hits : dedupeHits(hits, opts.dedupePrefixChars);
  return deduped.slice(0, topK);
}

/** 同一段原话在多个会话里都出现过 ⇒ 只留第一条（前缀比对，够用且便宜）。 */
export function dedupeHits(hits, prefixChars = DEDUPE_PREFIX_CHARS) {
  const n = Math.max(8, Math.floor(Number(prefixChars) || DEDUPE_PREFIX_CHARS));
  const seen = new Set();
  const out = [];
  for (const h of Array.isArray(hits) ? hits : []) {
    const key = String(h.text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/** 时间戳 → `YYYY-MM-DD HH:MM`（固定偏移，输出可复现）。 */
export function formatTime(ms, tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '时间未知';
  const shifted = new Date(t + Number(tzOffsetMinutes) * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}`;
}

/** 命中块的第一行正文（注入时只要一行：多行会把预算吃光，也会把后面的块挤掉）。 */
export function firstLine(text) {
  return String(text ?? '').split('\n').map((s) => s.trim()).find((s) => s) || '';
}

/** 标题行（注入段的固定开头）。 */
export const RECALL_HEADER =
  '[人生记忆·旧会话片段] 下面是从我以前的会话原文里找回来的（不是记忆摘要，是原话），可能和现在这句有关：';

/**
 * 命中块 → 注入文本。
 * 预算（maxChars）从标题行开始算，装不下的整行跳过，绝不截半句。
 * @param {object[]} hits
 * @param {{maxChars?:number, labels?:{user?:string,assistant?:string}, tzOffsetMinutes?:number,
 *          header?:string, withSource?:boolean}} [opts]
 */
export function renderRecallBlock(hits, opts = {}) {
  const budget = Math.max(80, Math.floor(Number(opts.maxChars) || DEFAULT_MAX_CHARS));
  const labels = { user: '用户', assistant: '助手', ...(opts.labels || {}) };
  const tz = opts.tzOffsetMinutes === undefined ? DEFAULT_TZ_OFFSET_MINUTES : Number(opts.tzOffsetMinutes);
  const header = opts.header === undefined ? RECALL_HEADER : String(opts.header);
  const withSource = opts.withSource !== false;

  const lines = [];
  let used = header.length + 1;
  for (const h of Array.isArray(hits) ? hits : []) {
    const body = firstLine(h.text);
    if (!body) continue;
    const who = labels[h.role] || h.role || '未知';
    const src = withSource && h.source && h.source !== 'local' ? ` · ${h.source}` : '';
    const line = `- ${formatTime(h.ts, tz)}${src} · ${who}：${body}`;
    if (used + line.length + 1 > budget) continue;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  return `${header}\n${lines.join('\n')}`;
}

/** 一条查询走完全链（CLI / 插件 / 测试共用）。 */
export function recall(db, query, opts = {}) {
  if (isSystemishQuery(query)) return { query, hits: [], text: '', reason: 'system-message' };
  const plan = buildMatchExpr(query);
  if (!plan) return { query, hits: [], text: '', reason: 'query-too-short' };
  const hits = searchChunks(db, query, { topK: opts.topK });
  const text = renderRecallBlock(hits, opts);
  return { query, strategy: plan.strategy, hits, text, reason: text ? 'ok' : 'no-hits' };
}
