// 把 collect-ui-candidates 收集的候选与译文合成为 workbench 补丁规则，并离线校验。
// 用法：node scripts/build-ui-rules.mjs <Cursor 根目录> [--write]
//   默认只校验：把新规则套用到 bundle 副本上，检查括号平衡与 JS 语法。
//   --write：校验通过后追加到 data/workbench-patches.json 与运行策略白名单。
// 工作目录 .tmp/ui-trans：candidates.json、items*.json（待译文本）、out*.json（译文）、risky.json（排除项）。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { applyOrderedStringPatches } = require('../out/orderedPatchEngine.js');
const { measureBraceBalance } = require('../out/braceBalance.js');

const projectRoot = path.resolve(import.meta.dirname, '..');
const cursorRoot = path.resolve(process.argv[2] || 'D:\\cursor');
const shouldWrite = process.argv.includes('--write');
const workDir = path.join(projectRoot, '.tmp', 'ui-trans');
const patchesPath = path.join(projectRoot, 'data', 'workbench-patches.json');
const policyPath = path.join(projectRoot, 'data', 'workbench-patch-runtime-policy.json');
const workbenchDir = path.join(cursorRoot, 'resources', 'app', 'out', 'vs', 'workbench');
const bundles = ['workbench.desktop.main.js', 'workbench.glass.main.js'];

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const listDir = await fs.readdir(workDir);
const candidates = await readJson(path.join(workDir, 'candidates.json'));
const items = (await Promise.all(listDir.filter(n => /^items\d*\.json$/.test(n)).map(n => readJson(path.join(workDir, n))))).flat();
const translations = {};
for (const name of listDir.filter(n => /^out[\d-]+\.json$/.test(n))) Object.assign(translations, await readJson(path.join(workDir, name)));
const risky = new Set(Object.keys(await readJson(path.join(workDir, 'risky.json')).catch(() => ({}))));
const zhByText = new Map();
for (const item of items) {
  const zh = translations[item.i];
  // 疑似发给模型的提示词（以 You are 开头或超长段落）不翻译，避免改变 AI 行为。
  const promptLike = /^(You are|You're|Your task|Respond|Always respond)\b/i.test(item.text) || item.text.length > 360;
  if (zh !== undefined && !promptLike && !risky.has(item.text) && !/^Cursor (Dark|Light)\b/.test(item.text)) zhByText.set(item.text, zh.replace(/聊天/g, '对话'));
}

const bundleText = (await Promise.all(bundles.map(b => fs.readFile(path.join(workbenchDir, b), 'utf8')))).join('\n');
const escapes = value => (value.replace(/\\u[0-9a-fA-F]{4}/g, '').match(/\\./g) ?? []).sort().join('');
const placeholders = value => (value.match(/%[sd]|\{\w*\}|\$\d/g) ?? []).sort().join('|');
const edgeSpace = value => `${/^\s/.test(value)}${/\s$/.test(value)}`;
const balance = value => JSON.stringify(measureBraceBalance(value));

const check = (text, zh, kind) => {
  if (typeof zh !== 'string' || zh.length === 0) return 'empty';
  if (zh === text) return 'unchanged';
  if (/(^|[^\\])"/.test(zh) || /\\$/.test(zh.replace(/\\\\/g, ''))) return 'quote-or-backslash';
  if (kind === 'template' && (zh.includes('`') || zh.includes('${'))) return 'template-unsafe';
  if (/[\n\r]/.test(zh)) return 'raw-newline';
  if (escapes(zh) !== escapes(text)) return 'escape-mismatch';
  if (placeholders(zh) !== placeholders(text)) return 'placeholder-mismatch';
  if (edgeSpace(zh) !== edgeSpace(text)) return 'edge-space';
  if (balance(zh) !== balance(text)) return 'brace-balance';
  if (!/[\u3400-\u9fff]/.test(zh)) return 'no-cjk';
  return undefined;
};

// 单个英文单词风险高：常被当作令牌拼接（如 "red"+"Foreground"）或作为标识符。
// JSX 文本与无障碍属性直接放行；label/title 等要求该词未以驼峰形式拼接出现过；其余键不翻译。
const alwaysDisplay = new Set(['children', '"aria-label"', 'ariaLabel', 'placeholder', 'tooltip']);
const displayKeys = new Set(['label', 'title', 'buttonLabel', 'buttonText', 'confirmLabel', 'cancelLabel', 'heading', 'subtitle', 'header', 'actionLabel', 'submitLabel']);
const composedCache = new Map();
const isComposed = word => {
  if (!composedCache.has(word)) composedCache.set(word, new RegExp(`[a-z]${word}|${word}[A-Z]`).test(bundleText));
  return composedCache.get(word);
};
const singleWordAllowed = (text, key) => {
  if (/\s/.test(text.trim())) return true;
  if (alwaysDisplay.has(key)) return true;
  const bare = text.replace(/[^A-Za-z]/g, '');
  return displayKeys.has(key) && bare.length > 0 && !isComposed(bare);
};

const rejected = [];
const translate = (text, kind, key) => {
  const zh = zhByText.get(text);
  if (!singleWordAllowed(text, key)) return undefined;
  const problem = check(text, zh, kind);
  if (problem) {
    if (problem !== 'unchanged' && problem !== 'empty') rejected.push({ problem, text, zh });
    return undefined;
  }
  return zh;
};
const replaceLast = (source, from, to) => {
  const cut = source.lastIndexOf(from);
  return `${source.slice(0, cut)}${to}${source.slice(cut + from.length)}`;
};

const existing = await readJson(patchesPath);
const existingSources = new Set(existing.map(rule => rule.source));
const rules = new Map();
for (const c of candidates) {
  if (existingSources.has(c.source) || rules.has(c.source)) continue;
  let target;
  if (c.kind === 'ternary') {
    const [a, b] = c.parts.map(part => translate(part, 'ternary', c.key));
    if (!a || !b) continue;
    target = replaceLast(replaceLast(c.source, `"${c.parts[1]}"`, `"${b}"`), `"${c.parts[0]}"`, `"${a}"`);
  } else if (c.kind === 'template') {
    const zh = translate(c.text, 'template', c.key);
    if (!zh) continue;
    // 英文复数后缀表达式（如 n===1?"":"s"）在中文里输出空串；表达式含括号时保留原样以免破坏括号平衡。
    const pluralRe = /\?\s*""\s*:\s*"e?s"|\?\s*"e?s"\s*:\s*""/;
    const body = zh.replace(/\{(\d+)\}/g, (_m, n) => {
      const expr = c.exprs[Number(n)];
      return pluralRe.test(expr) && !/[()[\]]/.test(expr) ? '${""}' : `\${${expr}}`;
    });
    const raw = c.text.replace(/\{(\d+)\}/g, (_m, n) => `\${${c.exprs[Number(n)]}}`);
    target = replaceLast(c.source, `\`${raw}\``, `\`${body}\``);
  } else {
    const zh = translate(c.text, 'plain', c.key);
    if (!zh) continue;
    target = replaceLast(c.source, `"${c.text}"`, `"${zh}"`);
  }
  if (target === c.source) continue;
  const id = `workbench.ui.${createHash('sha1').update(c.source).digest('hex').slice(0, 16)}`;
  rules.set(c.source, { id, source: c.source, target, note: '界面文案：按属性名、常量、条件分支或模板上下文匹配' });
}

// 去掉被其他新规则包含的规则，避免重叠替换。
let newRules = [...rules.values()].sort((x, y) => y.source.length - x.source.length);
const kept = [];
const longSources = [];
for (const rule of newRules) {
  if (longSources.some(src => src.includes(rule.source))) continue;
  kept.push(rule);
  if (rule.source.length > 40) longSources.push(rule.source);
}
newRules = kept;

console.log(`translations: ${zhByText.size}/${items.length}, new rules: ${newRules.length}, rejected: ${rejected.length}`);
console.log('rejected by reason:', rejected.reduce((acc, r) => ({ ...acc, [r.problem]: (acc[r.problem] ?? 0) + 1 }), {}));
await fs.writeFile(path.join(workDir, 'rejected.json'), JSON.stringify(rejected, null, 1));

let totalHits = 0;
for (const bundle of bundles) {
  const original = await fs.readFile(path.join(workbenchDir, bundle), 'utf8');
  const result = applyOrderedStringPatches(original, newRules);
  totalHits += result.totalCount;
  if (balance(original) !== balance(result.value)) throw new Error(`${bundle}: 括号平衡被破坏`);
  const copy = path.join(workDir, bundle.replace(/\.js$/, '.check.mjs'));
  await fs.writeFile(copy, result.value, 'utf8');
  execFileSync(process.execPath, ['--check', copy], { stdio: 'inherit' });
  await fs.rm(copy);
  console.log(`${bundle}: ${result.totalCount} 处替换，语法检查通过`);
}
console.log(`total replacements: ${totalHits}`);

if (shouldWrite) {
  await fs.writeFile(patchesPath, `${JSON.stringify([...existing, ...newRules], null, 2)}\n`, 'utf8');
  const policy = await readJson(policyPath);
  const prefixes = new Set(policy.safeSourcePrefixes);
  for (const rule of newRules) prefixes.add(rule.source);
  policy.safeSourcePrefixes = [...prefixes];
  await fs.writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  console.log(`已写入 ${newRules.length} 条规则到 data/workbench-patches.json`);
}
