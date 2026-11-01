#!/usr/bin/env node
// life-recall.mjs —— 按需召回：问一句话，从旧会话原话里捞回几段
//
// 输出两种形态：
//   人读（默认）：命中块 + 该会话的上下文（前后各几块）+ 原文片段
//   --json：机器可读（含每块的通道、分数、时间、来源）
//
// 只读打开库；库不存在 ⇒ 退出码 3 + 一句人话提示（不自动建库：查询不该改盘）。
import path from 'node:path';
import { openDb, defaultDbPath, resolveHome } from '../lib/schema.mjs';
import { recall, formatTime, buildMatchExpr } from '../lib/recall-core.mjs';
import { DEFAULT_MAX_CHARS, DEFAULT_TOP_K, DEFAULT_TZ_OFFSET_MINUTES } from '../lib/defaults.mjs';
import { parseArgs, usageExit } from '../lib/cli-args.mjs';

const USAGE = [
  'usage: node cli/life-recall.mjs "<查询>" [--top N] [--max-chars N] [--context N] [--json] [--help]',
  '',
  '  --home <目录>        DSH 数据根（默认 $DSH_HOME，再默认 ~/.dsh）',
  '  --db <文件>          库文件（默认 <home>/memory-life/life.db）',
  `  --top <N>            最多几段（默认 ${DEFAULT_TOP_K}）`,
  `  --max-chars <N>      注入预算（默认 ${DEFAULT_MAX_CHARS} 字）`,
  '  --context <N>        命中块前后各取几块当上下文（默认 1）',
  '  --tz-offset <分钟>   时间显示的时区偏移（默认 480 = UTC+8）',
  '  --json               机器可读输出',
  '  --help               只看这个帮助；不读库、不写任何文件',
  '',
  '退出码：0 有命中 · 1 无命中 · 2 参数错误 · 3 库不可用',
].join('\n');

const parsed = parseArgs(process.argv.slice(2), {
  flags: ['json'],
  values: ['home', 'db', 'top', 'max-chars', 'context', 'tz-offset'],
});
if (parsed.help) {
  console.log(USAGE);
  process.exitCode = 0;
} else if (parsed.error) {
  usageExit(parsed.error, USAGE);
} else {
  const query = (parsed.opts._ || []).join(' ').trim();
  if (!query) {
    usageExit('缺少查询串：把想问的那句话写在引号里', USAGE);
  } else {
    const home = resolveHome(parsed.opts.home);
    const dbPath = parsed.opts.db ? path.resolve(String(parsed.opts.db)) : defaultDbPath(home);
    const topK = Math.max(1, Math.floor(Number(parsed.opts.top) || DEFAULT_TOP_K));
    const maxChars = Math.max(80, Math.floor(Number(parsed.opts.maxChars) || DEFAULT_MAX_CHARS));
    const ctxN = Math.max(0, Math.floor(Number(parsed.opts.context ?? 1)) || 0);
    const tz = parsed.opts.tzOffset === undefined ? DEFAULT_TZ_OFFSET_MINUTES : Number(parsed.opts.tzOffset);

    let db = null;
    try {
      db = await openDb(dbPath, { readOnly: true });
    } catch (e) {
      console.error(`[life-recall] ${e?.message || e}`);
      process.exitCode = 3;
    }
    if (db) {
      try {
        const res = recall(db, query, { topK, maxChars, tzOffsetMinutes: tz });
        const plan = buildMatchExpr(query);
        const ctxStmt = db.prepare('SELECT id, ts, role, kind, text FROM chunks WHERE session_id=? AND id BETWEEN ? AND ? ORDER BY ord');
        const withCtx = res.hits.map((h) => ({
          ...h,
          context:
            ctxN > 0
              ? ctxStmt
                  .all(h.session_id, h.id - 10, h.id + 10)
                  .filter((c) => c.id !== h.id)
                  .slice(0, ctxN * 2)
                  .map((c) => ({ id: Number(c.id), ts: c.ts, role: c.role, kind: c.kind, text: String(c.text ?? '').slice(0, 160) }))
              : [],
        }));

        if (parsed.opts.json) {
          console.log(
            JSON.stringify(
              {
                query,
                db: dbPath,
                strategy: plan ? plan.strategy : null,
                matchExpr: plan ? plan.expr : null,
                reason: res.reason,
                hits: withCtx,
                text: res.text,
              },
              null,
              2,
            ),
          );
        } else if (!res.hits.length) {
          console.log(`查询：「${query}」 · 无命中（${res.reason}）`);
        } else {
          console.log(`查询：「${query}」 · 命中 ${res.hits.length} 段 · 词法=${plan ? plan.strategy : '-'} · 表达式=${plan ? plan.expr : '-'}\n`);
          withCtx.forEach((h, i) => {
            const who = h.role === 'user' ? '用户' : '助手';
            const kindTag = h.kind === 'reasoning' ? '（当时的想法）' : '';
            console.log(`── [${i + 1}] ${formatTime(h.ts, tz)} · ${String(h.session_id).slice(0, 8)} · ${h.source} · ${who}${kindTag}`);
            console.log(`   ${String(h.text).split('\n')[0].slice(0, 200)}`);
            if (h.context.length) {
              console.log('   上下文：');
              for (const c of h.context) {
                const w = c.role === 'user' ? '用户' : '助手';
                const k = c.kind === 'reasoning' ? '想' : '说';
                console.log(`     ${formatTime(c.ts, tz).slice(11)} ${w}·${k} ${String(c.text).split('\n')[0].slice(0, 90)}`);
              }
            }
            console.log('');
          });
          if (res.text) {
            console.log('—— 直接可注入的形态（插件每轮注入的就是这一段）——');
            console.log(res.text);
          }
        }
        process.exitCode = res.hits.length ? 0 : 1;
      } finally {
        db.close();
      }
    }
  }
}
