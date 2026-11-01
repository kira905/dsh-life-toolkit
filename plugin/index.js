/**
 * dsh-life-memory-toolkit 插件 —— 每轮从人生记忆库（life.db）里按需捡回 1~2 段「旧原话」
 *
 * 与工作记忆插件（dsh-memory 那一类）的分工：
 *   工作记忆 = 结论 / 台账 / 偏好（每轮注入，条数少、体积小）
 *   本插件   = **原话**（以前的会话里真实说过的句子，带时间），每轮最多 1~2 段
 *
 * 设计取舍（四条，都不建议改）：
 *   · 只走词通道（FTS5）：每轮都要跑，不能出现网络请求或几百毫秒的编码延迟。
 *     语义检索留给离线 CLI（life-recall.mjs），那里慢一点没关系。
 *   · 只捡正文（kind='text'）：思考链的词频天然高，会把真话挤下去。
 *   · **没命中一个字都不加**：不占上下文，也不制造"我记得"的错觉。
 *   · fail-open：打开库失败 / 查询报错 / 渲染报错 —— 一律原样放行，绝不阻塞本轮。
 *
 * 打开失败后不是永久放弃：60 秒冷却再试一次（库可能是刚建好、或者临时被占用）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { recall } from '../lib/recall-core.mjs';
import { DEFAULT_MAX_CHARS, DEFAULT_TOP_K, DEFAULT_TZ_OFFSET_MINUTES } from '../lib/defaults.mjs';

export const name = 'dsh-life-memory-toolkit';
export const inject = [];
export const VERSION = '0.1.0';

const RETRY_COOLDOWN_MS = 60 * 1000;

/** 插件配置的默认值（cordis.patch.yml 里的键同名覆盖）。 */
export const DEFAULT_CONFIG = Object.freeze({
  dbPath: null,
  topK: DEFAULT_TOP_K,
  maxChars: DEFAULT_MAX_CHARS,
  tzOffsetMinutes: DEFAULT_TZ_OFFSET_MINUTES,
  labels: { user: '用户', assistant: '助手' },
  minQueryChars: 3,
  verbose: false,
});

function deepFreeze(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) return value;
  const visited = seen || new WeakSet();
  if (visited.has(value)) return value;
  visited.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], visited);
  return Object.freeze(value);
}

/** 构造一条注入用的 user 消息（与其它插件同款：冻结 + 带 source 标记）。 */
export function makeInjectedMessage(text, items = []) {
  return deepFreeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'life-memory', version: 1, items },
  });
}

/** 取最后一条真人输入的文字（历史上的 messages 形态有两种：content 数组 / 字符串）。 */
export function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    const raw = m.content;
    const text =
      typeof raw === 'string'
        ? raw.trim()
        : (Array.isArray(raw) ? raw : [])
            .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n')
            .trim();
    if (text) return text;
  }
  return '';
}

/** 解析库路径（配置 > $DSH_HOME > ~/.dsh）。 */
export function resolveDbPath(config, env = process.env, homedir = os.homedir()) {
  if (config && config.dbPath) return path.resolve(String(config.dbPath));
  const home = env.DSH_HOME && String(env.DSH_HOME).trim() ? path.resolve(String(env.DSH_HOME).trim()) : path.join(homedir, '.dsh');
  return path.join(home, 'memory-life', 'life.db');
}

/**
 * 召回引擎（可单测：不依赖 cordis，也不依赖 dsh 运行时）。
 * @param {object} config
 * @param {{openDb?:Function, now?:Function}} [deps]
 */
export function createRecallEngine(config = {}, deps = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    labels: { ...DEFAULT_CONFIG.labels, ...(config?.labels || {}) },
  };
  const dbPath = resolveDbPath(cfg);
  const openDb = deps.openDb || defaultOpenDb;
  const now = deps.now || (() => Date.now());

  let db = null;
  let brokenAt = 0;

  const getDb = async () => {
    if (db) return db;
    if (brokenAt && now() - brokenAt < RETRY_COOLDOWN_MS) return null;
    if (!fs.existsSync(dbPath)) {
      brokenAt = now();
      return null;
    }
    try {
      db = await openDb(dbPath);
      brokenAt = 0;
      return db;
    } catch {
      brokenAt = now();
      return null;
    }
  };

  /** 给一个 step 算出该注入什么（'' = 不注入）。 */
  const forStep = async (messages, step) => {
    if (Number(step) !== 1) return { text: '', reason: 'not-first-step' };
    const query = lastUserText(messages);
    if (!query || [...query].length < cfg.minQueryChars) return { text: '', reason: 'query-too-short' };
    const d = await getDb();
    if (!d) return { text: '', reason: 'db-unavailable' };
    try {
      const res = recall(d, query, {
        topK: cfg.topK,
        maxChars: cfg.maxChars,
        tzOffsetMinutes: cfg.tzOffsetMinutes,
        labels: cfg.labels,
      });
      return { text: res.text, hits: res.hits, reason: res.reason };
    } catch {
      return { text: '', reason: 'query-error' };
    }
  };

  return { forStep, dbPath, config: cfg, close: () => { try { db?.close(); } catch { /* 已关 */ } db = null; } };
}

async function defaultOpenDb(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export function apply(ctx, config = {}) {
  const engine = createRecallEngine(config);
  const verbose = config?.verbose === true;

  ctx.on(
    'agent/pre-step',
    async (evt, next) => {
      const decision = await next();
      try {
        if (!decision || decision.kind === 'reject') return decision;
        if (!evt || evt.step !== 1) return decision;
        const res = await engine.forStep(evt.messages, evt.step);
        if (!res.text) {
          if (verbose && res.reason !== 'not-first-step') console.warn(`[life-memory-toolkit] 本段不注入：${res.reason}`);
          return decision;
        }
        if (verbose) console.warn(`[life-memory-toolkit] 注入 ${res.hits?.length || 0} 段（${res.text.length} 字）`);
        return {
          kind: 'enter',
          messages: [...decision.messages, makeInjectedMessage(res.text, (res.hits || []).map((h) => h.id))],
        };
      } catch {
        return decision;
      }
    },
    { prepend: false },
  );
}

/** 只给测试/诊断用：插件支持的配置键（未知键会被忽略，但会被报出来）。 */
export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

/** 未知配置键（便于部署前自查拼写错误）。 */
export function unknownConfigKeys(config = {}) {
  return Object.keys(config || {}).filter((k) => !CONFIG_KEYS.includes(k));
}
