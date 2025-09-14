import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { type CompletionItem, type Connection, type Definition, type DocumentSymbolParams, type Location, type ReferenceParams, type RenameParams, type SymbolInformation, type TextDocumentPositionParams, TextDocumentSyncKind, TextDocuments, type WorkspaceEdit, type WorkspaceFolder, type CodeAction, CodeActionKind, type CodeActionParams, type ApplyWorkspaceEditResult } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { generateInitialCompletions } from './completions';
import { AllowUnsafeScriptOption, CustomMessages } from "./constants";
import { type FileSystemProvider, FileSystemService } from './file-system-service';
import { Index, type ProjectIndex } from "./index";
import { updateProjectIndex } from './indexer';
import { uriIsStartupFile, uriIsChoicescriptStatsFile } from './language';
import { countWords } from './parser';
import { findDefinitions, findReferences, generateRenames } from './searches';
import { generateSymbols } from './structure';
import { normalizeUri } from './utilities';
import { type ValidationSettings, generateDiagnostics } from './validator';

/**
 * Server event arguments about an updated word count in a document.
 */
interface UpdatedWordCount {
	/**
	 * Document URI.
	 */
	uri: string;
	/**
	 * New word count, or undefined if it has none.
	 */
	count?: number;
}

export const startServer = (connection: Connection, fsProvider: FileSystemProvider) => {

	const fileSystemService = new FileSystemService(fsProvider);

	// Create a simple text document manager. The text document manager
	// supports full document sync only
	const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

	// TODO handle multiple directories with startup.txt
	const projectIndex = new Index();

	const validationSettings: ValidationSettings = {
		useCoGStyleGuide: true,
		allowUnsafeScript: "never"
	};

	// Queue of documents whose content has changed and who need to be updated
	const changedDocuments: Map<string, TextDocument> = new Map();
	// Queue of possibly new scenes that need to be indexed
	const newScenes: Set<string> = new Set();
	// Have the files in the index changed or something happened where re-validation is required?
	// (Strictly speaking, those two events don't have to be coupled -- changing startup.txt requires
	// revalidation but doesn't indicate that the project files have actually changed) but for simplicity
	// I'm combining the concepts into a single "project files have changed" variable
	let projectFilesHaveChanged = false;
	// Heartbeat ID
	let heartbeatId: ReturnType<typeof setInterval> | undefined = undefined;
	// How often to update the documents in the queue, in ms
	const heartbeatDelay = 200;
	// Minimum heartbeat delay, in ms
	const minHeartbeatDelay = 50;
	// Last queue update time
	let lastHeartbeatTime = -1;

	documents.listen(connection);

	const AddVariableCommandId = 'choicescript/addVariable';

	connection.onInitialize(() => {
		const syncKind: TextDocumentSyncKind = TextDocumentSyncKind.Full;
		return {
			capabilities: {
				textDocumentSync: {
					openClose: true,
					change: syncKind,
					willSaveWaitUntil: false,
					save: {
						includeText: false
					}
				},
				completionProvider: {
					resolveProvider: false,
					triggerCharacters: [ '*', '{' ]
				},
				definitionProvider: true,
				referencesProvider: true,
				renameProvider: true,
				documentSymbolProvider: true,
				codeActionProvider: {
					codeActionKinds: [CodeActionKind.QuickFix]
				},
				executeCommandProvider: {
					commands: [AddVariableCommandId]
				}
			}
		};
	});

	connection.onInitialized(async () => {
		connection.workspace.getWorkspaceFolders().then(workspaces => {
			if (workspaces && workspaces.length > 0)
				findAndIndexProjects(fileSystemService, workspaces);
		});
		// Handle custom requests from the client
		connection.onNotification(CustomMessages.CoGStyleGuide, onCoGStyleGuide);
		connection.onNotification(CustomMessages.AllowUnsafeScript, onAllowUnsafeScript);
		connection.onRequest(CustomMessages.WordCountRequest, onWordCount);
		connection.onRequest(CustomMessages.SelectionWordCountRequest, onSelectionWordCount);
	
		heartbeatId = setInterval(heartbeat, heartbeatDelay);
	});

	// Provide quick fixes for undefined variables
	connection.onCodeAction(async (params: CodeActionParams): Promise<CodeAction[] | undefined> => {
		const doc = documents.get(params.textDocument.uri);
		if (!doc) return undefined;

		// Look for our specific undefined-variable diagnostics
		const actions: CodeAction[] = [];
		for (const d of params.context.diagnostics) {
			const m = /^Variable\s+"([^"]+)"\s+not defined/.exec(d.message);
			if (!m) continue;
			const variable = m[1];
			// Build two actions: global (startup) and local (*temp)
			const titleGlobal = 'Add Global Variable';

			const actionGlobal: CodeAction = {
				title: titleGlobal,
				kind: CodeActionKind.QuickFix,
				diagnostics: [d],
				command: {
					title: titleGlobal,
					command: AddVariableCommandId,
					arguments: [{ variable }]
				}
			};
			actions.push(actionGlobal);
		}

		return actions.length ? actions : undefined;
	});

	connection.onShutdown(() => {
		if (heartbeatId !== undefined) {
			clearInterval(heartbeatId);
		}
	});

	connection.onCompletion(
		(textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
			const document = documents.get(textDocumentPosition.textDocument.uri);
			if (document === undefined) {
				return [];
			}
			return generateInitialCompletions(document, textDocumentPosition.position, projectIndex);
		}
	);

	connection.onDefinition(
		(textDocumentPosition: TextDocumentPositionParams): Definition | undefined => {
			const document = documents.get(textDocumentPosition.textDocument.uri);
			if (document !== undefined) {
				const definitionAndLocations = findDefinitions(normalizeUri(document.uri), textDocumentPosition.position, projectIndex);
				if (definitionAndLocations !== undefined) {
					return definitionAndLocations[0].location;
				}
			}
			return undefined;
		}
	);

	connection.onReferences(
		(referencesParams: ReferenceParams): Location[] | undefined => {
			const document = documents.get(referencesParams.textDocument.uri);
			if (document === undefined) {
				return undefined;
			}
			const references = findReferences(normalizeUri(document.uri), referencesParams.position, referencesParams.context, projectIndex);
			return references?.map(reference => { return reference.location; });
		}
	);

	connection.onRenameRequest(
		(renameParams: RenameParams): WorkspaceEdit | null => {
			const document = documents.get(renameParams.textDocument.uri);
			if (document === undefined) {
				return null;
			}
			return generateRenames(normalizeUri(document.uri), renameParams.position, renameParams.newName, projectIndex);
		}
	);

	connection.onDocumentSymbol(
		(documentSymbolParams: DocumentSymbolParams): SymbolInformation[] | null => {
			const document = documents.get(documentSymbolParams.textDocument.uri);
			if (document === undefined) {
				return null;
			}
			return generateSymbols(document, projectIndex);
		}
	);


	connection.onDidChangeConfiguration(change => {  // eslint-disable-line @typescript-eslint/no-unused-vars
		// Revalidate all open text documents
		documents.all().forEach(doc => validateTextDocument(doc, projectIndex));
	});

	// Handle the command to add a variable (global/local)
	connection.onExecuteCommand(async (params) => {
		const args = params.arguments ?? [];
		// args[0] should be our payload
		if (!args || args.length == 0) return;
		const payload = args[0] as { variable: string };
		if (!payload?.variable) return;

		try {
			await addGlobalVariable(payload.variable);
		}
		catch (e) {
			connection.console.error(`addVariable command failed: ${e}`);
		}
	});
	
	documents.onDidOpen(e => {
		const isStartupFile = uriIsStartupFile(e.document.uri);
	
		updateProjectIndex(
			e.document, isStartupFile, uriIsChoicescriptStatsFile(e.document.uri), projectIndex
		).forEach(newScene => {
			newScenes.add(newScene);
		});
	
		notifyChangedWordCount(e.document);
		if (isStartupFile) {
			projectFilesHaveChanged = true;
		}
	});
	
	// A document has been opened or its content has been changed.
	documents.onDidChangeContent(change => {
		// Put the document on the queue for later processing (so we don't DDOS via updates)
		changedDocuments.set(normalizeUri(change.document.uri), change.document);
	});

	/**
	 * Logs a message by sending it to the client.
	 * 
	 * @param message Message to log.
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	function logMessage(message: string): void {
		connection.sendNotification(CustomMessages.DebugMessage, message);
	}

	/**
	 * Find the `startup.txt` file and index the project associated with it.
	 * 
	 * @param fileSystemService Service that provides access to the file system.
	 * @param workspaces List of workspace folders.
	 */
	function findAndIndexProjects(fileSystemService: FileSystemService, workspaces: WorkspaceFolder[]): void {
		workspaces.forEach((workspace) => {
			const rootPath = fileURLToPath(workspace.uri);
			fileSystemService.findFiles('**/startup.txt', rootPath)
				.then(files => {
					if (files.length > 0) {
						// TODO handle multiple startup.txt files in multiple directories
						indexProject(rootPath, files[0]);
					}
				});
		});
	}

	/**
	 * Add a global variable to startup.txt, appending to the last *create block if found.
	 */
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
		projectFilesHaveChanged = true;
	}



	async function validateTextDocument(textDocument: TextDocument, projectIndex: ProjectIndex): Promise<void> {
		// In generating diagnostics, the image path may update, so check that
		const oldImagePath = projectIndex.getPlatformImagePath();
		const diagnostics = await generateDiagnostics(textDocument, projectIndex, validationSettings, fileSystemService);
		connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
		const newImagePath = projectIndex.getPlatformImagePath();
		if (newImagePath != oldImagePath && newImagePath !== undefined) {
			connection.sendNotification(CustomMessages.UpdatedImageFilesPath, newImagePath);
		}
	}

	/**
	 * Fully index a ChoiceScript project given the path to `startup.txt`.
	 * 
	 * @param workspacePath Resolved path to the root of the workspace.
	 * @param relativeStartupFilePath Path to `startup.txt` relative to the workspace.
	 */
	async function indexProject(workspacePath: string, relativeStartupFilePath: string): Promise<void> {
		const projectPath = path.dirname(relativeStartupFilePath);
		// Filenames from globby are posix paths regardless of platform
		const projectPathComponents = projectPath.split('/');
		const sceneFilesPath = path.join(workspacePath, ...projectPathComponents);
		projectIndex.setPlatformScenePath(sceneFilesPath);
		connection.sendNotification(CustomMessages.UpdatedSceneFilesPath, sceneFilesPath);
	
		// Index the startup.txt file
		await indexFile(path.join(sceneFilesPath, path.basename(relativeStartupFilePath)));
	
		// Try to index the stats page (which might not exist)
		await indexFile(path.join(sceneFilesPath, "choicescript_stats.txt"));
	
		const scenes = projectIndex.getAllReferencedScenes();

		if (scenes !== undefined) {
			// Try to index all of the scene files
			await indexScenes(scenes);
		}
	
		const imagePath = projectIndex.getPlatformImagePath();
		if (imagePath !== undefined) {
			connection.sendNotification(CustomMessages.UpdatedImageFilesPath, imagePath);
		}
	
		projectIndex.setProjectIsIndexed(true);
		connection.sendNotification(CustomMessages.ProjectIndexed);
	}

	/**
	 * Index a ChoiceScript file and add it to the overall project index.
	 * 
	 * @param path Absolute path to the file to index.
	 * @returns True if indexing succeeded; false otherwise.
	 */
	async function indexFile(path: string): Promise<boolean> {
		const fileUri = pathToFileURL(path).toString();
	
		try {
			const data = await fileSystemService.readFile(path);
			const textDocument = TextDocument.create(fileUri, 'ChoiceScript', 0, data);
			const newFile = !projectIndex.hasUri(normalizeUri(textDocument.uri));
			updateProjectIndex(
				textDocument, uriIsStartupFile(fileUri), uriIsChoicescriptStatsFile(fileUri), projectIndex
			).forEach(newScene => {
				newScenes.add(newScene);
			});
			if (newFile) {
				projectFilesHaveChanged = true;
			}
			return true;
		}
		catch (err) {
			connection.console.error(`Could not read file ${path} (${err})`);
			return false;
		}
	}

	/**
	 * Index a list of scenes by name.
	 * 
	 * @param sceneNames List of scene names to index (such as "startup" or "chapter_1").
	 */
	async function indexScenes(sceneNames: readonly string[]) {
		const platformScenePath = projectIndex.getPlatformScenePath();
		const scenePaths = sceneNames.map(name => path.join(platformScenePath, name+".txt"));
		const promises = scenePaths.map(x => indexFile(x));
		await Promise.all(promises);
	}

	/**
	 * Process the queue of documents that have changed, new-to-us scenes,
	 * and any required re-validation or changed-index notification.
	 */
	async function heartbeat() {
		if (Date.now() - lastHeartbeatTime < minHeartbeatDelay) {
			return;
		}
	
		try {
			// Process changed documents
			const processingQueue = new Map(changedDocuments);
			changedDocuments.clear();
			let processedStartupFile = false;
	
			for (const [uri, document] of processingQueue) {
				processChangedDocument(document);
				if (uriIsStartupFile(uri)) {
					processedStartupFile = true;
				}
			}
	
			// If we processed a startup file, which defines global variables,
			// re-validate all files & notify that scene files may have changed
			if (processedStartupFile) {
				// Since the startup file defines global variables, if it changes,
				// re-validate all other files
				projectFilesHaveChanged = true;
			}
			else {
				for (const document of processingQueue.values()) {
					validateTextDocument(document, projectIndex);
				}
			}
	
			// Index new scenes
			if (newScenes.size > 0) {
				const scenes = [...newScenes.keys()];
				newScenes.clear();
				await indexScenes(scenes);
			}
	
			if (projectFilesHaveChanged) {
				projectFilesHaveChanged = false;
				documents.all().forEach(doc => validateTextDocument(doc, projectIndex));
			}
		}
		finally {
			lastHeartbeatTime = Date.now();
		}
	}

	/**
	 * Process a document whose content has changed.
	 */
	function processChangedDocument(document: TextDocument) {
		updateProjectIndex(
			document, uriIsStartupFile(document.uri), uriIsChoicescriptStatsFile(document.uri), projectIndex
		).forEach(newScene => {
			newScenes.add(newScene);
		});

		notifyChangedWordCount(document);
	}

	/**
	 * Notify the client about a document's word count.
	 * @param document Document whose word count is to be sent.
	 */
	function notifyChangedWordCount(document: TextDocument): void {
		const e: UpdatedWordCount = {
			uri: document.uri,
			count: projectIndex.getWordCount(document.uri)
		};

		connection.sendNotification(CustomMessages.UpdatedWordCount, e);
	}

	function onCoGStyleGuide(useCoGStyleGuide: boolean) {
		validationSettings.useCoGStyleGuide = useCoGStyleGuide;
		documents.all().forEach(doc => validateTextDocument(doc, projectIndex));
	}

	function onAllowUnsafeScript(allowUnsafeScript: AllowUnsafeScriptOption) {
		validationSettings.allowUnsafeScript = allowUnsafeScript;
		documents.all().forEach(doc => validateTextDocument(doc, projectIndex));
	}
	
	function onWordCount(uri: string): number | undefined {
		return projectIndex.getWordCount(uri);
	}
	
	function onSelectionWordCount(location: Location): number | undefined {
		const document = documents.get(location.uri);
		if (document === undefined) {
			return undefined;
		}
	
		const startIndex = document.offsetAt(location.range.start);
		const endIndex = document.offsetAt(location.range.end);
		if (startIndex == endIndex) {
			return undefined;
		}
	
		const section = document.getText().slice(startIndex, endIndex);
	
		return countWords(section, document);
	}
	
	documents.listen(connection);

	connection.listen();

};
