import { fileURLToPath } from 'url';
import {
  type ApplyWorkspaceEditResult,
  type CodeAction,
  CodeActionKind,
  type CodeActionParams,
  type Connection,
  type WorkspaceEdit,
  type TextDocuments
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import type { ProjectIndex } from './index';
import type { FileSystemService } from './file-system-service';
import { CustomMessages } from './constants';

export const AddVariableCommandId = 'choicescript/addVariable';

export function registerAddVariableQuickFix(opts: {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  projectIndex: ProjectIndex;
  fileSystemService: FileSystemService;
  indexFile: (path: string) => Promise<boolean>;
  markProjectFilesChanged: () => void;
}): void {
  const { connection, documents, projectIndex, fileSystemService, indexFile, markProjectFilesChanged } = opts;

  connection.onCodeAction(async (params: CodeActionParams): Promise<CodeAction[] | undefined> => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return undefined;

    const actions: CodeAction[] = [];
    for (const d of params.context.diagnostics) {
      const m = /^Variable\s+"([^"]+)"\s+not defined/.exec(d.message);
      if (!m) continue;
      const variable = m[1];

      const titleGlobal = 'Add Global Variable';
      actions.push({
        title: titleGlobal,
        kind: CodeActionKind.QuickFix,
        diagnostics: [d],
        command: {
          title: titleGlobal,
          command: AddVariableCommandId,
          arguments: [{ variable }]
        }
      });
    }

    return actions.length ? actions : undefined;
  });

  connection.onExecuteCommand(async (params) => {
    if (params.command !== AddVariableCommandId) return;
    const args = params.arguments ?? [];
    if (!args.length) return;
    const payload = args[0] as { variable: string };
    if (!payload?.variable) return;

    try {
      await addGlobalVariable(payload.variable);
    } catch (e) {
      connection.console.error(`addVariable command failed: ${e}`);
    }
  });

  async function addGlobalVariable(variable: string): Promise<void> {
    const startupUri = projectIndex.getSceneUri('startup');
    if (!startupUri) {
      connection.window.showErrorMessage('startup.txt not found');
      return;
    }

    const startupFsPath = fileURLToPath(startupUri);
    let text: string;
    try {
      text = await fileSystemService.readFile(startupFsPath);
    }
    catch (e) {
      connection.window.showErrorMessage(`Failed to read startup.txt: ${e}`);
      return;
    }

    // Find the last line that starts with *create or *create_array
    const lines = text.split(/\r?\n/);
    let insertLine = 0; // default to top of file if none found
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (trimmed.startsWith('*create ') || trimmed.startsWith('*create_array ')) {
        insertLine = i + 1; // insert after the last matched line
      }
    }

    const edit: WorkspaceEdit = {
      changes: {
        [startupUri]: [
          {
            range: { start: { line: insertLine, character: 0 }, end: { line: insertLine, character: 0 } },
            newText: `*create ${variable} 0\n`
          }
        ]
      }
    };

    const result: ApplyWorkspaceEditResult = await connection.workspace.applyEdit(edit);
    if (!result?.applied) {
      connection.window.showErrorMessage('Failed to apply edit to add global variable');
      return;
    }

    // Re-index startup to update globals; mark project files changed to revalidate
    await indexFile(startupFsPath);
    markProjectFilesChanged();
    // Trigger revalidation loop by sending a benign notification
    connection.sendNotification(CustomMessages.ProjectIndexed);
  }
}

