import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { basename } from 'path';
import type { ChildProcess } from 'child_process';
import { spawnInShell } from '@dokkimi/platform';

export interface DefinitionEntry {
  file: string;
  name: string;
  testCount: number;
  errorCount: number;
  warningCount: number;
}

export interface FileEntry {
  file: string;
  name: string;
  itemType?: string;
}

export interface WorkspaceData {
  definitions: DefinitionEntry[];
  fragments: FileEntry[];
  initFiles: FileEntry[];
  baselines: FileEntry[];
}

export type RunStatus = 'running' | 'passed' | 'failed';

export class DokkimiSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'dokkimi.sidebar';
  private view?: vscode.WebviewView;
  private fileWatcher?: vscode.FileSystemWatcher;
  private activeRuns = new Map<string, ChildProcess>();
  private runStatuses = new Map<string, RunStatus>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.type === 'openFile') {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          const fileUri = vscode.Uri.joinPath(
            workspaceFolder.uri,
            message.file,
          );
          vscode.window.showTextDocument(fileUri);
        }
      }
      if (message.type === 'ready') {
        this.refreshTests();
        this.sendAllRunStatuses();
      }
      if (message.type === 'runFile') {
        this.runDefinition(message.file);
      }
      if (message.type === 'runAll') {
        for (const file of message.files as string[]) {
          this.runDefinition(file);
        }
      }
    });

    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      '**/.dokkimi/**/*.{json,yaml,yml}',
    );
    this.fileWatcher.onDidChange(() => this.refreshTests());
    this.fileWatcher.onDidCreate(() => this.refreshTests());
    this.fileWatcher.onDidDelete(() => this.refreshTests());

    const diagListener = vscode.languages.onDidChangeDiagnostics((e) => {
      const affected = e.uris.some((uri) => uri.fsPath.includes('.dokkimi'));
      if (affected) {
        this.refreshTests();
      }
    });

    webviewView.onDidDispose(() => {
      this.fileWatcher?.dispose();
      diagListener.dispose();
      for (const proc of this.activeRuns.values()) {
        proc.kill();
      }
      this.activeRuns.clear();
    });
  }

  private runDefinition(relativeFile: string) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return;
    }
    if (this.activeRuns.has(relativeFile)) {
      return;
    }

    this.setRunStatus(relativeFile, 'running');

    const callback = (err: Error | null) => {
      this.activeRuns.delete(relativeFile);
      this.setRunStatus(relativeFile, err ? 'failed' : 'passed');
    };

    const { process: proc } = spawnInShell(
      'npx',
      ['dokkimi', 'run', '--ci', relativeFile],
      { cwd: workspaceRoot },
      callback,
    );

    this.activeRuns.set(relativeFile, proc);
  }

  private setRunStatus(file: string, status: RunStatus) {
    this.runStatuses.set(file, status);
    this.view?.webview.postMessage({ type: 'runStatus', file, status });
  }

  private sendAllRunStatuses() {
    for (const [file, status] of this.runStatuses) {
      this.view?.webview.postMessage({ type: 'runStatus', file, status });
    }
  }

  private async refreshTests() {
    const workspace = await scanWorkspace();
    this.view?.webview.postMessage({ type: 'workspace', workspace });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicon.css'),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${codiconsUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function relativeTo(fsPath: string): string {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return fsPath.startsWith(workspaceRoot)
    ? fsPath.slice(workspaceRoot.length + 1)
    : fsPath;
}

const CONFIG_NAMES = new Set(['config.json', 'config.yaml', 'config.yml']);

async function scanWorkspace(): Promise<WorkspaceData> {
  const [dataFiles, scriptFiles, baselineFiles] = await Promise.all([
    vscode.workspace.findFiles(
      '**/.dokkimi/**/*.{json,yaml,yml}',
      '**/node_modules/**',
    ),
    vscode.workspace.findFiles(
      '**/.dokkimi/**/*.{sql,js}',
      '**/node_modules/**',
    ),
    vscode.workspace.findFiles(
      '**/.dokkimi/**/baselines/*.png',
      '**/node_modules/**',
    ),
  ]);

  const definitions: DefinitionEntry[] = [];
  const fragments: FileEntry[] = [];

  for (const file of dataFiles) {
    const fileName = basename(file.fsPath);
    if (CONFIG_NAMES.has(fileName)) {
      continue;
    }

    try {
      const raw = await vscode.workspace.fs.readFile(file);
      const text = Buffer.from(raw).toString('utf-8');
      const ext = file.fsPath.split('.').pop()?.toLowerCase();
      const parsed = ext === 'json' ? JSON.parse(text) : yaml.load(text);

      if (!parsed || typeof parsed !== 'object') {
        continue;
      }

      const relativePath = relativeTo(file.fsPath);
      const name = parsed.name ?? basename(file.fsPath, '.' + ext);
      const isRunnable =
        typeof parsed.name === 'string' && Array.isArray(parsed.items);

      if (isRunnable) {
        const testCount = Array.isArray(parsed.tests)
          ? parsed.tests.filter(
              (t: any) => typeof t.name === 'string' && t.name.length > 0,
            ).length
          : 0;

        const diagnostics = vscode.languages.getDiagnostics(file);
        const errorCount = diagnostics.filter(
          (d) => d.severity === vscode.DiagnosticSeverity.Error,
        ).length;
        const warningCount = diagnostics.filter(
          (d) => d.severity === vscode.DiagnosticSeverity.Warning,
        ).length;

        definitions.push({
          file: relativePath,
          name,
          testCount,
          errorCount,
          warningCount,
        });
      } else {
        fragments.push({
          file: relativePath,
          name,
          itemType: parsed.type,
        });
      }
    } catch {
      // skip unparseable files
    }
  }

  const initFiles: FileEntry[] = scriptFiles.map((file) => ({
    file: relativeTo(file.fsPath),
    name: basename(file.fsPath),
  }));

  const baselines: FileEntry[] = baselineFiles.map((file) => ({
    file: relativeTo(file.fsPath),
    name: basename(file.fsPath, '.png'),
  }));

  definitions.sort((a, b) => a.name.localeCompare(b.name));
  fragments.sort((a, b) => a.name.localeCompare(b.name));
  initFiles.sort((a, b) => a.name.localeCompare(b.name));
  baselines.sort((a, b) => a.name.localeCompare(b.name));

  return { definitions, fragments, initFiles, baselines };
}

function getNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
