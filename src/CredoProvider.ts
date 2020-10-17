import * as cp from 'child_process';

import * as vscode from 'vscode';
import * as path from 'path';

const enum Setting {
  Enable = 'credo.enable',
  MixEnv = 'credo.mixEnv',
  ProjectDir = 'credo.projectDir',
  Command = 'credo.command',
}

export default class CredoProvider {
  private static defaultCommand = 'mix credo';
  private static defaultMixEnv = 'test';
  private static extensionId = 'Credo';

  private enabled: boolean;
  private command: string;
  private mixEnv: string;
  private projectDir?: string;
  private invalidCommand: boolean;
  private diagnosticCollection?: vscode.DiagnosticCollection;

  constructor() {
    this.enabled = true;
    this.invalidCommand = false;
    this.command = CredoProvider.defaultCommand;
    this.mixEnv = CredoProvider.defaultMixEnv;
  }

  public activate(subscriptions: vscode.Disposable[]) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection(CredoProvider.extensionId);
    subscriptions.push(this);

    subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(this.loadConfiguration, this),
      vscode.workspace.onDidOpenTextDocument(this.triggerLint, this),
      vscode.workspace.onDidSaveTextDocument(this.triggerLint, this)
    );

    // TODO: add custom config huh!
    const mixWatcher = vscode.workspace.createFileSystemWatcher('**/mix.lock');
    subscriptions.push(
      mixWatcher,
      mixWatcher.onDidCreate(this.loadConfiguration, this),
      mixWatcher.onDidChange(this.loadConfiguration, this)
    );

    const credoConfigWatcher = vscode.workspace.createFileSystemWatcher('**/.credo.exs');
    subscriptions.push(
      credoConfigWatcher,
      credoConfigWatcher.onDidCreate(this.loadConfiguration, this),
      credoConfigWatcher.onDidChange(this.loadConfiguration, this)
    );

    this.loadConfiguration();
  }

  public dispose(): void {
    this.diagnosticCollection?.clear();
    this.diagnosticCollection?.dispose();
  }

  private loadConfiguration(): void {
    let config = vscode.workspace.getConfiguration();

    if (config) {
      this.enabled = config.get<boolean>(Setting.Enable, true);
      this.command = config.get<string>(Setting.Command, 'mix credo');
      this.mixEnv = config.get<string>(Setting.MixEnv, 'mix credo');
      this.projectDir = config.get<string>(Setting.ProjectDir, '');
      this.invalidCommand = false;
    }

    this.diagnosticCollection?.clear();

    if (this.enabled) {
      this.executeLint()
        .then(() => vscode.workspace.textDocuments.forEach(this.triggerLint, this))
        .catch(this.showError);
    }
  }

  private triggerLint(doc: vscode.TextDocument): void {
    if (!doc) return;
    if (doc.languageId !== 'elixir') return;
    if (doc.isUntitled) return;
    if (!this.enabled) return;
    if (this.invalidCommand) return;

    this.executeLint(doc).catch(this.showError);
  }

  private executeLint(textDocument?: vscode.TextDocument): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!vscode.workspace.workspaceFolders) return resolve();

      let diagnostics: [vscode.Uri, vscode.Diagnostic[] | undefined][] = [];
      let command = this.command || CredoProvider.defaultCommand;

      const mixEnv = this.mixEnv || CredoProvider.defaultMixEnv;
      const projectDir = this.projectDir;
      const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const cwd = projectDir ? path.join(rootPath, projectDir) : rootPath;
      const options = { cwd: cwd, env: { ...process.env, MIX_ENV: mixEnv } };

      command += ' --format=json ';
      command += textDocument ? textDocument.fileName : '';

      try {
        cp.exec(command, options, (error, stdout, stderr) => {
          console.warn([error, stdout, stderr]);
          if (stderr) {
            this.invalidCommand = true;

            return reject(stderr);
          }

          if (stdout) {
            console.warn(stdout);
            const { issues } = JSON.parse(stdout);

            issues.forEach((issue: any) => {
              let severity = vscode.DiagnosticSeverity.Warning;
              let message = issue.message;
              let column = (issue.column || 1) - 1;
              let column_end = (issue.column_end || 1) - 1;

              if (textDocument) {
                let line = textDocument.lineAt(issue.line_no - 1);
                if (!column) {
                  column = line.text.indexOf(issue.trigger);
                  column_end = column + issue.trigger.length;
                }
              }

              const range = new vscode.Range(
                new vscode.Position(issue.line_no - 1, column),
                new vscode.Position(issue.line_no - 1, column_end)
              );
              const diagnostic = new vscode.Diagnostic(range, message, severity);
              diagnostic.source = CredoProvider.extensionId;

              diagnostics.push([vscode.Uri.parse(path.join(cwd, issue.filename)), [diagnostic]]);
            });

            if (!issues.length && textDocument) {
              diagnostics.push([textDocument.uri, []]);
            }

            this.diagnosticCollection!.set(diagnostics);
            return resolve();
          }

          // stdout is empty
          reject('Something went wrong! Stdout is empty.');
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private async showError(error: any): Promise<void> {
    let message: string | null = error.message ? error.message : error;

    if (!message) {
      return;
    }

    const openSettings = 'Open Settings';

    if ((await vscode.window.showInformationMessage(message, openSettings)) === openSettings) {
      vscode.commands.executeCommand('workbench.action.openSettings', 'credo');
    }
  }
}
