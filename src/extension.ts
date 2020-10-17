import * as vscode from 'vscode';

import CredoProvider from './CredoProvider';

export function activate(context: vscode.ExtensionContext) {
  let linter = new CredoProvider();
  linter.activate(context.subscriptions);
}
