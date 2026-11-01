// cli-args.mjs —— 三个 CLI 共用的参数解析
//
// 两条硬规矩：
//   ① `--help` 只打印帮助就返回 —— **一个字节都不写、一个文件都不读**。
//      实现方式：先解析、后判断；一旦 help 为真，调用方立即 return，绝不进入主流程。
//   ② 未知参数一律报错（退出码 2），不"忽略后继续跑"。
//      否则 `--dryrun`（打错一个字母）就会被当成 dry-run 的反面，真往库里写。

/**
 * @param {string[]} argv
 * @param {{flags?:string[], values?:string[], multi?:string[]}} spec
 *   multi = 可以重复给的参数（如 `--root a --root b`），收成数组
 * @returns {{help:boolean, opts:Record<string, any>, error:string|null, unknown:string[]}}
 */
export function parseArgs(argv, spec = {}) {
  const flags = new Set(spec.flags || []);
  const values = new Set(spec.values || []);
  const multi = new Set(spec.multi || []);
  const opts = {};
  const unknown = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i]);
    if (a === '-h' || a === '--help') {
      opts.help = true;
      continue;
    }
    if (!a.startsWith('--')) {
      // 位置参数：按调用方约定收进 `_`（例如 recall 的查询串）
      if (!opts._) opts._ = [];
      opts._.push(a);
      continue;
    }
    const name = a.slice(2);
    if (values.has(name) || multi.has(name)) {
      const v = list[i + 1];
      if (v === undefined || String(v).startsWith('--')) {
        return { help: !!opts.help, opts, error: `参数 ${a} 需要一个值`, unknown };
      }
      if (multi.has(name)) {
        const key = camel(name);
        if (!Array.isArray(opts[key])) opts[key] = [];
        opts[key].push(v);
      } else {
        opts[camel(name)] = v;
      }
      i += 1;
      continue;
    }
    if (flags.has(name)) {
      opts[camel(name)] = true;
      continue;
    }
    unknown.push(a);
  }
  if (unknown.length) return { help: !!opts.help, opts, error: `未知参数：${unknown.join(' ')}`, unknown };
  return { help: !!opts.help, opts, error: null, unknown };
}

/** `since-days` → `sinceDays`；`no-vec` → `noVec`。 */
export function camel(name) {
  return String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** 统一的"用法错误"退出方式。 */
export function usageExit(message, usage, code = 2) {
  if (message) console.error(`[参数错误] ${message}`);
  console.error(usage);
  process.exitCode = code;
}
