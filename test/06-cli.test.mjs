// 06 · CLI 契约：--help 不动作 / 参数错就停 / 三个命令的退出码
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setSection, assert, assertEq, listFiles, makeTmpDir, rmDir, test } from './harness.mjs';

setSection('CLI 契约（--help / 退出码 / 真实进程）');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLIS = ['life-db-init.mjs', 'life-index.mjs', 'life-recall.mjs'];

function runCli(name, args, env = {}) {
  const res = spawnSync(process.execPath, [path.join(REPO, 'cli', name), ...args], {
    encoding: 'utf8',
    cwd: REPO,
    env: { ...process.env, ...env },
  });
  if (res.error) throw res.error;
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}


test('三个命令的 --help：只看帮助，一个字节都不写', () => {
  const dir = makeTmpDir('life-cli-help-');
  try {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true });
    for (const cli of CLIS) {
      const res = runCli(cli, ['--help'], { DSH_HOME: home });
      assertEq(res.code, 0, `${cli} --help 应返回 0`);
      assert(res.out.includes('usage:'), `${cli} 要打印用法`);
      assertEq(listFiles(home).length, 0, `${cli} --help 之后 home 里不该多出任何文件`);
      assertEq(fs.existsSync(path.join(home, 'memory-life')), false, `${cli} --help 不该建 memory-life 目录`);
    }
  } finally {
    rmDir(dir);
  }
});

test('--help 与其它参数混用也只打帮助（先判 help，不进主流程）', () => {
  const dir = makeTmpDir();
  try {
    const db = path.join(dir, 'x.db');
    const res = runCli('life-index.mjs', ['--apply', '--help', '--db', db]);
    assertEq(res.code, 0, '返回 0');
    assertEq(fs.existsSync(db), false, '不该建库');
  } finally {
    rmDir(dir);
  }
});

test('未知参数 / 缺值：退出码 2，且不做任何事', () => {
  const dir = makeTmpDir();
  try {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true });
    let res = runCli('life-index.mjs', ['--applyy'], { DSH_HOME: home });
    assertEq(res.code, 2, '拼错的参数要停下');
    assert(res.out.includes('未知参数'), '错误要说清是哪个参数');
    res = runCli('life-index.mjs', ['--db'], { DSH_HOME: home });
    assertEq(res.code, 2, '缺值也要停');
    assertEq(listFiles(home).length, 0, '都没写盘');
  } finally {
    rmDir(dir);
  }
});

test('life-recall：缺查询串 ⇒ 退出码 2', () => {
  const res = runCli('life-recall.mjs', []);
  assertEq(res.code, 2, '缺查询');
  assert(res.out.includes('缺少查询串'), '提示要人话');
});

test('life-index 默认 dry-run：跑完不建库', async () => {
  const dir = makeTmpDir();
  try {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, 'sessions', 'demo', 'session-one'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'sessions', 'demo', 'session-one', 'session.jsonl'),
      '{"type":"user/message","seq":1,"time":1788228001000,"data":{"content":[{"type":"text","text":"一句够长的测试话"}],"source":{"kind":"user"}}}\n',
      'utf8',
    );
    const res = runCli('life-index.mjs', [], { DSH_HOME: home });
    assertEq(res.code, 0, 'rc');
    assert(res.out.includes('dry-run'), '要明确说这是 dry-run');
    assertEq(fs.existsSync(path.join(home, 'memory-life', 'life.db')), false, '不该建库');
  } finally {
    rmDir(dir);
  }
});

test('全链（子进程）：init → index --apply → recall', () => {
  const dir = makeTmpDir();
  try {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, 'sessions', 'demo', 'session-one'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'sessions', 'demo', 'session-one', 'session.jsonl'),
      [
        '{"type":"user/message","seq":1,"time":1788228001000,"data":{"content":[{"type":"text","text":"客厅的落地灯我打算换成暖光的，白光太刺眼。"}],"source":{"kind":"user"}}}',
        '{"type":"assistant/message","seq":2,"time":1788228002000,"data":{"message":{"role":"assistant","content":[{"type":"text","text":"暖光选 2700K 到 3000K，显色指数挑 90 以上。"}]}}}',
        '',
      ].join('\n'),
      'utf8',
    );

    let res = runCli('life-db-init.mjs', [], { DSH_HOME: home });
    assertEq(res.code, 0, 'init rc');
    res = runCli('life-index.mjs', ['--apply'], { DSH_HOME: home });
    assertEq(res.code, 0, 'index rc');
    assert(res.out.includes('本次处理 1 个'), `索引到一份会话：${res.out.split('\n')[1] || ''}`);

    res = runCli('life-recall.mjs', ['落地灯我打算换成暖光'], { DSH_HOME: home });
    assertEq(res.code, 0, 'recall rc');
    assert(res.out.includes('暖光'), '要捞回原话');
    assert(res.out.includes('[人生记忆·旧会话片段]'), '要给出可注入形态');

    res = runCli('life-recall.mjs', ['完全不存在的词组'], { DSH_HOME: home });
    assertEq(res.code, 1, '无命中用 1（和"出错"区分开）');

    res = runCli('life-recall.mjs', ['落地灯我打算换成暖光'], { DSH_HOME: path.join(dir, 'empty-home') });
    assertEq(res.code, 3, '库不存在用 3');
  } finally {
    rmDir(dir);
  }
});

test('取证脚本 verify-clean-home.mjs 自身可通过（灵魂判据可复跑）', () => {
  const res = spawnSync(process.execPath, [path.join(REPO, 'tools', 'verify-clean-home.mjs')], { encoding: 'utf8', cwd: REPO });
  if (res.error) throw res.error;
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  assertEq(res.status, 0, `rc=${res.status}\n${out.split('\n').slice(-8).join('\n')}`);
  assert(out.includes('通过 13 / 失败 0'), '全链 13 项应全过');
});
