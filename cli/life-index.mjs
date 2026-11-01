#!/usr/bin/env node
// life-index.mjs —— 会话日志 → 人生记忆库（建索引 / 增量）
//
// 默认 **dry-run**：只扫、只数，一个字节都不写库。真建/真增量要显式 --apply。
// 为什么默认不写：扫的是你全部历史会话，写的是你唯一的记忆库 —— 这种命令不该
// 因为"手滑回车"就开始动真格。
//
// 三种跑法：
//   node cli/life-index.mjs                       # dry-run：看看会索引多少
//   node cli/life-index.mjs --apply               # 建库 + 建索引（幂等，重复跑只补增量）
//   node cli/life-index.mjs --apply --since-days 7
//
// 坏块处理（重要）：撕裂帧 / 解不开的帧 / 坏 JSON 行一律**计数并在结果里报出来**，
// 同时写进 sessions.note；不会静默当成"这个会话没问题"。
import path from 'node:path';
import { openDb, defaultDbPath, resolveHome, migrate } from '../lib/schema.mjs';
import { indexSessions, defaultRoots } from '../lib/store.mjs';
import { DEFAULT_CHUNK_CHARS } from '../lib/defaults.mjs';
import { parseArgs, usageExit } from '../lib/cli-args.mjs';

const USAGE = [
  'usage: node cli/life-index.mjs [选项]',
  '',
  '  --apply                 真写库（默认 dry-run：只统计，不写）',
  '  --home <目录>           DSH 数据根（默认 $DSH_HOME，再默认 ~/.dsh）',
  '  --db <文件>             库文件（默认 <home>/memory-life/life.db）',
  '  --root <目录>           额外的会话根（可重复；默认扫 <home>/sessions 与 <home>/_archived-sessions）',
  '  --since-days <N>        只处理最近 N 天内改动过的会话（0 = 不限，默认 0）',
  '  --session <id>          只处理这一个会话（调试用）',
  `  --chunk-chars <N>       单块字符上限（默认 ${DEFAULT_CHUNK_CHARS}）`,
  '  --json                  机器可读输出',
  '  --help                  只看这个帮助；不扫目录、不建库、不写任何文件',
  '',
  '退出码：0 正常 · 2 参数错误 · 3 库不可用',
].join('\n');

const parsed = parseArgs(process.argv.slice(2), {
  flags: ['apply', 'json', 'quiet'],
  values: ['home', 'db', 'since-days', 'session', 'chunk-chars'],
  multi: ['root'],
});
// 🔴 --help：不扫、不建、不写
if (parsed.help) {
  console.log(USAGE);
  process.exitCode = 0;
} else if (parsed.error) {
  usageExit(parsed.error, USAGE);
} else {
  const home = resolveHome(parsed.opts.home);
  const dbPath = parsed.opts.db ? path.resolve(String(parsed.opts.db)) : defaultDbPath(home);
  const roots = [...defaultRoots(home), ...(parsed.opts.root || []).map((r) => path.resolve(String(r)))];
  const apply = parsed.opts.apply === true;

  let db = null;
  if (apply) {
    try {
      db = await openDb(dbPath);
      migrate(db);
    } catch (e) {
      console.error(`[life-index] 库不可用：${dbPath} — ${e?.message || e}`);
      process.exitCode = 3;
    }
  }
  if (!apply || db) {
    const t0 = Date.now();
    const res = indexSessions(db, {
      roots,
      sinceDays: Number(parsed.opts.sinceDays) || 0,
      onlySession: parsed.opts.session || null,
      chunkChars: Number(parsed.opts.chunkChars) || DEFAULT_CHUNK_CHARS,
      apply,
      onSession: (info) => {
        if (parsed.opts.quiet) return;
        const flag = info.applied ? '写入' : '将写入';
        const broken = info.stats && (info.stats.tornAt !== null || info.stats.badFrames || info.stats.badLines)
          ? ` ⚠️ 坏块(tornAt=${info.stats.tornAt ?? '-'} badFrames=${info.stats.badFrames} badLines=${info.stats.badLines})`
          : '';
        console.log(`  · ${flag} ${info.id} [${info.kind}] 轮=${info.turns} 块=${info.chunks} 字=${info.chars}${broken}`);
      },
    });
    const elapsedMs = Date.now() - t0;

    let summary = null;
    if (db) {
      const g = (sql) => Number(db.prepare(sql).get().n);
      summary = {
        sessions: g('SELECT count(*) n FROM sessions'),
        chunks: g('SELECT count(*) n FROM chunks'),
        chars: g('SELECT coalesce(sum(chars),0) n FROM chunks'),
        ftsRows: g('SELECT count(*) n FROM chunks_fts'),
      };
      db.close();
    }

    if (parsed.opts.json) {
      console.log(JSON.stringify({ ...res, db: apply ? dbPath : null, apply, elapsedMs, summary }, null, 2));
    } else {
      console.log(`[life-index] ${apply ? '已写入' : 'dry-run（未写库）'} · 库=${apply ? dbPath : '(不写)'}`);
      console.log(`  扫描根：${res.roots.join(' | ')}`);
      console.log(`  发现会话目录 ${res.discovered} 个 · 本次处理 ${res.sessions} 个 · 跳过（未变/无内容/超窗口）${res.skipped} 个 · 失败 ${res.failed} 个`);
      console.log(`  块动作：keep ${res.chunks.keep} · meta ${res.chunks.meta} · upd ${res.chunks.upd} · ins ${res.chunks.ins} · del ${res.chunks.del}`);
      console.log(`  字数合计 ${res.chars} · 用时 ${elapsedMs} ms`);
      if (res.broken.torn || res.broken.badFrames || res.broken.badLines || res.broken.errors) {
        console.log(`  ⚠️ 坏块计数：撕裂帧 ${res.broken.torn} · 坏帧 ${res.broken.badFrames} · 坏行 ${res.broken.badLines} · 读取/写入失败 ${res.broken.errors}`);
        for (const p of res.problems) console.log(`     - ${p.session} (${p.file})：${JSON.stringify(p)}`);
      } else {
        console.log('  坏块：0（全部日志完整可解）');
      }
      if (summary) {
        console.log(`  库内：sessions=${summary.sessions} chunks=${summary.chunks} 字=${summary.chars} fts=${summary.ftsRows}`);
        if (summary.chunks !== summary.ftsRows) {
          console.log(`  ⚠️ chunks 与 FTS 行数不一致（${summary.chunks} vs ${summary.ftsRows}）—— 索引可能被外部改过，重跑 --apply 会补齐`);
        }
      }
      if (!apply) console.log('  （这是 dry-run；要真正建索引请加 --apply）');
    }
  }
  process.exitCode = 0;
}
