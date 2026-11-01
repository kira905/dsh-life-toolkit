// store.mjs —— 索引写入：会话日志 → chunks + FTS
//
// 增量策略（两层，越靠前越便宜）：
//   ① 文件没变就不解压：库内 sessions.mtime_ms + bytes 与磁盘一致 ⇒ 直接跳过。
//   ② 文件变了就得重算，但**块 id 尽量不动**：会话日志是追加型文件，内容几乎总是
//      "前面一模一样 + 尾巴长了一截"。所以按「双端收缩」配对：
//        先比开头，能对上多少块对上多少；再从末尾往回比同样多；
//        中间对不上的那一段按位置一一更新，多出来的删、新出现的是插。
//      ⇒ 纯追加 = 全是 keep + 尾部几条 ins；尾部补全一段 = 前缀 keep + 中间 upd。
//
// 为什么不用整段 DELETE + 整段 INSERT（很多实现这么写）：块 id 会被全部换掉，
// 任何"引用过某块"的东西（命中留痕、手工摘录、将来接上的向量表）全部变成悬空 id。
// 增量只花一点计算量，换来 id 稳定，值。
//
// 坏块：撕裂帧 / 坏 JSON 行 / 解不开的帧 —— 一律**计数并写进 sessions.note**，
// 绝不静默跳过：少一块不报，等到"我记得明明聊过这句"的时候才发现，就晚了。
import fs from 'node:fs';
import path from 'node:path';
import { findSessionDirs, pickCurrentLog, readSessionLog, extractTurns } from './session-log.mjs';
import { buildChunks } from './chunker.mjs';
import { DEFAULT_CHUNK_CHARS } from './defaults.mjs';

/**
 * 把一次会话的块表同步进库（调用方负责事务）。
 * @returns {{keep:number, meta:number, upd:number, ins:number, del:number}}
 */
export function syncSessionChunks(db, sessionId, rows, nowMs = Date.now()) {
  const stat = { keep: 0, meta: 0, upd: 0, ins: 0, del: 0 };
  const selOld = db.prepare('SELECT id, ord, turn_no, ts, text FROM chunks WHERE session_id=? ORDER BY ord, id');
  const updMeta = db.prepare('UPDATE chunks SET ord=?, turn_no=?, ts=? WHERE id=?');
  const updText = db.prepare('UPDATE chunks SET ord=?, turn_no=?, ts=?, text=?, chars=? WHERE id=?');
  const insChunk = db.prepare(
    'INSERT INTO chunks(session_id, turn_no, ts, role, kind, ord, text, chars, created_ms) VALUES(?,?,?,?,?,?,?,?,?)',
  );
  const delChunk = db.prepare('DELETE FROM chunks WHERE id=?');
  const insFts = db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES(?,?)');
  const updFts = db.prepare('UPDATE chunks_fts SET text=? WHERE rowid=?');
  const delFts = db.prepare('DELETE FROM chunks_fts WHERE rowid=?');

  const old = selOld.all(sessionId);

  // ① 双端收缩：先吃前缀，再吃后缀（两段不能重叠）
  let head = 0;
  while (head < old.length && head < rows.length && old[head].text === rows[head].text) head += 1;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < rows.length - head &&
    old[old.length - 1 - tail].text === rows[rows.length - 1 - tail].text
  ) {
    tail += 1;
  }

  // ② 保住的两段：只可能"挪位置"，文本没变 ⇒ 不碰 FTS
  const keepRange = (oldFrom, oldTo, newFrom) => {
    for (let k = 0; k < oldTo - oldFrom; k += 1) {
      const o = old[oldFrom + k];
      const r = rows[newFrom + k];
      if (o.ord === r.ord && o.turn_no === (r.turn_no ?? null) && o.ts === (r.ts ?? null)) stat.keep += 1;
      else {
        updMeta.run(r.ord, r.turn_no ?? null, r.ts ?? null, o.id);
        stat.meta += 1;
      }
    }
  };
  keepRange(0, head, 0);
  keepRange(old.length - tail, old.length, rows.length - tail);

  // ③ 中间对不上的：按位置配对，同一位置文本不同 ⇒ 改写（连带 FTS）
  const oldMid = old.slice(head, old.length - tail);
  const newMid = rows.slice(head, rows.length - tail);
  const paired = Math.min(oldMid.length, newMid.length);
  for (let i = 0; i < paired; i += 1) {
    const o = oldMid[i];
    const r = newMid[i];
    updText.run(r.ord, r.turn_no ?? null, r.ts ?? null, r.text, r.chars, o.id);
    updFts.run(r.text, o.id);
    stat.upd += 1;
  }
  for (let i = paired; i < oldMid.length; i += 1) {
    const o = oldMid[i];
    delFts.run(o.id);
    delChunk.run(o.id);
    stat.del += 1;
  }
  for (let i = paired; i < newMid.length; i += 1) {
    const r = newMid[i];
    const info = insChunk.run(sessionId, r.turn_no ?? null, r.ts ?? null, r.role, r.kind, r.ord, r.text, r.chars, nowMs);
    insFts.run(Number(info.lastInsertRowid), r.text);
    stat.ins += 1;
  }
  return stat;
}

/** 会话行 upsert。 */
export function upsertSessionRow(db, row) {
  db.prepare(
    `INSERT INTO sessions(id,source,workspace,dir,file,file_kind,bytes,mtime_ms,started_ms,ended_ms,turns,chunk_count,chars,indexed_ms,note)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       source=excluded.source, workspace=excluded.workspace, dir=excluded.dir, file=excluded.file,
       file_kind=excluded.file_kind, bytes=excluded.bytes, mtime_ms=excluded.mtime_ms,
       started_ms=excluded.started_ms, ended_ms=excluded.ended_ms, turns=excluded.turns,
       chunk_count=excluded.chunk_count, chars=excluded.chars, indexed_ms=excluded.indexed_ms, note=excluded.note`,
  ).run(
    row.id, row.source, row.workspace, row.dir, row.file, row.file_kind, row.bytes, row.mtime_ms,
    row.started_ms, row.ended_ms, row.turns, row.chunk_count, row.chars, row.indexed_ms, row.note,
  );
}

/** 库内某会话的旧读数（判增量用）。 */
export function getIndexedSession(db, id) {
  try {
    return db.prepare('SELECT mtime_ms, bytes FROM sessions WHERE id=?').get(id) || null;
  } catch {
    return null;
  }
}

/**
 * 扫树 + 建索引。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{roots:string[], sinceDays?:number, onlySession?:string|null, chunkChars?:number,
 *          nowMs?:number, apply?:boolean, onSession?:(info:object)=>void}} opts
 */
export function indexSessions(db, opts) {
  const roots = (Array.isArray(opts.roots) ? opts.roots : [opts.roots]).filter(Boolean).map((r) => path.resolve(String(r)));
  const sinceDays = Number(opts.sinceDays) || 0;
  const only = opts.onlySession ? String(opts.onlySession).replace(/^session-/, '') : null;
  const chunkChars = Number(opts.chunkChars) || DEFAULT_CHUNK_CHARS;
  const nowMs = Number(opts.nowMs) || Date.now();
  const apply = opts.apply !== false;
  const cutoff = sinceDays > 0 ? nowMs - sinceDays * 86400000 : 0;

  const all = findSessionDirs(roots);
  const picked = only ? all.filter((s) => s.id === only) : all;

  const out = {
    roots,
    discovered: all.length,
    selected: picked.length,
    sessions: 0,
    skipped: 0,
    failed: 0,
    chunks: { keep: 0, meta: 0, upd: 0, ins: 0, del: 0 },
    chars: 0,
    broken: { torn: 0, badFrames: 0, badLines: 0, errors: 0 },
    problems: [],
  };

  for (const item of picked) {
    const log = pickCurrentLog(item.dir);
    if (!log) {
      out.skipped += 1;
      continue;
    }
    if (cutoff && log.mtimeMs < cutoff) {
      out.skipped += 1;
      continue;
    }
    const prev = db ? getIndexedSession(db, item.id) : null;
    if (prev && Number(prev.mtime_ms) === log.mtimeMs && Number(prev.bytes) === log.bytes) {
      out.skipped += 1;
      continue;
    }

    const read = readSessionLog(log.file);
    if (read.error) {
      out.failed += 1;
      out.broken.errors += 1;
      out.problems.push({ session: item.id, file: log.name, reason: read.error });
      continue;
    }
    const turns = extractTurns(read.records);
    if (!turns.length) {
      out.skipped += 1;
      continue;
    }
    const rows = buildChunks(turns, { chunkChars });
    if (!rows.length) {
      out.skipped += 1;
      continue;
    }

    const s = read.stats;
    if (s.tornAt !== null || s.badFrames || s.badLines) {
      out.broken.torn += s.tornAt !== null ? 1 : 0;
      out.broken.badFrames += s.badFrames;
      out.broken.badLines += s.badLines;
      out.problems.push({
        session: item.id,
        file: log.name,
        tornAt: s.tornAt,
        badFrames: s.badFrames,
        badLines: s.badLines,
      });
    }

    const stamps = turns.map((t) => Number(t.ts)).filter((n) => Number.isFinite(n) && n > 0);
    const chars = rows.reduce((n, r) => n + r.chars, 0);
    const note = s.tornAt !== null || s.badFrames || s.badLines
      ? `broken: tornAt=${s.tornAt ?? '-'} badFrames=${s.badFrames} badLines=${s.badLines}`
      : null;

    out.sessions += 1;
    out.chars += chars;

    if (!apply) {
      out.chunks.ins += rows.length;
      opts.onSession?.({ ...item, file: log.name, kind: s.kind, turns: turns.length, chunks: rows.length, chars, stats: s, applied: false });
      continue;
    }

    const row = {
      id: item.id,
      source: item.source,
      workspace: path.basename(path.dirname(item.dir)),
      dir: item.dir,
      file: log.file,
      file_kind: log.kind,
      bytes: log.bytes,
      mtime_ms: log.mtimeMs,
      started_ms: stamps.length ? Math.min(...stamps) : null,
      ended_ms: stamps.length ? Math.max(...stamps) : null,
      turns: turns.length,
      chunk_count: rows.length,
      chars,
      indexed_ms: Date.now(),
      note,
    };

    db.exec('BEGIN IMMEDIATE');
    try {
      const st = syncSessionChunks(db, item.id, rows, row.indexed_ms);
      for (const k of Object.keys(st)) out.chunks[k] += st[k];
      upsertSessionRow(db, row);
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 已经回滚过了 */
      }
      out.failed += 1;
      out.broken.errors += 1;
      out.problems.push({ session: item.id, file: log.name, reason: `write:${e?.message || e}` });
      continue;
    }
    opts.onSession?.({ ...item, file: log.name, kind: s.kind, turns: turns.length, chunks: rows.length, chars, stats: s, applied: true });
  }

  return out;
}

/** 会话目录树（默认两处：现行 + 归档；再加 `--root` 给的额外根）。 */
export function defaultRoots(home) {
  const h = path.resolve(String(home));
  return [path.join(h, 'sessions'), path.join(h, '_archived-sessions')];
}

/** 目录是否存在（给 CLI 提示用，不抛）。 */
export function rootStatus(roots) {
  return roots.map((r) => ({ root: r, exists: fs.existsSync(r) }));
}
