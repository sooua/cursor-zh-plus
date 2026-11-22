// 从当前（已打补丁的）workbench bundle 中收集仍为英文的界面文案候选。
// 用法：node scripts/collect-ui-candidates.mjs [Cursor 根目录] [输出文件]
// 输出：[{ file, source, key, text }]，source 为可直接写入补丁表的上下文片段。
import fs from 'node:fs/promises';
import path from 'node:path';

const cursorRoot = path.resolve(process.argv[2] || process.env.CURSOR_ROOT || 'D:\\cursor');
const outPath = path.resolve(process.argv[3] || '.tmp/ui-trans/candidates.json');
const workbenchDir = path.join(cursorRoot, 'resources', 'app', 'out', 'vs', 'workbench');
const files = ['workbench.glass.main.js', 'workbench.desktop.main.js'];

// 属性名包含这些词时视为界面文案；"aria-label" 单独处理。
const uiKeyWord = /(title|label|description|desc|placeholder|children|tooltip|subtitle|header|heading|text|message|msg|hint|caption|button|cta|prompt|warning|confirm|cancel|summary|empty|helper|body|detail|banner|notice|explanation|instructions?|tagline|blurb|copy)$/i;
const literal = '"((?:[^"\\\\\\n]|\\\\.){2,400})"';
const keyRe = new RegExp(`(?<=[,{(\\s])([A-Za-z_$][\\w$]*|"aria-label"):${literal}`, 'g');
const constRe = new RegExp(`(?<=[,;\\s])(?:var |let |const )?([A-Za-z_$][\\w$]{1,5})=${literal}`, 'g');

const ternaryRe = new RegExp(`(?<=[,{(\\s])([A-Za-z_$][\\w$]*):([A-Za-z_$][\\w$.!]{0,40})\\?${literal}:${literal}`, 'g');
const branchRe = new RegExp(`(?:\\?|(?<=["\\)]):)${literal}`, 'g');
const templateRe = /(?<=[,;{(\s])(?:([A-Za-z_$][\w$]*):|(?:const |let |var )?([A-Za-z_$][\w$]{0,5})=)`((?:[^`\\$]|\\.|\$(?!\{)|\$\{[^{}`]*\})*)`/g;
const shortName = file => file.replace('workbench.', '').replace('.main.js', '');

const looksLikeUi = (text, strict) => {
  if (!/[A-Za-z]{2}/.test(text) || /[\u3400-\u9fff]/.test(text)) return false;
  if (!/^[A-Z"'(“]/.test(text)) return false;
  if (/[{}<>`|\\]|=>|::|\$\{|https?:|www\.|\.(js|ts|json|md|tsx|css|svg|png|py)\b|^[A-Z0-9_]+$|^[A-Z][a-z]+[A-Z]\w*$/.test(text)) return false;
  if (/^[\w.-]+\/[\w./-]+$/.test(text)) return false;
  const words = text.trim().split(/\s+/);
  return strict ? words.length >= 2 && /[a-z]/.test(text) : true;
};

const results = new Map();
for (const file of files) {
  const content = await fs.readFile(path.join(workbenchDir, file), 'utf8');

  // 被比较、作为 case 分支或计算属性键使用的短标识符，其常量值不能改。
  const logicIds = new Set();
  for (const m of content.matchAll(/(?:[=!]==|case |\[)([A-Za-z_$][\w$]{1,5})\b/g)) logicIds.add(m[1]);
  for (const m of content.matchAll(/\b([A-Za-z_$][\w$]{1,5})(?:[=!]==|\]:)/g)) logicIds.add(m[1]);

  const add = (match, key, raw, strict) => {
    if (!looksLikeUi(raw, strict)) return;
    const before = content.slice(Math.max(0, match.index - 5), match.index);
    const after = content.slice(match.index + match[0].length, match.index + match[0].length + 4);
    if (/[=!]==?$|case $/.test(before) || /^\s*[=!]==|^\]:/.test(after)) return;
    const id = `${file}\u0000${match[0]}`;
    if (!results.has(id)) {
      results.set(id, { file: file.replace('workbench.', '').replace('.main.js', ''), source: match[0], key, text: raw });
    }
  };

  for (const m of content.matchAll(keyRe)) {
    const key = m[1];
    if (key !== '"aria-label"' && !uiKeyWord.test(key)) continue;
    add(m, key, m[2], false);
  }
  for (const m of content.matchAll(constRe)) {
    if (logicIds.has(m[1])) continue;
    add(m, `const:${m[1]}`, m[2], true);
  }

  // 三元分支里的完整句子（至少 3 个单词）：?"..." 或 ":"..."。
  for (const m of content.matchAll(branchRe)) {
    const raw = m[1];
    if (raw.trim().split(/\s+/).length < 3) continue;
    add(m, 'branch', raw, true);
  }

  // 三元分支：description:cond?"A":"B"，两个分支都是界面文案时整体作为一条规则。
  for (const m of content.matchAll(ternaryRe)) {
    const [whole, key, , a, b] = m;
    if (!uiKeyWord.test(key) || !looksLikeUi(a, true) || !looksLikeUi(b, true)) continue;
    const id = `${file}\u0000${whole}`;
    if (!results.has(id)) results.set(id, { file: shortName(file), source: whole, key, kind: 'ternary', parts: [a, b] });
  }

  // 模板字符串：key:`... ${expr} ...` 或 x=`...`，${} 内不含反引号和花括号嵌套。
  for (const m of content.matchAll(templateRe)) {
    const [whole, key, constName, raw] = m;
    if (key ? !uiKeyWord.test(key) : logicIds.has(constName)) continue;
    const exprs = [];
    const text = raw.replace(/\$\{([^{}`]*)\}/g, (_x, expr) => `{${exprs.push(expr) - 1}}`);
    if (text.includes('${') || exprs.length === 0) continue;
    const staticText = text.replace(/\{\d+\}/g, ' ').trim();
    if (!looksLikeUi(staticText.charAt(0).toUpperCase() + staticText.slice(1), true) || staticText.split(/\s+/).length < 2) continue;
    const id = `${file}\u0000${whole}`;
    if (!results.has(id)) results.set(id, { file: shortName(file), source: whole, key: key ?? `const:${constName}`, kind: 'template', text, exprs });
  }
}

const list = [...results.values()];
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${JSON.stringify(list, null, 1)}\n`, 'utf8');
const byFile = list.reduce((acc, item) => ({ ...acc, [item.file]: (acc[item.file] ?? 0) + 1 }), {});
console.log(`candidates: ${list.length}`, byFile, `unique texts: ${new Set(list.map(item => item.text)).size}`);
