import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { reportDumpResults, findItemByLabel } from './dump-watcher';

const INSTANCE_LINE_RE =
  /\[Dokkimi]\s+[✔✘-]\s+(\S+)\s+(PASSED|COMPLETED|FAILED|SKIPPED)/;

export function createRunProfile(
  controller: vscode.TestController,
  context: vscode.ExtensionContext,
): void {
  const outputChannel = vscode.window.createOutputChannel('Dokkimi');
  context.subscriptions.push(outputChannel);

  controller.createRunProfile(
    'Run',
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      const run = controller.createTestRun(request);
      const items = collectTestItems(request, controller);

      // Deduplicate to definition-level items (top-level test items)
      const definitionItems = new Map<string, vscode.TestItem>();
      for (const item of items) {
        const defItem = item.parent ?? item;
        definitionItems.set(defItem.id, defItem);
      }

      // Mark all as enqueued then started
      for (const [, defItem] of definitionItems) {
        run.enqueued(defItem);
        defItem.children.forEach((child) => run.enqueued(child));
      }
      for (const [, defItem] of definitionItems) {
        run.started(defItem);
        defItem.children.forEach((child) => run.started(child));
      }

      // Determine the CLI target
      const filePaths = [...definitionItems.values()]
        .map((item) => item.uri?.fsPath)
        .filter((p): p is string => !!p);

      const target = buildCliTarget(filePaths);

      if (!target) {
        for (const [, defItem] of definitionItems) {
          run.errored(defItem, new vscode.TestMessage('No file path'));
        }
        run.end();
        return;
      }

      try {
        await spawnRun(target, run, controller, outputChannel, token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const [, defItem] of definitionItems) {
          run.errored(defItem, new vscode.TestMessage(msg));
        }
      }

      // Read the dump for detailed assertion results
      try {
        reportDumpResults(controller, run);
      } catch {}

      run.end();
    },
    true,
  );
}

function collectTestItems(
  request: vscode.TestRunRequest,
  controller: vscode.TestController,
): vscode.TestItem[] {
  if (request.include) {
    return [...request.include];
  }
  const items: vscode.TestItem[] = [];
  controller.items.forEach((item) => items.push(item));
  return items;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCliTarget(filePaths: string[]): string | undefined {
  if (filePaths.length === 0) {
    return undefined;
  }
  if (filePaths.length === 1) {
    return filePaths[0];
  }
  const basenames = filePaths.map((fp) => {
    const ext = path.extname(fp);
    return escapeRegex(path.basename(fp, ext));
  });
  return `^(${basenames.join('|')})$`;
}

function spawnRun(
  target: string,
  run: vscode.TestRun,
  controller: vscode.TestController,
  outputChannel: vscode.OutputChannel,
  token: vscode.CancellationToken,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const proc = cp.spawn('dokkimi', ['run', '--ci', target], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      cwd,
    });

    const dispose = token.onCancellationRequested(() => {
      proc.kill();
    });

    outputChannel.appendLine(`> dokkimi run --ci ${target}`);

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      outputChannel.append(text);
      run.appendOutput(text.replace(/\n/g, '\r\n'));
      parseProgressLines(text, controller, run);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      outputChannel.append(text);
      run.appendOutput(text.replace(/\n/g, '\r\n'));
    });

    proc.on('error', (err) => {
      dispose.dispose();
      reject(err);
    });

    proc.on('close', () => {
      dispose.dispose();
      resolve();
    });
  });
}

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[\\d+m`, 'g');

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

function parseProgressLines(
  text: string,
  controller: vscode.TestController,
  run: vscode.TestRun,
): void {
  const lines = stripAnsi(text).split('\n');
  for (const line of lines) {
    const match = INSTANCE_LINE_RE.exec(line);
    if (!match) {
      continue;
    }
    const [, name, status] = match;
    const item = findItemByLabel(controller, name);
    if (!item) {
      continue;
    }
    if (status === 'PASSED' || status === 'COMPLETED') {
      run.passed(item);
      item.children.forEach((child) => run.passed(child));
    } else if (status === 'FAILED') {
      run.failed(
        item,
        new vscode.TestMessage(
          'Failed — details available after run completes',
        ),
      );
    } else if (status === 'SKIPPED') {
      run.skipped(item);
      item.children.forEach((child) => run.skipped(child));
    }
  }
}
