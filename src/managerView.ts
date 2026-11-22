import type { CursorInstall } from './cursorLocator';
import type { NlsMessagePatchScanResult } from './nlsMessagePatcher';
import type { ProgressUpdate } from './progress';
import type { RuntimeStateScanResult } from './runtimeStateCleaner';
import type { PatchBackupInfo, PatchScanResult, PatchState } from './workbenchPatcher';

export interface ManagerViewState {
  readonly cursorRoot?: string;
  readonly install?: CursorInstall;
  readonly patch?: PatchScanResult;
  readonly nlsPatch?: NlsMessagePatchScanResult;
  readonly runtimeState?: RuntimeStateScanResult;
  readonly progress?: ProgressUpdate & { readonly operation: string };
  readonly restartPending?: boolean;
  readonly logs: readonly string[];
}

type Phase = 'busy' | 'unlocated' | 'invalid' | 'unscanned' | 'ready' | 'partial' | 'needs-restart' | 'applied';
type Tone = 'ok' | 'warn' | 'idle' | 'busy';

interface Action {
  readonly command: string;
  readonly label: string;
}

interface Hero {
  readonly tone: Tone;
  readonly title: string;
  readonly note?: string;
  readonly primary?: Action;
  readonly secondary?: Action;
}

const patchStateText: Record<PatchState, string> = {
  'not-applied': '未汉化',
  applied: '已汉化',
  partial: '部分汉化',
  unknown: '未知'
};

export function renderManagerView(state: ManagerViewState, cspSource: string): string {
  const nonce = getNonce();
  const phase = getPhase(state);
  const hero = getHero(phase, state);
  const busy = Boolean(state.progress);
  const disabled = busy ? ' disabled' : '';
  const showLocation = phase !== 'unlocated' && phase !== 'invalid' && Boolean(state.cursorRoot);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cursor 中文增强</title>
  <style>${styles}</style>
</head>
<body>
  <main class="shell" data-phase="${phase}" data-testid="manager" aria-busy="${busy}">
    <header class="top">
      <h1>Cursor 中文增强</h1>
      ${state.install?.version ? `<span class="chip" data-testid="cursor-version">Cursor ${escapeHtml(state.install.version)}</span>` : ''}
    </header>

    <section class="hero" data-tone="${hero.tone}" data-testid="hero" aria-labelledby="hero-title">
      <span class="mark" aria-hidden="true"></span>
      <div class="hero-body">
        <h2 id="hero-title">${escapeHtml(hero.title)}</h2>
        ${hero.note ? `<p class="note" aria-live="polite">${escapeHtml(hero.note)}</p>` : ''}
        ${phase === 'invalid' ? renderProblems(state.install?.problems ?? []) : ''}
        ${state.progress ? renderProgress(state.progress.percent) : ''}
        ${hero.primary || hero.secondary ? `<div class="row">
          ${hero.primary ? renderButton(hero.primary, 'primary', disabled) : ''}
          ${hero.secondary ? renderButton(hero.secondary, 'secondary', disabled) : ''}
        </div>` : ''}
      </div>
    </section>

    ${state.install?.valid ? renderTargets(state) : ''}

    ${showLocation ? `<section class="location" aria-labelledby="loc-title">
      <h3 id="loc-title" class="label">安装目录</h3>
      <code class="path" data-testid="cursor-root" title="${escapeHtml(state.cursorRoot ?? '')}">${escapeHtml(state.cursorRoot ?? '')}</code>
      <div class="row tight">
        ${renderButton({ command: 'autoLocate', label: '自动识别' }, 'ghost', disabled)}
        ${renderButton({ command: 'chooseRoot', label: '浏览…' }, 'ghost', disabled)}
      </div>
    </section>` : ''}

    ${state.install?.valid ? `<details class="fold" data-fold="advanced" data-testid="advanced">
      <summary>高级</summary>
      <div class="fold-body">
        <div class="row">
          ${renderButton({ command: 'rescan', label: '重新扫描' }, 'secondary', disabled)}
          ${renderButton({ command: 'cleanRuntimeState', label: '清理界面缓存' }, 'secondary', disabled)}
          ${renderButton({ command: 'shutdownCursor', label: '强制关闭 Cursor' }, 'secondary', disabled)}
          ${renderButton({ command: 'unapplyPatch', label: '卸载汉化' }, 'danger', disabled)}
        </div>
        ${renderBackupGroup('界面文本备份', 'workbench', state.patch?.backups ?? [], disabled)}
        ${renderBackupGroup('消息表备份', 'nls', state.nlsPatch?.backups ?? [], disabled)}
      </div>
    </details>` : ''}

    <details class="fold" data-fold="log" data-testid="log">
      <summary>日志${state.logs.length ? ` <span class="count">${state.logs.length}</span>` : ''}</summary>
      <div class="fold-body">
        ${state.logs.length
          ? `<ol class="log">${state.logs.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ol>`
          : '<p class="muted">执行操作后会在这里记录结果。</p>'}
      </div>
    </details>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const saved = vscode.getState() || {};
    const folds = saved.folds || {};

    document.querySelectorAll('details[data-fold]').forEach(el => {
      if (folds[el.dataset.fold]) el.open = true;
      el.addEventListener('toggle', () => {
        folds[el.dataset.fold] = el.open;
        vscode.setState({ ...saved, folds });
      });
    });

    document.querySelectorAll('button[data-command]').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ command: btn.dataset.command, backupPath: btn.dataset.backup });
      });
    });
  </script>
</body>
</html>`;
}

function getPhase(state: ManagerViewState): Phase {
  if (state.progress) {
    return 'busy';
  }
  if (!state.install) {
    return 'unlocated';
  }
  if (!state.install.valid) {
    return 'invalid';
  }
  if (!state.patch || !state.nlsPatch) {
    return 'unscanned';
  }

  const states = [state.patch.state, state.nlsPatch.state];
  if (states.every(item => item === 'applied')) {
    return state.restartPending || state.runtimeState?.state === 'dirty' ? 'needs-restart' : 'applied';
  }
  if (states.some(item => item === 'partial' || item === 'applied')) {
    return 'partial';
  }
  return 'ready';
}

function getHero(phase: Phase, state: ManagerViewState): Hero {
  switch (phase) {
    case 'busy':
      // 进度消息带有逐级拼接的前缀（如「自动识别：加载安装数据：…」），只显示最后一级。
      return { tone: 'busy', title: state.progress?.operation ?? '处理中', note: state.progress?.message.split('：').pop() };
    case 'unlocated':
      return {
        tone: 'idle',
        title: '未找到 Cursor',
        primary: { command: 'autoLocate', label: '自动识别' },
        secondary: { command: 'chooseRoot', label: '浏览…' }
      };
    case 'invalid':
      return {
        tone: 'warn',
        title: '所选目录不是 Cursor 安装目录',
        note: '请选择包含 resources\\app 的目录。',
        primary: { command: 'autoLocate', label: '自动识别' },
        secondary: { command: 'chooseRoot', label: '重新选择…' }
      };
    case 'unscanned':
      return {
        tone: 'warn',
        title: '无法读取汉化状态',
        note: '原因见日志。',
        primary: { command: 'rescan', label: '重新扫描' }
      };
    case 'ready':
      return { tone: 'idle', title: '尚未汉化', primary: { command: 'applyPatch', label: '应用汉化' } };
    case 'partial':
      return {
        tone: 'warn',
        title: '部分汉化',
        note: 'Cursor 更新后常见，重新应用即可。',
        primary: { command: 'applyPatch', label: '重新应用' }
      };
    case 'needs-restart':
      return { tone: 'warn', title: '重启 Cursor 后生效', primary: { command: 'restartCursor', label: '重启 Cursor' } };
    case 'applied':
      return { tone: 'ok', title: '已汉化', secondary: { command: 'restartCursor', label: '重启 Cursor' } };
  }
}

function renderTargets(state: ManagerViewState): string {
  const rows = [
    renderTarget('界面文本', 'workbench', state.patch?.state, state.patch && `已汉化 ${state.patch.targetHits} · 未汉化 ${state.patch.sourceHits} · 规则 ${state.patch.totalRules}\n${state.patch.filePath}`),
    renderTarget('消息表', 'nls', state.nlsPatch?.state, state.nlsPatch && `已汉化 ${state.nlsPatch.targetHits} · 未汉化 ${state.nlsPatch.sourceHits} · 规则 ${state.nlsPatch.totalRules}\n${state.nlsPatch.filePath}`),
    renderCacheTarget(state.runtimeState)
  ];
  return `<section aria-label="汉化范围"><ul class="targets">${rows.join('')}</ul></section>`;
}

function renderTarget(label: string, id: string, patchState: PatchState | undefined, detail: string | undefined): string {
  const value = patchState ? patchStateText[patchState] : '未扫描';
  const tone: Tone = patchState === 'applied' ? 'ok' : patchState === 'partial' ? 'warn' : 'idle';
  return `<li class="target" data-testid="target-${id}" data-state="${patchState ?? 'unscanned'}"${detail ? ` title="${escapeHtml(detail)}"` : ''}>
    <span class="target-name">${escapeHtml(label)}</span>
    <span class="badge" data-tone="${tone}">${escapeHtml(value)}</span>
  </li>`;
}

function renderCacheTarget(runtime: RuntimeStateScanResult | undefined): string {
  const text: Record<RuntimeStateScanResult['state'], string> = {
    'not-found': '无',
    clean: '无残留',
    cleaned: '已清理',
    dirty: '有英文残留',
    'cursor-running': 'Cursor 运行中',
    failed: '读取失败'
  };
  const tone: Tone = !runtime ? 'idle'
    : runtime.state === 'dirty' || runtime.state === 'failed' ? 'warn'
      : runtime.state === 'cursor-running' ? 'idle' : 'ok';
  const detail = runtime ? `${runtime.message}\n${runtime.filePath}` : undefined;
  return `<li class="target" data-testid="target-cache" data-state="${runtime?.state ?? 'unscanned'}"${detail ? ` title="${escapeHtml(detail)}"` : ''}>
    <span class="target-name">界面缓存</span>
    <span class="badge" data-tone="${tone}">${escapeHtml(runtime ? text[runtime.state] : '未扫描')}</span>
  </li>`;
}

function renderBackupGroup(title: string, type: 'workbench' | 'nls', backups: readonly PatchBackupInfo[], disabled: string): string {
  const restore = type === 'workbench' ? 'restoreWorkbenchBackup' : 'restoreNlsBackup';
  const remove = type === 'workbench' ? 'deleteWorkbenchBackup' : 'deleteNlsBackup';
  const body = backups.length === 0
    ? '<p class="muted">应用汉化时会自动创建备份。</p>'
    : `<ul class="backups">${backups.map(backup => `<li class="backup" data-testid="backup-${type}" data-kind="${backup.isOriginal ? 'original' : backup.kind}" title="${escapeHtml(backup.path)}">
        <span class="backup-kind">${escapeHtml(backupKindText(backup))}</span>
        <span class="backup-time">${escapeHtml(formatDateTime(backup.modifiedAt))}</span>
        ${backup.status.state === 'unknown' ? '<span></span>' : `<span class="badge" data-tone="${backup.status.state === 'not-applied' ? 'ok' : 'idle'}">${escapeHtml(backup.status.state === 'not-applied' ? '英文原版' : patchStateText[backup.status.state])}</span>`}
        <span class="row tight">
          <button class="ghost" data-command="${restore}" data-backup="${escapeHtml(backup.path)}" aria-label="恢复 ${escapeHtml(backup.name)}"${disabled}>恢复</button>
          <button class="ghost danger-text" data-command="${remove}" data-backup="${escapeHtml(backup.path)}" aria-label="删除 ${escapeHtml(backup.name)}"${disabled}>删除</button>
        </span>
      </li>`).join('')}</ul>`;

  return `<section class="group" aria-label="${escapeHtml(title)}">
    <h3 class="label">${escapeHtml(title)}</h3>
    ${body}
  </section>`;
}

function backupKindText(backup: PatchBackupInfo): string {
  const kind = backup.isOriginal ? '原始备份'
    : backup.kind === 'original' || backup.kind === 'before-apply' ? '应用前快照'
      : backup.kind === 'before-restore' ? '恢复前快照'
      : backup.kind === 'before-uninstall' ? '卸载前快照'
        : '其他备份';
  const target = backup.name.startsWith('workbench.glass.') ? 'Agents 窗口'
    : backup.name.startsWith('workbench.desktop.') ? '主窗口'
      : undefined;
  return [kind, target, backup.currentMetadataBackup ? '当前' : undefined].filter(Boolean).join(' · ');
}

function renderProblems(problems: readonly string[]): string {
  if (problems.length === 0) {
    return '';
  }
  return `<ul class="problems" role="alert">${problems.map(problem => `<li>${escapeHtml(problem)}</li>`).join('')}</ul>`;
}

function renderProgress(percent: number): string {
  return `<div class="progress" role="progressbar" aria-label="进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
    <span style="width: ${percent}%"></span>
  </div>
  <span class="percent">${percent}%</span>`;
}

function renderButton(action: Action, variant: 'primary' | 'secondary' | 'ghost' | 'danger', disabled: string): string {
  return `<button class="${variant}" data-command="${action.command}" data-testid="action-${action.command}"${disabled}>${escapeHtml(action.label)}</button>`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

const styles = `
  :root {
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --bg: var(--vscode-editor-background);
    --line: var(--vscode-widget-border, var(--vscode-panel-border));
    --raised: color-mix(in srgb, var(--fg) 4%, var(--bg));
    --ok: var(--vscode-testing-iconPassed, #3fb950);
    --warn: var(--vscode-editorWarning-foreground, #d29922);
    --danger: var(--vscode-errorForeground, #f85149);
    --accent: var(--vscode-button-background);
    --radius: 6px;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px 48px; color: var(--fg); background: var(--bg); font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.5; }
  h1, h2, h3, p, ul, ol { margin: 0; padding: 0; }
  ul, ol { list-style: none; }
  .shell { max-width: 640px; margin: 0 auto; display: grid; gap: 20px; }
  .top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  h1 { font-size: 13px; font-weight: 600; color: var(--muted); letter-spacing: 0.02em; }
  .chip { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--muted); }
  .label { font-size: 11px; font-weight: 600; color: var(--muted); }
  .muted { color: var(--muted); }

  .hero { display: grid; grid-template-columns: auto 1fr; gap: 16px; align-items: start; padding: 24px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--raised); }
  .mark { width: 14px; height: 14px; margin-top: 7px; border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 4px color-mix(in srgb, var(--muted) 18%, transparent); }
  .hero[data-tone="ok"] .mark { background: var(--ok); box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 22%, transparent); }
  .hero[data-tone="warn"] .mark { background: var(--warn); box-shadow: 0 0 0 4px color-mix(in srgb, var(--warn) 22%, transparent); }
  .hero[data-tone="busy"] .mark { background: transparent; border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent); border-top-color: var(--accent); box-shadow: none; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .hero[data-tone="busy"] .mark { animation: none; } }
  .hero-body { display: grid; gap: 10px; min-width: 0; }
  h2 { font-size: 20px; font-weight: 600; line-height: 1.3; }
  .note { color: var(--muted); overflow-wrap: anywhere; }
  .problems { display: grid; gap: 2px; color: var(--danger); font-size: 12px; }
  .progress { height: 4px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, var(--fg) 10%, transparent); }
  .progress span { display: block; height: 100%; background: var(--vscode-progressBar-background, var(--accent)); transition: width 160ms ease-out; }
  .percent { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--muted); }

  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .row.tight { gap: 4px; }
  .hero .row { margin-top: 6px; }
  button { font: inherit; font-weight: 500; padding: 6px 14px; border-radius: 4px; border: 1px solid transparent; cursor: pointer; color: var(--vscode-button-foreground); background: var(--accent); }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.ghost { padding: 3px 8px; color: var(--vscode-textLink-foreground); background: transparent; }
  button.ghost:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--fg) 8%, transparent)); }
  button.danger { color: var(--danger); background: transparent; border-color: color-mix(in srgb, var(--danger) 50%, transparent); }
  button.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 12%, transparent); }
  button.danger-text { color: var(--danger); }

  .targets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: var(--radius); }
  .target { display: grid; gap: 6px; padding: 12px 16px; min-width: 0; }
  .target + .target { border-left: 1px solid var(--line); }
  .target-name { font-size: 11px; font-weight: 600; color: var(--muted); }
  .badge { justify-self: start; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; white-space: nowrap; }
  .badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
  .badge[data-tone="ok"]::before { background: var(--ok); }
  .badge[data-tone="warn"]::before { background: var(--warn); }

  .location { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; }
  .path { padding: 0; background: none; color: var(--fg); font-family: var(--vscode-editor-font-family); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .fold { border-top: 1px solid var(--line); }
  .fold summary { display: flex; align-items: center; gap: 8px; padding: 12px 0; cursor: pointer; list-style: none; font-weight: 600; user-select: none; }
  .fold summary::-webkit-details-marker { display: none; }
  .fold summary::before { content: ""; width: 6px; height: 6px; border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted); transform: rotate(-45deg); transition: transform 120ms ease-out; }
  .fold[open] summary::before { transform: rotate(45deg); }
  .fold summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .count { font-size: 11px; font-weight: 500; color: var(--muted); }
  .fold-body { display: grid; gap: 20px; padding: 4px 0 16px 14px; }
  .group { display: grid; gap: 8px; }
  .backups { display: grid; border: 1px solid var(--line); border-radius: var(--radius); }
  .backup { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: 12px; align-items: center; padding: 6px 8px 6px 12px; }
  .backup + .backup { border-top: 1px solid var(--line); }
  .backup-kind { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .backup-time { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--muted); }
  .log { display: grid; gap: 2px; max-height: 240px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }

  @media (max-width: 520px) {
    .targets { grid-template-columns: 1fr; }
    .target + .target { border-left: 0; border-top: 1px solid var(--line); }
    .location { grid-template-columns: minmax(0, 1fr); gap: 6px; }
    .backup { grid-template-columns: minmax(0, 1fr) auto; }
    .backup-time { grid-column: 1; }
  }
`;
