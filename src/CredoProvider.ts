import * as cp from 'child_process';

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const enum Setting {
  Enable = 'enable',
  MixEnv = 'mixEnv',
  ProjectDir = 'projectDir',
  Command = 'command',
}

interface CredoConfig {
  mixEnv: string;
  enabled: boolean;
  projectDir?: string;
  invalidCommand: boolean;
  uri_path: string;
  command: string;
  diagnosticCollection: vscode.DiagnosticCollection;
  credoCompiled: boolean;
}
interface LintParameters {
  textDocument?: vscode.TextDocument;
  workspaceFolder: vscode.WorkspaceFolder;
  config: CredoConfig;
}

export default class CredoProvider {
  private static defaultCommand = 'mix credo --strict';
  private static defaultMixEnv = 'test';
  private static defaultProjectDir = '';
  private static extensionId = 'Credo';
  private static extensionSettings = 'credo';

  private configs: CredoConfig[];
  private channel: vscode.OutputChannel;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.configs = [];
    this.channel = vscode.window.createOutputChannel('Credo Linter');
    this.context = context;
    context.subscriptions.push(this, this.channel);
    this.logError = this.logError.bind(this);
  }

  public activate() {
    const { subscriptions } = this.context;

    subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders((event: vscode.WorkspaceFoldersChangeEvent) => {
        event.added.forEach((added) => this.loadConfiguration(added));
        event.removed.forEach((removed) => this.disposeConfig(removed));
      }, this),
      vscode.workspace.onDidChangeConfiguration((_event: vscode.ConfigurationChangeEvent) => {
        const folders = vscode.workspace.workspaceFolders;
        folders?.forEach((workspaceFolder) => this.loadConfiguration(workspaceFolder));
      }, this),
      vscode.workspace.onDidOpenTextDocument(this.triggerLint, this),
      vscode.workspace.onDidSaveTextDocument(this.triggerLint, this)
    );

    const mixWatcher = vscode.workspace.createFileSystemWatcher('**/mix.lock');
    subscriptions.push(
      mixWatcher,
      mixWatcher.onDidCreate(this.configChanged, this),
      mixWatcher.onDidChange(this.configChanged, this)
    );

    const credoConfigWatcher = vscode.workspace.createFileSystemWatcher('**/.credo.exs');
    subscriptions.push(
      credoConfigWatcher,
      credoConfigWatcher.onDidCreate(this.configChanged, this),
      credoConfigWatcher.onDidChange(this.configChanged, this)
    );

    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      folders.forEach((folder) => this.loadConfiguration(folder));
    }
  }

  public dispose(): void {
    this.configs.forEach((config) => config.diagnosticCollection.dispose());
  }

  private disposeConfig(workspaceFolder: vscode.WorkspaceFolder): void {
    const config = this.getWorkspaceConfig(workspaceFolder);
    if (config) {
      config.diagnosticCollection?.dispose();
      this.configs = this.configs.filter((config) => config.uri_path != workspaceFolder.uri.path);
    }
  }

  private configChanged(uri: vscode.Uri): void {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    workspaceFolder && this.loadConfiguration(workspaceFolder);
  }

  private loadConfiguration(workspaceFolder: vscode.WorkspaceFolder): void {
    this.disposeConfig(workspaceFolder);

    const vsConfig = vscode.workspace.getConfiguration(CredoProvider.extensionSettings, workspaceFolder);
    const config = this.getWorkspaceConfig(workspaceFolder);
    const workspacePath = workspaceFolder.uri.fsPath;

    config.enabled = vsConfig.get(Setting.Enable, true);
    config.command = vsConfig.get(Setting.Command, CredoProvider.defaultCommand);
    config.mixEnv = vsConfig.get(Setting.MixEnv, CredoProvider.defaultMixEnv);
    config.projectDir = vsConfig.get(Setting.ProjectDir, CredoProvider.defaultProjectDir);
    config.diagnosticCollection = vscode.languages.createDiagnosticCollection(CredoProvider.extensionId);
    config.invalidCommand = false;
    config.credoCompiled = false;
    const cwd = config.projectDir ? path.join(workspacePath, config.projectDir) : workspacePath;
    const credoMixPath = path.join(cwd, 'deps', 'credo', 'mix.exs');

    if (!fs.existsSync(credoMixPath) && config.enabled) {
      this.channel.appendLine("Credo wasn't found in deps. Disabled.");
      config.enabled = false;
    }

    this.configs.push(config);

    if (config.enabled && !config.invalidCommand) {
      // Firstly, whole workspace is linted
      // Secondly, opened textDocuments are linted
      // because all workspace json response doesn't contain full information like the per textDocument one
      this.executeLint({ workspaceFolder, config })
        .then(() => vscode.workspace.textDocuments.forEach(this.triggerLint, this))
        .catch(this.logError);
    }
  }

  private getWorkspaceConfig(workspaceFolder: vscode.WorkspaceFolder): CredoConfig {
    return (
      this.configs.find((config) => config.uri_path === workspaceFolder.uri.path) ||
      <CredoConfig>{ uri_path: workspaceFolder.uri.path }
    );
  }

  private triggerLint(textDocument: vscode.TextDocument): void {
    if (!textDocument) return;
    if (textDocument.languageId !== 'elixir') return;
    if (textDocument.isUntitled) return;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(textDocument.uri);
    if (!workspaceFolder) return;
    const config = this.getWorkspaceConfig(workspaceFolder);
    if (!config.enabled) return;
    if (config.invalidCommand) return;

    this.executeLint({ textDocument, workspaceFolder, config }).catch(this.logError);
  }

  private executeLint({ textDocument, workspaceFolder, config }: LintParameters): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let diagnostics: [vscode.Uri, vscode.Diagnostic[] | undefined][] = [];

      const mixEnv = config.mixEnv || CredoProvider.defaultMixEnv;
      const workspacePath = workspaceFolder.uri.fsPath;
      const cwd = config.projectDir ? path.join(workspacePath, config.projectDir) : workspacePath;
      const options = { cwd: cwd, env: { ...process.env, MIX_ENV: mixEnv } };

      let command = config.command || CredoProvider.defaultCommand;
      command += ' --format=json --mute-exit-status ';
      if (textDocument) {
        command += `--files-included ${textDocument.fileName}`;
      }

      if (!config.credoCompiled) {
        const status = this.compileCredo(command, options);
        if (status) {
          config.credoCompiled = true;
        } else {
          config.invalidCommand = true;
          reject();
        }
      }

      this.channel.appendLine(`Executing command: ${command}`);
      try {
        cp.exec(command, options, (_error, stdout, stderr) => {
          if (stderr) {
            this.logError(`Command ${command} returned stderr:`);
          }

          if (stdout) {
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

            config.diagnosticCollection!.set(diagnostics);
            return resolve();
          }

          // stdout is empty
          reject('Something went wrong! Stdout is empty.');
        });
      } catch (error) {
        this.logError(`Command ${command} didn't work:`);
        reject(error);
      }
    });
  }
  private compileCredo(command: string, options: cp.ExecOptions): boolean {
    try {
      this.channel.appendLine(`Compilling deps with: MIX_ENV=${options.env?.MIX_ENV} and cwd=${options.cwd}`);
      cp.execSync(command, options);
      this.channel.appendLine('Compillation was successful');
      return true;
    } catch (error) {
      this.channel.appendLine("Couldn't compile deps:");
      this.logError(error);
      return false;
    }
  }

  private async logError(error: any): Promise<void> {
    let message: string | null = error.message ? error.message : error;

    if (message) {
      this.channel.appendLine(message);
    }
  }
}
