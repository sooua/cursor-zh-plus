import * as vscode from 'vscode';
import { launchCursorRestartHelper, shutdownCursorProcesses } from './cursorProcessManager';
import { CursorInstall, locateCursorInstall, validateCursorRoot } from './cursorLocator';
import { ManagerViewState, renderManagerView } from './managerView';
import { applyNlsMessagePatch, deleteNlsMessageBackup, NlsMessagePatchScanResult, restoreNlsMessageBackup, scanNlsMessagePatch, unapplyNlsMessagePatch } from './nlsMessagePatcher';
import { createScopedProgress, ProgressCallback, reportProgress } from './progress';
import { cleanLanguagePackCache, cleanRuntimeState, RuntimeStateScanResult, scanRuntimeState } from './runtimeStateCleaner';
import { applyWorkbenchPatch, deleteWorkbenchBackup, PatchScanResult, restoreWorkbenchBackup, scanWorkbenchPatch, unapplyWorkbenchPatch } from './workbenchPatcher';

type ManagerState = ManagerViewState;

interface WebviewMessage {
  readonly command: 'autoLocate' | 'chooseRoot' | 'rescan' | 'applyPatch' | 'cleanRuntimeState' | 'unapplyPatch' | 'restoreWorkbenchBackup' | 'restoreNlsBackup' | 'deleteWorkbenchBackup' | 'deleteNlsBackup' | 'shutdownCursor' | 'restartCursor';
  readonly backupPath?: string;
}

export class ManagerPanel {
  public static current?: ManagerPanel;

  private readonly logs: string[] = [];
  private state: ManagerState = { logs: this.logs };
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext
  ) {
    this.panel.onDidDispose(() => this.dispose(), undefined, this.context.subscriptions);
    this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message as WebviewMessage), undefined, this.context.subscriptions);
    void this.refresh(true, '管理器加载');
  }

  public static reveal(context: vscode.ExtensionContext): void {
    if (ManagerPanel.current) {
      ManagerPanel.current.panel.reveal(vscode.ViewColumn.One);
      void ManagerPanel.current.refresh(false, '管理器刷新');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'cursorZhPlusManager',
      'Cursor 中文增强',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    ManagerPanel.current = new ManagerPanel(panel, context);
  }

  private dispose(): void {
    this.disposed = true;
    ManagerPanel.current = undefined;
  }

  private async runOperation<T>(operation: string, task: (progress: ProgressCallback) => Promise<T>): Promise<T | undefined> {
    if (this.state.progress) {
      this.log(`已有操作正在进行：${this.state.progress.operation}`);
      this.render();
      return undefined;
    }

    const progress: ProgressCallback = update => {
      this.updateState({ progress: { ...update, operation } });
      this.render();
    };

    try {
      await reportProgress(progress, { message: '准备开始', percent: 0 });
      return await task(progress);
    } finally {
      this.updateState({ progress: undefined });
      this.render();
    }
  }

  private updateState(update: Omit<Partial<ManagerState>, 'logs'>): void {
    this.state = {
      ...this.state,
      ...update,
      logs: this.logs
    };
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.command) {
        case 'autoLocate':
          await this.autoLocate();
          break;
        case 'chooseRoot':
          await this.chooseRoot();
          break;
        case 'rescan':
          await this.refresh(true, '重新扫描');
          break;
        case 'applyPatch':
          await this.applyPatch();
          break;
        case 'cleanRuntimeState':
          await this.cleanRuntimeState();
          break;
        case 'unapplyPatch':
          await this.unapplyPatch();
          break;
        case 'restoreWorkbenchBackup':
          await this.restoreWorkbenchBackup(message.backupPath);
          break;
        case 'restoreNlsBackup':
          await this.restoreNlsBackup(message.backupPath);
          break;
        case 'deleteWorkbenchBackup':
          await this.deleteWorkbenchBackup(message.backupPath);
          break;
        case 'deleteNlsBackup':
          await this.deleteNlsBackup(message.backupPath);
          break;
        case 'shutdownCursor':
          await this.shutdownCursor();
          break;
        case 'restartCursor':
          await this.restartCursor();
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(message);
      void vscode.window.showErrorMessage(message);
      this.render();
    }
  }

  private async refresh(scanOnly: boolean, operation = scanOnly ? '重新扫描' : '管理器刷新'): Promise<void> {
    await this.runOperation(operation, async progress => {
      const configuredRoot = vscode.workspace.getConfiguration('cursorZhCn').get<string>('cursorRoot')?.trim();

      if (!configuredRoot && scanOnly) {
        await this.autoLocateCore(createScopedProgress(progress, 5, 100, '自动识别'));
        return;
      }

      if (configuredRoot) {
        await this.loadRoot(configuredRoot, '已保存配置', progress);
      } else {
        this.updateState({ cursorRoot: undefined, install: undefined, patch: undefined, nlsPatch: undefined, runtimeState: undefined });
        await reportProgress(progress, { message: '未配置 Cursor 安装目录', percent: 100 });
      }
    });
  }

  private async autoLocate(): Promise<void> {
    await this.runOperation('自动识别', progress => this.autoLocateCore(progress));
  }

  private async autoLocateCore(progress: ProgressCallback | undefined): Promise<void> {
    this.log('开始自动识别 Cursor 安装目录。');
    const configuredRoot = vscode.workspace.getConfiguration('cursorZhCn').get<string>('cursorRoot');
    const result = await locateCursorInstall(configuredRoot, createScopedProgress(progress, 0, 70, '识别安装目录'));

    if (!result.install) {
      this.updateState({ cursorRoot: undefined, install: undefined, patch: undefined, nlsPatch: undefined });
      this.log(`自动识别失败，已检查 ${result.candidates.length} 个候选路径。`);
      await reportProgress(progress, {
        message: `自动识别失败，已检查 ${result.candidates.length} 个候选路径`,
        percent: 100,
        current: result.candidates.length,
        total: result.candidates.length
      });
      return;
    }

    await reportProgress(progress, { message: '保存识别到的 Cursor 路径', percent: 72 });
    await saveCursorRoot(result.install.root);
    await this.loadInstall(result.install, createScopedProgress(progress, 75, 99, '加载安装数据'));
    this.log(`已识别 Cursor ${result.install.version ?? '未知版本'}: ${result.install.root}`);
    await reportProgress(progress, { message: '自动识别完成', percent: 100 });
  }

  private async chooseRoot(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '选择 Cursor 安装目录'
    });

    const folder = selected?.[0]?.fsPath;
    if (!folder) {
      return;
    }

    await this.runOperation('手动选择 Cursor 路径', async progress => {
      const install = await validateCursorRoot(folder, '手动选择', createScopedProgress(progress, 0, 35, '校验安装目录'));
      if (!install.valid) {
        this.log(`目录校验失败: ${install.problems.join('；')}`);
        void vscode.window.showErrorMessage('所选目录不是有效的 Cursor 安装根目录。');
        this.updateState({ cursorRoot: folder, install, patch: undefined, nlsPatch: undefined });
        await reportProgress(progress, { message: '目录校验失败', percent: 100, current: 0, total: 1 });
        return;
      }

      await reportProgress(progress, { message: '保存手动选择路径', percent: 40, current: 1, total: 1 });
      await saveCursorRoot(install.root);
      await this.loadInstall(install, createScopedProgress(progress, 45, 99, '加载安装数据'));
      this.log(`已保存手动选择路径: ${install.root}`);
      await reportProgress(progress, { message: '手动选择完成', percent: 100, current: 1, total: 1 });
    });
  }

  private async applyPatch(): Promise<void> {
    await this.runOperation('应用补丁', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const allowed = vscode.workspace.getConfiguration('cursorZhCn').get<boolean>('enableWorkbenchPatch', true);
      if (!allowed) {
        throw new Error('配置 cursorZhCn.enableWorkbenchPatch 已禁用，未执行补丁。');
      }

      const result = await applyWorkbenchPatch(install.root, this.context, createScopedProgress(progress, 0, 58, 'Workbench 补丁'));
      const nlsResult = await applyNlsMessagePatch(install.root, this.context, createScopedProgress(progress, 58, 92, 'NLS 消息表补丁'));
      const runtimeState = await scanRuntimeState(createScopedProgress(progress, 92, 100, '扫描运行时状态库'));
      this.updateState({
        patch: result.after,
        nlsPatch: nlsResult.after,
        runtimeState,
        restartPending: this.state.restartPending || result.changed || nlsResult.changed
      });
      this.log(`Cursor 根目录: ${result.after.cursorRoot}`);
      this.log(`Workbench 文件: ${result.after.filePath}`);
      this.log(`NLS 消息表: ${nlsResult.after.filePath}`);
      this.log(`Workbench 补丁命中: 英文源 ${result.before.sourceHits} 处，已翻译 ${result.before.targetHits} 处，本次写入 ${result.appliedRuleIds.length} 项/${result.appliedOccurrences} 处。`);
      this.log(`NLS 补丁命中: 英文源 ${nlsResult.before.sourceHits} 处，已翻译 ${nlsResult.before.targetHits} 处，本次写入 ${nlsResult.appliedRuleIds.length} 项/${nlsResult.appliedOccurrences} 处。`);
      this.log(result.changed
        ? `Workbench 补丁已应用，备份: ${result.backupPath}`
        : `Workbench 补丁未写入：英文源 ${result.before.sourceHits} 处，已翻译 ${result.before.targetHits} 处。`);
      this.log(nlsResult.changed
        ? `NLS 消息表补丁已应用，备份: ${nlsResult.backupPath}`
        : `NLS 消息表补丁未写入：英文源 ${nlsResult.before.sourceHits} 处，已翻译 ${nlsResult.before.targetHits} 处。`);
      this.log(runtimeState.state === 'dirty'
        ? '运行时 UI 状态仍有缓存：请点击「一键重启并清理 Cursor」。'
        : `运行时 UI 状态：${runtimeState.message}`);
    });
  }

  private async cleanRuntimeState(): Promise<void> {
    await this.runOperation('清理运行时 UI 状态', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const result = await cleanRuntimeState(install.root, createScopedProgress(progress, 0, 82, '清理运行时 UI 状态'));
      const languagePackCache = result.state === 'cursor-running'
        ? undefined
        : await cleanLanguagePackCache(createScopedProgress(progress, 82, 96, '重建语言包缓存'));
      const runtimeState = await scanRuntimeState(createScopedProgress(progress, 96, 100, '复扫运行时状态库'));
      this.updateState({ runtimeState });
      this.log(formatRuntimeCleanLog(result));
      if (languagePackCache) {
        this.log(languagePackCache.message);
        if (languagePackCache.backupRoot) {
          this.log(`语言包缓存备份: ${languagePackCache.backupRoot}`);
        }
      }
    });
  }

  private async unapplyPatch(): Promise<void> {
    await this.runOperation('卸载补丁', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const result = await unapplyWorkbenchPatch(install.root, this.context, createScopedProgress(progress, 0, 62, 'Workbench 补丁'));
      const nlsResult = await unapplyNlsMessagePatch(install.root, this.context, createScopedProgress(progress, 62, 100, 'NLS 消息表补丁'));
      this.updateState({
        patch: result.after,
        nlsPatch: nlsResult.after,
        restartPending: this.state.restartPending || result.changed || nlsResult.changed
      });
      this.log(`Workbench 文件: ${result.after.filePath}`);
      this.log(`NLS 消息表: ${nlsResult.after.filePath}`);
      this.log(result.changed
        ? `Workbench 补丁已卸载，反向处理 ${result.unappliedRuleIds.length} 项，卸载前快照: ${result.safetyBackupPath}`
        : 'Workbench 补丁未卸载：当前文件没有命中已应用的中文补丁。');
      this.log(nlsResult.changed
        ? `NLS 消息表补丁已卸载，反向处理 ${nlsResult.unappliedRuleIds.length} 项，卸载前快照: ${nlsResult.safetyBackupPath}`
        : 'NLS 消息表补丁未卸载：当前文件没有命中已应用的中文补丁。');
    });
  }

  private async restoreWorkbenchBackup(backupPath?: string): Promise<void> {
    await this.runOperation('恢复 Workbench 备份', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const selectedBackupPath = backupPath ?? this.state.patch?.backups.find(backup => backup.currentMetadataBackup)?.path ?? this.state.patch?.backups[0]?.path;
      if (!selectedBackupPath) {
        throw new Error('没有可恢复的 Workbench 备份文件。');
      }

      const result = await restoreWorkbenchBackup(install.root, this.context, selectedBackupPath, progress);
      this.updateState({ patch: result.after, restartPending: true });
      this.log(`Workbench 已从备份恢复: ${result.backupPath}`);
      this.log(`Workbench 恢复前快照: ${result.safetyBackupPath}`);
    });
  }

  private async restoreNlsBackup(backupPath?: string): Promise<void> {
    await this.runOperation('恢复 NLS 消息表备份', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const selectedBackupPath = backupPath ?? this.state.nlsPatch?.backups.find(backup => backup.currentMetadataBackup)?.path ?? this.state.nlsPatch?.backups[0]?.path;
      if (!selectedBackupPath) {
        throw new Error('没有可恢复的 NLS 消息表备份文件。');
      }

      const result = await restoreNlsMessageBackup(install.root, this.context, selectedBackupPath, progress);
      this.updateState({ nlsPatch: result.after, restartPending: true });
      this.log(`NLS 消息表已从备份恢复: ${result.backupPath}`);
      this.log(`NLS 消息表恢复前快照: ${result.safetyBackupPath}`);
    });
  }

  private async deleteWorkbenchBackup(backupPath?: string): Promise<void> {
    if (!backupPath || !await confirmDeleteBackup(backupPath)) {
      return;
    }

    await this.runOperation('删除 Workbench 备份', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      if (!backupPath) {
        throw new Error('未指定要删除的备份文件。');
      }

      await deleteWorkbenchBackup(backupPath, progress);
      
      // 重新扫描以更新备份列表
      const patch = await scanWorkbenchPatch(install.root, this.context, progress);
      this.updateState({ patch });
      this.log(`Workbench 备份已删除: ${backupPath}`);
    });
  }

  private async deleteNlsBackup(backupPath?: string): Promise<void> {
    if (!backupPath || !await confirmDeleteBackup(backupPath)) {
      return;
    }

    await this.runOperation('删除 NLS 消息表备份', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      if (!backupPath) {
        throw new Error('未指定要删除的备份文件。');
      }

      await deleteNlsMessageBackup(backupPath, progress);
      
      // 重新扫描以更新备份列表
      const nlsPatch = await scanNlsMessagePatch(install.root, this.context, progress);
      this.updateState({ nlsPatch });
      this.log(`NLS 消息表备份已删除: ${backupPath}`);
    });
  }

  private async shutdownCursor(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      '将关闭当前识别到的 Cursor 安装对应的所有 Cursor.exe 进程。未保存的编辑器内容可能丢失，请先保存重要内容。',
      { modal: true },
      '强制关闭 Cursor'
    );
    if (confirmed !== '强制关闭 Cursor') {
      return;
    }

    await this.runOperation('强制关闭 Cursor', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const result = await shutdownCursorProcesses(install.root, progress);
      this.log(`强制关闭 Cursor: 发现 ${result.before.length} 个进程，已关闭 ${result.closedCount} 个，强制结束 ${result.forcedCount} 个，剩余 ${result.after.length} 个。`);
      if (result.after.length > 0) {
        this.log(`仍未关闭的进程: ${result.after.map(item => item.id).join(', ')}`);
      }
    });
  }

  private async restartCursor(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      '将启动独立助手接管后续操作：关闭当前 Cursor、清理 state.vscdb 运行时 UI 缓存、重建 zh-cn 语言包合成缓存，然后重新启动 Cursor。未保存内容可能丢失，请先保存重要内容。',
      { modal: true },
      '重启并清理 Cursor'
    );
    if (confirmed !== '重启并清理 Cursor') {
      return;
    }

    await this.runOperation('重启并清理 Cursor', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const result = await launchCursorRestartHelper(install.root, this.context, { cleanRuntimeState: true }, progress);
      this.log(`独立助手已启动，Cursor 即将关闭并重启: ${result.executablePath}`);
      this.log(`助手日志: ${result.logPath}`);
      void vscode.window.showInformationMessage('独立助手已接管：Cursor 即将关闭、清理运行时状态、重建语言包缓存并重新启动。');
    });
  }

  private async loadRoot(root: string, source: string, progress?: ProgressCallback): Promise<void> {
    const install = await validateCursorRoot(root, source, createScopedProgress(progress, 0, 30, '校验安装目录'));
    await this.loadInstall(install, createScopedProgress(progress, 30, 100, '加载安装数据'));
  }

  private async loadInstall(install: CursorInstall, progress?: ProgressCallback): Promise<void> {
    let patch: PatchScanResult | undefined;
    let nlsPatch: NlsMessagePatchScanResult | undefined;
    let runtimeState: RuntimeStateScanResult | undefined;
    await reportProgress(progress, { message: '准备加载安装数据', percent: 0 });

    if (install.valid) {
      try {
        patch = await scanWorkbenchPatch(install.root, this.context, createScopedProgress(progress, 10, 45, '扫描 Workbench 补丁数据'));
      } catch (error) {
        this.log(error instanceof Error ? error.message : String(error));
      }

      try {
        nlsPatch = await scanNlsMessagePatch(install.root, this.context, createScopedProgress(progress, 45, 78, '扫描 NLS 消息表补丁数据'));
      } catch (error) {
        this.log(error instanceof Error ? error.message : String(error));
      }

      try {
        runtimeState = await scanRuntimeState(createScopedProgress(progress, 78, 95, '扫描运行时状态库'));
      } catch (error) {
        this.log(error instanceof Error ? error.message : String(error));
      }
    }

    this.updateState({
      cursorRoot: install.root,
      install,
      patch,
      nlsPatch,
      runtimeState
    });
    await reportProgress(progress, {
      message: install.valid ? '安装数据加载完成' : '安装目录无效',
      percent: 100,
      current: install.valid ? 1 : 0,
      total: 1
    });
  }

  private log(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    this.logs.unshift(`[${timestamp}] ${message}`);
    this.logs.splice(80);
  }

  private render(): void {
    if (this.disposed) {
      return;
    }

    this.panel.webview.html = renderManagerView(this.state, this.panel.webview.cspSource);
  }
}

async function confirmDeleteBackup(backupPath: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `删除后无法找回此备份：\n${backupPath}`,
    { modal: true },
    '删除备份'
  );
  return choice === '删除备份';
}

async function saveCursorRoot(root: string): Promise<void> {
  await vscode.workspace.getConfiguration('cursorZhCn').update('cursorRoot', root, vscode.ConfigurationTarget.Global);
}

function formatRuntimeCleanLog(result: Awaited<ReturnType<typeof cleanRuntimeState>>): string {
  if (result.changed) {
    return `运行时 UI 状态已清理：字段 ${result.cleanedFields.length} 个，删除记录 ${result.deletedRecords} 条。${result.runningProcessIds.length > 0 ? `Cursor 正在运行，进程 ${result.runningProcessIds.join(', ')}。` : ''}`;
  }

  return `运行时 UI 状态未写入：${result.message}`;
}
