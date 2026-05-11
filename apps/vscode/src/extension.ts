import * as vscode from 'vscode';
import { resolve, dirname } from 'path';

const DEFINITION_GLOB = '**/.dokkimi/**/*.{json,yaml,yml}';

export function activate(context: vscode.ExtensionContext) {
  const selector: vscode.DocumentSelector = [
    { scheme: 'file', language: 'json', pattern: DEFINITION_GLOB },
    { scheme: 'file', language: 'yaml', pattern: DEFINITION_GLOB },
  ];

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      selector,
      new DokkimiRunCodeLensProvider(),
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      selector,
      new DokkimiRefLinkProvider(),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dokkimi.runFile', (filePath: string) => {
      const terminal =
        vscode.window.activeTerminal ?? vscode.window.createTerminal('Dokkimi');
      terminal.show();
      terminal.sendText(`dokkimi run ${filePath}`);
    }),
  );
}

export function deactivate() {}

/**
 * Shows a "▶ Run Definition" CodeLens on runnable Dokkimi definitions.
 * A file is runnable when it has both a root-level "name" key AND
 * an "items" or "tests" key — this excludes fragments, shared variables,
 * and config files.
 */
/**
 * Renders $ref paths as clickable links that open the referenced file.
 * Underlines the entire path string. Works for both JSON and YAML.
 */
class DokkimiRefLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    const dir = dirname(document.uri.fsPath);

    // JSON: "$ref": "path"   or   "$ref": ["path1", "path2"]
    const jsonRe = /"\$ref"\s*:\s*"([^"]+)"/g;
    // YAML: $ref: path   or   - $ref: path
    const yamlRe = /\$ref:\s*(?:['"]?)([^\s'",\]]+)(?:['"]?)/g;

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text;
      const re = document.languageId === 'json' ? jsonRe : yamlRe;
      re.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        const refPath = match[1];
        const pathStart = line.indexOf(refPath, match.index);
        const range = new vscode.Range(
          i,
          pathStart,
          i,
          pathStart + refPath.length,
        );
        const target = vscode.Uri.file(resolve(dir, refPath));
        links.push(new vscode.DocumentLink(range, target));
      }
    }

    return links;
  }
}

class DokkimiRunCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const text = document.getText();
    const isJson = document.languageId === 'json';

    const hasName = isJson ? /"name"\s*:/.test(text) : /^name\s*:/m.test(text);
    const hasItems = isJson
      ? /"items"\s*:/.test(text)
      : /^items\s*:/m.test(text);
    const hasTests = isJson
      ? /"tests"\s*:/.test(text)
      : /^tests\s*:/m.test(text);

    if (!hasName || (!hasItems && !hasTests)) {
      return [];
    }

    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        title: '$(play) Run Dokkimi Definition',
        command: 'dokkimi.runFile',
        arguments: [document.uri.fsPath],
      }),
    ];
  }
}
