#!/usr/bin/env node
// life-db-init.mjs —— 建 / 升级人生记忆库（幂等）
//
// 只做一件事：把 life.db 的结构建出来（或升级到当前 schema 版本）。
// 不索引、不查询、不改任何会话文件。重复跑 = 空转。
import path from 'node:path';
import { initDb, defaultDbPath, resolveHome, SCHEMA_VERSION } from '../lib/schema.mjs';
import { parseArgs, usageExit } from '../lib/cli-args.mjs';

const USAGE = [
  'usage: node cli/life-db-init.mjs [--home <DSH 根>] [--db <库文件>] [--json] [--help]',
  '',
  '  --home <目录>    DSH 数据根（默认 $DSH_HOME，再默认 ~/.dsh）',
  '  --db <文件>      库文件（默认 <home>/memory-life/life.db）',
  '  --json           机器可读输出',
  '  --help           只看这个帮助；不读库、不建库、不写任何文件',
  '',
  `当前 schema 版本：${SCHEMA_VERSION}`,
].join('\n');

const parsed = parseArgs(process.argv.slice(2), { flags: ['json'], values: ['home', 'db'] });
// 🔴 --help 第一优先：这里 return 之后不再碰任何文件
if (parsed.help) {
  console.log(USAGE);
  process.exitCode = 0;
} else if (parsed.error) {
  usageExit(parsed.error, USAGE);
} else {
  const home = resolveHome(parsed.opts.home);
  const dbPath = parsed.opts.db ? path.resolve(String(parsed.opts.db)) : defaultDbPath(home);
  const res = await initDb({ dbPath });
  if (parsed.opts.json) {
    console.log(JSON.stringify({ ...res, home }, null, 2));
  } else {
    console.log(`[life-db-init] ${res.created ? '已新建' : '已存在'}：${res.dbPath}`);
    console.log(`  schema ${res.from} → ${res.to}${res.applied.length ? `（执行迁移 ${res.applied.join(',')}）` : ''}`);
    console.log(`  表：${res.tables.join(', ')}`);
    console.log(`  现有：sessions=${res.counts.sessions} chunks=${res.counts.chunks}`);
  }
  process.exitCode = 0;
}
