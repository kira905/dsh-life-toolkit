// run.mjs —— 测试入口
//
//   node test/run.mjs                 全跑
//   node test/run.mjs recall          只跑文件名含 recall 的用例文件
//   node test/run.mjs --rebuild       先重建 fixtures（默认：没有就建、有就用）
//   node test/run.mjs --json          末尾多打一行机器可读汇总
//
// 退出码：0 全过 · 1 有失败。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runAll } from './harness.mjs';
import { buildFixtures } from '../fixtures/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const FIXTURE_BUILD = path.join(REPO, 'fixtures', 'build');

const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const wantRebuild = argv.includes('--rebuild');
const only = argv.find((a) => !a.startsWith('-'));

// fixtures 是生成物（不进 git）：没有就先造一份，保证"clone 下来直接跑测试"成立
if (wantRebuild || !fs.existsSync(FIXTURE_BUILD)) {
  const fx = buildFixtures();
  console.log(`[fixtures] 已生成 ${fx.sessions.length} 份假会话 → ${fx.root}`);
}

const suite = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !only || f.includes(only))
  .sort();

console.log(`人生记忆仓 · 测试 · node ${process.version} · ${process.platform}`);
console.log(`用例文件 ${suite.length} 个：${suite.join(' ') || '(无)'}`);

for (const f of suite) await import(pathToFileURL(path.join(HERE, f)).href);

const t0 = Date.now();
const res = await runAll();
console.log(`总耗时 ${Date.now() - t0} ms`);

if (res.failures.length) {
  console.log('\n失败清单：');
  for (const f of res.failures) console.log(`  · ${f.name}`);
}
if (wantJson) console.log(JSON.stringify({ passed: res.passed, failed: res.failed, failures: res.failures.map((f) => f.name) }));

process.exitCode = res.failed ? 1 : 0;
