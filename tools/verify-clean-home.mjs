#!/usr/bin/env node
// verify-clean-home.mjs —— 灵魂判据的取证脚本：
//   「在一个**全新空目录**当 DSH_HOME、**没有任何真实数据**的环境里，
//     只喂仓库自带的假会话语料，能不能跑通 建库 → 建索引 → 召回，
//     并且召回结果**指得回** fixture 里的那句原话。」
//
// 为什么这条判据比"装得上"重要：一个只开源了"壳"、内核依赖私有数据的仓，npm i 之后
// 一切看起来都正常，直到你问它一句旧话 —— 它什么也想不起来。所以这里不看 install，
// 只看"能不能真的想起一句假原话"。
//
// 用法：node tools/verify-clean-home.mjs [--keep]
//   --keep  保留临时目录（排查用）
// 退出码：0 全链通过 · 1 有断言失败
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFixtures } from '../fixtures/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const KEEP = process.argv.includes('--keep');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function run(cli, args, env) {
  const res = spawnSync(process.execPath, [path.join(REPO, 'cli', cli), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: REPO,
  });
  if (res.error) throw res.error;
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(p);
      if (e.isDirectory()) stack.push(p);
    }
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-clean-home-'));
const home = path.join(tmp, 'dsh-home');
const staging = path.join(tmp, 'fixtures');
fs.mkdirSync(home, { recursive: true });

console.log('[灵魂判据] 干净 home 全链：建库 → 建索引 → 召回\n');
console.log(`  空 home（DSH_HOME）= ${home}`);
console.log(`  home 初始内容：${walk(home).length} 项（0 = 真的干净）\n`);

try {
  // ① home 必须真的是空的
  check('干净环境：home 里一个文件都没有', walk(home).length === 0, `${walk(home).length} 项`);

  // ② 只喂仓库自带 fixture（内容全部手写，不含任何真实会话）
  const fx = buildFixtures({ destDir: staging });
  const sessRoot = path.join(home, 'sessions');
  fs.mkdirSync(sessRoot, { recursive: true });
  fs.cpSync(fx.sessionsDir, sessRoot, { recursive: true });
  const copied = walk(sessRoot).filter((p) => fs.statSync(p).isFile());
  check(
    '语料只来自仓内 fixture',
    copied.length === 3,
    `${copied.length} 个文件：${copied.map((p) => path.basename(p)).join(', ')}`,
  );

  // ③ 建库（真实 CLI）
  const init = run('life-db-init.mjs', [], { DSH_HOME: home });
  check('步 1/3 建库（life-db-init）', init.code === 0 && init.out.includes('schema'), init.out.trim().split('\n')[0]);

  // ④ 建索引（真实 CLI，--apply 才写）
  const index = run('life-index.mjs', ['--apply'], { DSH_HOME: home });
  const dbFile = path.join(home, 'memory-life', 'life.db');
  check('步 2/3 建索引（life-index --apply）', index.code === 0 && fs.existsSync(dbFile), dbFile);
  check('索引覆盖三份会话', /发现会话目录 3 个/.test(index.out), (index.out.match(/发现会话目录[^\n]*/) || [''])[0]);
  check('坏块被计数上报（不是静默跳过）', /撕裂帧 [1-9]|坏行 [1-9]/.test(index.out), (index.out.match(/坏块计数[^\n]*/) || [''])[0]);

  // ⑤ 召回（真实 CLI）—— 查一句只有 alpha 里出现过的话
  const query = '灯塔用暖黄色';
  const recall = run('life-recall.mjs', [query, '--json'], { DSH_HOME: home });
  let parsed = null;
  try {
    parsed = JSON.parse(recall.out);
  } catch {
    /* 下面按解析失败处理 */
  }
  check('步 3/3 召回（life-recall）', recall.code === 0 && !!parsed, `rc=${recall.code}`);
  const hits = parsed?.hits || [];
  check('召回到至少一段原话', hits.length >= 1, `${hits.length} 段`);

  // ⑥ 灵魂：命中的那一块，必须能指回 fixture 里那句原话
  const alphaRaw = fs.readFileSync(path.join(REPO, 'fixtures', 'raw', 'session-alpha.jsonl'), 'utf8');
  const needle = '灯塔用暖黄色';
  const hit = hits.find((h) => String(h.text).includes(needle));
  check('命中块里含 fixture 的原话片段', !!hit, hit ? `chunk id=${hit.id}` : '没找到');
  check('该片段逐字存在于 fixture 源文件里', alphaRaw.includes(needle), needle);
  check('命中块来自 fixture 会话（不是别的库）', hit ? String(hit.session_id).startsWith('alpha') || hit.session_id === 'alpha' : false, hit?.session_id || '-');
  check('注入段带固定标题', String(parsed?.text || '').includes('[人生记忆·旧会话片段]'), (parsed?.text || '').split('\n')[0]?.slice(0, 40) || '');

  console.log('\n  证据（命中块 ← fixture 原话）：');
  if (hit) {
    console.log(`    命中块 [${hit.id}] session=${hit.session_id} ts=${hit.ts}`);
    console.log(`      正文：${String(hit.text).split('\n')[0].slice(0, 120)}`);
    console.log(`      可注入形态：`);
    for (const line of String(parsed?.text || '').split('\n')) console.log(`        ${line}`);
  }

  // ⑦ 再跑一次索引：必须全部跳过（增量生效）
  const again = run('life-index.mjs', ['--apply'], { DSH_HOME: home });
  check('重复建索引是增量的（第二次全跳过）', /本次处理 0 个/.test(again.out), (again.out.match(/发现会话目录[^\n]*/) || [''])[0]);
} finally {
  if (KEEP) console.log(`\n  （已保留临时目录：${tmp}）`);
  else fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n—— 全链 ${checks.length} 项：通过 ${checks.length - failed.length} / 失败 ${failed.length} ——`);
process.exitCode = failed.length ? 1 : 0;
