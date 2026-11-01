// defaults.mjs —— 所有可调数值集中在这儿（改行为先改这里，别散落在调用处）
//
// 取值依据（都是"上下文预算"倒推出来的，不是拍脑袋）：
//   · 每轮注入 ≤ 2 段、≤ 320 字 —— 与工作记忆的指针段（≤ 800 字）共用同一个上下文预算，
//     两段加起来不能把"用户这句话"挤到看不见；
//   · 块大小 1,200 字 —— 一段话一次读完的舒适上限；再大会让"命中一块 = 注入一大坨"；
//   · 查询短于 3 字不查 —— trigram 索引小于 3 字根本命中不了，白跑一次 SQL。

/** 单块字符数上限。 */
export const DEFAULT_CHUNK_CHARS = 1200;

/** 每轮最多注入几段原话。 */
export const DEFAULT_TOP_K = 2;

/** 每轮注入段的字符预算（含标题行与每行前缀）。 */
export const DEFAULT_MAX_CHARS = 320;

/** 查询短于这个长度就不查（trigram 索引的最短有效长度）。 */
export const MIN_QUERY_CHARS = 3;

/** 短查询（≤ 这个长度）整句当短语匹配；更长的句子切 n-gram 做 OR。 */
export const PHRASE_QUERY_CHARS = 12;

/** 长查询切 4 字窗口，从这段比例开始取窗（跳过句首的"你还记得/请问一下"这类套话）。 */
export const GRAM_SIZE = 4;
export const GRAM_START_RATIO = 1 / 3;
export const GRAM_COUNT = 6;

/** 时间显示用的固定偏移（分钟）。默认 +480 = UTC+8。固定值是为了让输出可复现。 */
export const DEFAULT_TZ_OFFSET_MINUTES = 480;

/** 正文去重时比较的前缀长度（同一段原话在两个会话里都出现过 ⇒ 只留一条）。 */
export const DEDUPE_PREFIX_CHARS = 60;
