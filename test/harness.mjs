// harness.mjs —— 零依赖测试 runner + 一小把断言
//
// 为什么自己写而不引测试框架：这个仓的核心承诺是"clone 下来 node 就能跑"，
// 多一个 devDependency 就多一次 npm 装不上就开不了工的机会。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cases = [];
const tally = { passed: 0, failed: 0 };
const failures = [];
let activeSection = '';

/** 登记一个用例（测试文件顶部先 setSection 就能分组）。 */
export function test(label, fn) {
  cases.push({ label, fn, section: activeSection });
}

/** 登记一个跳过项（带上原因，别静默消失）。 */
export function skip(label, why = '') {
  cases.push({ label, fn: null, why, section: activeSection });
}

export function setSection(title) {
  activeSection = String(title);
}

/** 立即打印 + 设置分组（一般用不到，runAll 会统一排版）。 */
export function section(title) {
  activeSection = String(title);
  console.log(`\n▶ ${title}`);
}

export async function runAll() {
  let lastSection = null;
  for (const c of cases) {
    if (c.section !== lastSection) {
      console.log(`\n▶ ${c.section || '(未分组)'}`);
      lastSection = c.section;
    }
    if (!c.fn) {
      console.log(`  ⏭️  ${c.label}${c.why ? `（跳过：${c.why}）` : ''}`);
      continue;
    }
    const t0 = Date.now();
    try {
      await c.fn();
      tally.passed += 1;
      console.log(`  ✅ ${c.label}  (${Date.now() - t0}ms)`);
    } catch (e) {
      tally.failed += 1;
      const msg = String(e && e.stack ? e.stack : e);
      failures.push({ name: c.label, msg });
      console.log(`  ❌ ${c.label}`);
      console.log(`     ${msg.split('\n').slice(0, 6).join('\n     ')}`);
    }
  }
  const total = tally.passed + tally.failed;
  console.log(`\n—— 合计 ${total} 项：通过 ${tally.passed} / 失败 ${tally.failed} ——`);
  return { ...tally, failures };
}

/* ───────────────────────────── 断言 ───────────────────────────── */

const show = (v) => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  } catch {
    return String(v);
  }
};

export function assert(cond, msg = '断言失败') {
  if (!cond) throw new Error(msg);
}

/** 相等（对象/数组按 JSON 深度比较，避免 [0,1] !== [0,1] 的假红）。 */
export function assertEq(actual, expected, msg = '') {
  const deep = (actual !== null && typeof actual === 'object') || (expected !== null && typeof expected === 'object');
  const same = deep ? JSON.stringify(actual) === JSON.stringify(expected) : actual === expected;
  if (!same) throw new Error(`${msg ? `${msg}：` : ''}期望 ${show(expected)}，实际 ${show(actual)}`);
}

export function assertDeepEq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg ? `${msg}：` : ''}期望 ${b}，实际 ${a}`);
}

/** 包含子串（给"输出里有没有这句话"这类断言用）。 */
export function assertIncludes(haystack, needle, msg = '') {
  const h = String(haystack ?? '');
  if (!h.includes(String(needle))) throw new Error(`${msg ? `${msg}：` : ''}期望包含 ${show(needle)}，实际 ${show(h.slice(0, 220))}`);
}

/** 不包含子串（给"绝不能漏出去"这类断言用）。 */
export function assertNotIncludes(haystack, needle, msg = '') {
  const h = String(haystack ?? '');
  if (h.includes(String(needle))) throw new Error(`${msg ? `${msg}：` : ''}不该包含 ${show(needle)}`);
}

/** 正则命中。 */
export function assertMatch(text, re, msg = '') {
  const t = String(text ?? '');
  if (!re.test(t)) throw new Error(`${msg ? `${msg}：` : ''}期望匹配 ${re}，实际 ${show(t.slice(0, 220))}`);
}

export async function assertThrows(fn, msg = '期望抛错但未抛') {
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error(msg);
  return threw;
}

/* ───────────────────────────── 临时目录 ───────────────────────────── */

/** 每个用例一个全新临时目录（系统临时区，绝不碰仓库目录）。 */
export function makeTmpDir(prefix = 'life-toolkit-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上偶有句柄没释放；清不掉也不影响用例结果 */
  }
}

/** 递归列文件（只看文件，不看目录）。 */
export function listFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

export { tally, failures };
