import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';

export const DEFINITION_GLOB = '**/.dokkimi/**/*.{json,yaml,yml}';
const CONFIG_FILES = new Set(['config.json', 'config.yaml', 'config.yml']);

export interface DefinitionTestItem {
  definitionName: string;
  filePath: string;
  testItem: vscode.TestItem;
}

export function createTestController(
  context: vscode.ExtensionContext,
): vscode.TestController {
  const controller = vscode.tests.createTestController('dokkimi', 'Dokkimi');
  context.subscriptions.push(controller);

  controller.resolveHandler = async () => {
    await discoverDefinitions(controller);
  };

  const watcher = vscode.workspace.createFileSystemWatcher(DEFINITION_GLOB);
  const refresh = () => discoverDefinitions(controller);
  watcher.onDidCreate(refresh);
  watcher.onDidChange(refresh);
  watcher.onDidDelete(refresh);
  context.subscriptions.push(watcher);

  return controller;
}

export async function discoverDefinitions(
  controller: vscode.TestController,
): Promise<void> {
  const files = await vscode.workspace.findFiles(DEFINITION_GLOB);

  const existingIds = new Set<string>();

  for (const file of files) {
    const basename = path.basename(file.fsPath);
    if (CONFIG_FILES.has(basename)) {
      continue;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(file);
      const parsed = parseDefinition(doc);
      if (!parsed) {
        continue;
      }

      const itemId = file.fsPath;
      existingIds.add(itemId);

      let testItem = controller.items.get(itemId);
      if (!testItem) {
        testItem = controller.createTestItem(itemId, parsed.name, file);
        testItem.range = new vscode.Range(0, 0, 0, 0);
        controller.items.add(testItem);
      } else {
        testItem.label = parsed.name;
      }

      // Add child test items for each named test
      const existingChildren = new Set<string>();
      for (const test of parsed.tests) {
        const childId = `${itemId}#${test.name}`;
        existingChildren.add(childId);
        let child = testItem.children.get(childId);
        if (!child) {
          child = controller.createTestItem(childId, test.name, file);
          if (test.line !== undefined) {
            child.range = new vscode.Range(test.line, 0, test.line, 0);
          }
          testItem.children.add(child);
        }
      }

      // Remove stale children
      testItem.children.forEach((child) => {
        if (!existingChildren.has(child.id)) {
          testItem!.children.delete(child.id);
        }
      });
    } catch {
      // Skip files that can't be parsed
    }
  }

  // Remove stale top-level items
  controller.items.forEach((item) => {
    if (!existingIds.has(item.id)) {
      controller.items.delete(item.id);
    }
  });
}

interface ParsedDefinition {
  name: string;
  tests: { name: string; line?: number }[];
}

function parseDefinition(doc: vscode.TextDocument): ParsedDefinition | null {
  const text = doc.getText();
  let parsed: Record<string, unknown>;

  if (doc.languageId === 'json') {
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
  } else {
    try {
      parsed = yaml.load(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const name = parsed.name;
  const items = parsed.items;
  if (typeof name !== 'string' || !Array.isArray(items)) {
    return null;
  }

  const tests: { name: string; line?: number }[] = [];
  const testsArray = parsed.tests;
  if (Array.isArray(testsArray)) {
    for (const t of testsArray) {
      if (t && typeof t === 'object' && typeof t.name === 'string') {
        const line = findTestNameLine(doc, t.name);
        tests.push({ name: t.name, line });
      }
    }
  }

  return { name, tests };
}

function findTestNameLine(
  doc: vscode.TextDocument,
  testName: string,
): number | undefined {
  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text;
    if (line.includes(testName)) {
      return i;
    }
  }
  return undefined;
}
