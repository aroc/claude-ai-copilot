import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import Anthropic from '@anthropic-ai/sdk';

interface AICopilotSettings {
	anthropicApiKey: string;
	modelName: string;
}

const DEFAULT_SETTINGS: AICopilotSettings = {
	anthropicApiKey: '',
	modelName: 'claude-sonnet-4-5-20250929'
}

const SINGLE_NOTE_SYSTEM_PROMPT = `You are an AI assistant helping to edit and improve notes in Obsidian.

IMPORTANT: The user will provide you with the full content of their current note and a specific request for changes. You must return the COMPLETE note with only the requested changes applied. Do NOT make any changes beyond what the user explicitly requests.

Rules:
- If the note is empty, generate the requested content from scratch
- If the note has existing content, prefer appending or inserting new content rather than replacing existing content, unless the user explicitly asks to replace or modify specific parts
- Only modify what the user specifically asks you to change
- Preserve all other content exactly as it appears
- Maintain the original formatting, structure, and style
- Do not add unnecessary improvements or suggestions unless asked
- Return the entire note content, not just the changed parts
- Do not include any explanations or comments about the changes

Your response should be the complete note content, ready to replace the current note.`;

const VAULT_AGENT_SYSTEM_PROMPT = `You are an AI assistant helping to manage and organize notes in an Obsidian vault.

You have access to tools that allow you to:
- read_file: Read any file in the vault
- write_file: Write or update any file in the vault (you must provide the complete file content)
- create_file: Create a new file in the vault

IMPORTANT RULES:
- When writing/updating a file, you must provide the COMPLETE file content, not just changes
- File paths should be relative to the vault root (e.g., "folder/note.md")
- All markdown files should use the .md extension
- Only make changes that the user explicitly requests
- Be thoughtful about which files you modify
- When reading files, be selective to avoid reading too many unnecessary files

Your goal is to help the user accomplish their task across their vault. Use the tools as needed to complete the request.`;

interface AgentOperation {
	type: 'read' | 'write' | 'create';
	path: string;
}

export default class AICopilotPlugin extends Plugin {
	settings: AICopilotSettings;

	async onload() {
		await this.loadSettings();

		// Command 1: Edit current note only
		this.addCommand({
			id: 'edit-current-note',
			name: 'Edit Current Note with AI',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				new SingleNotePromptModal(this.app, this, editor, view).open();
			}
		});

		// Command 2: Act on entire vault
		this.addCommand({
			id: 'act-on-vault',
			name: 'Act on Entire Vault with AI',
			callback: () => {
				new VaultAgentPromptModal(this.app, this).open();
			}
		});

		// Add settings tab
		this.addSettingTab(new AICopilotSettingTab(this.app, this));
	}

	onunload() {
		// Cleanup if needed
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Simple single-note processing (original behavior)
	async processWithAI(noteContent: string, userPrompt: string): Promise<string> {
		if (!this.settings.anthropicApiKey) {
			throw new Error('Anthropic API key not configured. Please add your API key in the plugin settings.');
		}

		const anthropic = new Anthropic({
			apiKey: this.settings.anthropicApiKey,
			dangerouslyAllowBrowser: true,
		});

		const tools = [
			{
				type: 'web_fetch_20250910',
				name: 'web_fetch',
				max_uses: 5
			} as any,
			{
				type: 'web_search_20250305',
				name: 'web_search',
				max_uses: 5
			} as any
		];

		const conversationHistory: any[] = [
			{
				role: 'user',
				content: `Current note content:\n\n${noteContent}\n\nUser request: ${userPrompt}\n\nPlease return the complete modified note:`
			}
		];

		try {
			const message = await anthropic.messages.create(
				{
					model: this.settings.modelName,
					max_tokens: 8096,
					system: SINGLE_NOTE_SYSTEM_PROMPT,
					messages: conversationHistory,
					tools: tools
				},
				{
					headers: {
						'anthropic-beta': 'web-fetch-2025-09-10'
					}
				}
			);

			console.log('Message stop_reason:', message.stop_reason);
			console.log('Message content:', JSON.stringify(message.content, null, 2));

			// Extract text blocks
			const textBlocks = message.content.filter((block: any) => block.type === 'text');

			if (textBlocks.length === 0) {
				throw new Error('No text content in AI response');
			}

			const finalText = textBlocks.map((block: any) => block.text).join('');

			return finalText;
		} catch (error) {
			console.error('AI processing error:', error);
			throw new Error(`Failed to process with AI: ${error.message}`);
		}
	}

	// Agent loop for vault-wide operations
	async processVaultAgent(userPrompt: string): Promise<AgentOperation[]> {
		if (!this.settings.anthropicApiKey) {
			throw new Error('Anthropic API key not configured. Please add your API key in the plugin settings.');
		}

		const anthropic = new Anthropic({
			apiKey: this.settings.anthropicApiKey,
			dangerouslyAllowBrowser: true,
		});

		const operations: AgentOperation[] = [];

		// Define custom tools for file operations
		const tools: Anthropic.Tool[] = [
			{
				name: 'read_file',
				description: 'Read the contents of a file in the vault. Use this to read any markdown file or other text file.',
				input_schema: {
					type: 'object',
					properties: {
						path: {
							type: 'string',
							description: 'The path to the file relative to the vault root (e.g., "folder/note.md")'
						}
					},
					required: ['path']
				}
			},
			{
				name: 'write_file',
				description: 'Write or update a file in the vault. You must provide the COMPLETE file content. This will overwrite the existing file if it exists.',
				input_schema: {
					type: 'object',
					properties: {
						path: {
							type: 'string',
							description: 'The path to the file relative to the vault root (e.g., "folder/note.md")'
						},
						content: {
							type: 'string',
							description: 'The complete content to write to the file'
						}
					},
					required: ['path', 'content']
				}
			},
			{
				name: 'create_file',
				description: 'Create a new file in the vault. The file must not already exist. Optionally provide initial content.',
				input_schema: {
					type: 'object',
					properties: {
						path: {
							type: 'string',
							description: 'The path to the new file relative to the vault root (e.g., "folder/note.md")'
						},
						content: {
							type: 'string',
							description: 'The initial content for the file (optional, defaults to empty string)'
						}
					},
					required: ['path']
				}
			},
			{
				type: 'web_fetch_20250910',
				name: 'web_fetch',
				max_uses: 5
			} as any,
			{
				type: 'web_search_20250305',
				name: 'web_search',
				max_uses: 5
			} as any
		];

		const messages: Anthropic.MessageParam[] = [
			{
				role: 'user',
				content: userPrompt
			}
		];

		try {
			let continueLoop = true;
			let iterationCount = 0;
			const maxIterations = 50; // Safety limit

			while (continueLoop && iterationCount < maxIterations) {
				iterationCount++;
				console.log(`Agent iteration ${iterationCount}`);

				const message = await anthropic.messages.create(
					{
						model: this.settings.modelName,
						max_tokens: 8096,
						system: VAULT_AGENT_SYSTEM_PROMPT,
						messages: messages,
						tools: tools
					},
					{
						headers: {
							'anthropic-beta': 'web-fetch-2025-09-10'
						}
					}
				);

				console.log('Agent response:', JSON.stringify(message.content, null, 2));
				console.log('Stop reason:', message.stop_reason);

				// Add assistant's response to conversation
				messages.push({
					role: 'assistant',
					content: message.content
				});

				// Check if we need to process tool uses
				const toolUses = message.content.filter(
					(block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
				);

				if (toolUses.length === 0 || message.stop_reason === 'end_turn') {
					// Agent is done
					continueLoop = false;
					break;
				}

				// Process each tool use
				const toolResults: any[] = [];

				for (const toolUse of toolUses) {
					const toolName = toolUse.name;
					const toolInput = toolUse.input as any; // Tool input is dynamic based on tool schema

					console.log(`Processing tool: ${toolName}`, toolInput);

					try {
						let result: any;

						switch (toolName) {
							case 'read_file':
								result = await this.handleReadFile(toolInput.path);
								operations.push({ type: 'read', path: toolInput.path });
								break;

							case 'write_file':
								result = await this.handleWriteFile(toolInput.path, toolInput.content);
								operations.push({ type: 'write', path: toolInput.path });
								break;

							case 'create_file':
								result = await this.handleCreateFile(toolInput.path, toolInput.content || '');
								operations.push({ type: 'create', path: toolInput.path });
								break;

							default:
								result = { error: `Unknown tool: ${toolName}` };
						}

						toolResults.push({
							type: 'tool_result',
							tool_use_id: toolUse.id,
							content: typeof result === 'string' ? result : JSON.stringify(result)
						});
					} catch (error) {
						console.error(`Tool execution error for ${toolName}:`, error);
						toolResults.push({
							type: 'tool_result',
							tool_use_id: toolUse.id,
							content: `Error: ${error.message}`,
							is_error: true
						});
					}
				}

				// Add tool results to conversation
				messages.push({
					role: 'user',
					content: toolResults
				});
			}

			if (iterationCount >= maxIterations) {
				console.warn('Agent reached maximum iterations');
				new Notice('Agent reached maximum iterations. Some operations may not have completed.');
			}

			return operations;
		} catch (error) {
			console.error('Vault agent processing error:', error);
			throw new Error(`Failed to process vault agent: ${error.message}`);
		}
	}

	// Tool handlers
	async handleReadFile(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);

		if (!file || !(file instanceof TFile)) {
			throw new Error(`File not found: ${path}`);
		}

		const content = await this.app.vault.read(file);
		return content;
	}

	async handleWriteFile(path: string, content: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);

		if (!file || !(file instanceof TFile)) {
			throw new Error(`File not found: ${path}. Use create_file to create a new file.`);
		}

		await this.app.vault.modify(file, content);
		return `Successfully updated ${path}`;
	}

	async handleCreateFile(path: string, content: string): Promise<string> {
		const existingFile = this.app.vault.getAbstractFileByPath(path);

		if (existingFile) {
			throw new Error(`File already exists: ${path}. Use write_file to update it.`);
		}

		// Create parent folders if they don't exist
		const pathParts = path.split('/');
		const fileName = pathParts.pop();

		if (pathParts.length > 0) {
			const folderPath = pathParts.join('/');
			const folder = this.app.vault.getAbstractFileByPath(folderPath);

			if (!folder) {
				// Create the folder structure
				await this.createFolderRecursive(folderPath);
			}
		}

		await this.app.vault.create(path, content);
		return `Successfully created ${path}`;
	}

	async createFolderRecursive(path: string): Promise<void> {
		const parts = path.split('/');
		let currentPath = '';

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);

			if (!existing) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}
}

// Modal for editing just the current note
class SingleNotePromptModal extends Modal {
	plugin: AICopilotPlugin;
	editor: Editor;
	view: MarkdownView;
	promptInput: HTMLTextAreaElement;

	constructor(app: App, plugin: AICopilotPlugin, editor: Editor, view: MarkdownView) {
		super(app);
		this.plugin = plugin;
		this.editor = editor;
		this.view = view;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		this.modalEl.addClass('ai-copilot-modal');

		contentEl.createEl('h2', { text: 'Edit Current Note' });

		contentEl.createEl('p', {
			text: 'Enter your request to modify the current note:',
			cls: 'setting-item-description'
		});

		this.promptInput = contentEl.createEl('textarea', {
			placeholder: 'e.g., "Fix all spelling errors", "Summarize this note", "Add headers to organize the content"...',
		});
		this.promptInput.style.width = '100%';
		this.promptInput.style.minHeight = '100px';
		this.promptInput.style.marginBottom = '1em';
		this.promptInput.style.padding = '0.5em';
		this.promptInput.style.fontFamily = 'inherit';

		const buttonContainer = contentEl.createDiv();
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '0.5em';

		const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
		});

		const submitButton = buttonContainer.createEl('button', {
			text: 'Apply Changes',
			cls: 'mod-cta'
		});
		submitButton.addEventListener('click', () => {
			this.handleSubmit();
		});

		this.promptInput.focus();

		this.promptInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.handleSubmit();
			}
		});
	}

	async handleSubmit() {
		const prompt = this.promptInput.value.trim();

		if (!prompt) {
			new Notice('Please enter a prompt');
			return;
		}

		const currentContent = this.editor.getValue() || '';

		this.close();

		const processingNotice = new Notice('Processing with AI...', 0);

		try {
			const modifiedContent = await this.plugin.processWithAI(currentContent, prompt);

			console.log('AI Response:', modifiedContent);
			console.log('AI Response length:', modifiedContent.length);

			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView || activeView !== this.view) {
				processingNotice.hide();
				new Notice('Note context changed. AI response not applied. Check console for the response.');
				console.warn('User switched notes. AI response was not applied.');
				return;
			}

			this.editor.setValue(modifiedContent);

			processingNotice.hide();
			new Notice('Note updated successfully!');
		} catch (error) {
			processingNotice.hide();
			new Notice(`Error: ${error.message}`);
			console.error('AI Co-Pilot error:', error);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// Modal for vault-wide agent operations
class VaultAgentPromptModal extends Modal {
	plugin: AICopilotPlugin;
	promptInput: HTMLTextAreaElement;

	constructor(app: App, plugin: AICopilotPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		this.modalEl.addClass('ai-copilot-modal');

		contentEl.createEl('h2', { text: 'Act on Entire Vault' });

		contentEl.createEl('p', {
			text: 'Enter your request. The AI agent can read, create, and modify any files in your vault.',
			cls: 'setting-item-description'
		});

		const warningEl = contentEl.createEl('p', {
			text: '⚠️ This command can make changes across your entire vault. Use with caution.',
			cls: 'setting-item-description'
		});
		warningEl.style.color = 'var(--text-error)';
		warningEl.style.fontWeight = 'bold';

		this.promptInput = contentEl.createEl('textarea', {
			placeholder: 'e.g., "Create a table of contents in TOC.md with all my notes", "Fix all broken links", "Create daily notes for this week"...',
		});
		this.promptInput.style.width = '100%';
		this.promptInput.style.minHeight = '120px';
		this.promptInput.style.marginBottom = '1em';
		this.promptInput.style.padding = '0.5em';
		this.promptInput.style.fontFamily = 'inherit';

		const buttonContainer = contentEl.createDiv();
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '0.5em';

		const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
		});

		const submitButton = buttonContainer.createEl('button', {
			text: 'Run Agent',
			cls: 'mod-cta mod-warning'
		});
		submitButton.addEventListener('click', () => {
			this.handleSubmit();
		});

		this.promptInput.focus();

		this.promptInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.handleSubmit();
			}
		});
	}

	async handleSubmit() {
		const prompt = this.promptInput.value.trim();

		if (!prompt) {
			new Notice('Please enter a prompt');
			return;
		}

		this.close();

		const processingNotice = new Notice('Agent is working on your vault...', 0);

		try {
			const operations = await this.plugin.processVaultAgent(prompt);

			processingNotice.hide();

			// Show results modal
			new AgentResultsModal(this.app, operations).open();
		} catch (error) {
			processingNotice.hide();
			new Notice(`Error: ${error.message}`);
			console.error('Vault agent error:', error);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// Modal to show agent operation results
class AgentResultsModal extends Modal {
	operations: AgentOperation[];

	constructor(app: App, operations: AgentOperation[]) {
		super(app);
		this.operations = operations;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		this.modalEl.addClass('ai-copilot-modal');

		contentEl.createEl('h2', { text: 'Agent Operations Summary' });

		if (this.operations.length === 0) {
			contentEl.createEl('p', {
				text: 'The agent completed without performing any file operations.',
				cls: 'setting-item-description'
			});
		} else {
			// Group operations by type
			const reads = this.operations.filter(op => op.type === 'read');
			const creates = this.operations.filter(op => op.type === 'create');
			const writes = this.operations.filter(op => op.type === 'write');

			// Files read
			if (reads.length > 0) {
				contentEl.createEl('h3', { text: `Files Read (${reads.length})` });
				const readList = contentEl.createEl('ul');
				reads.forEach(op => {
					readList.createEl('li', { text: op.path });
				});
			}

			// Files created
			if (creates.length > 0) {
				contentEl.createEl('h3', { text: `Files Created (${creates.length})` });
				const createList = contentEl.createEl('ul');
				createList.style.color = 'var(--text-success)';
				creates.forEach(op => {
					createList.createEl('li', { text: op.path });
				});
			}

			// Files updated
			if (writes.length > 0) {
				contentEl.createEl('h3', { text: `Files Updated (${writes.length})` });
				const writeList = contentEl.createEl('ul');
				writeList.style.color = 'var(--text-warning)';
				writes.forEach(op => {
					writeList.createEl('li', { text: op.path });
				});
			}
		}

		const buttonContainer = contentEl.createDiv();
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'center';
		buttonContainer.style.marginTop = '1.5em';

		const closeButton = buttonContainer.createEl('button', {
			text: 'Close',
			cls: 'mod-cta'
		});
		closeButton.addEventListener('click', () => {
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class AICopilotSettingTab extends PluginSettingTab {
	plugin: AICopilotPlugin;

	constructor(app: App, plugin: AICopilotPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'AI Co-Pilot Settings' });

		new Setting(containerEl)
			.setName('Anthropic API Key')
			.setDesc('Enter your Anthropic API key. Get one at https://console.anthropic.com/')
			.addText(text => text
				.setPlaceholder('sk-ant-...')
				.setValue(this.plugin.settings.anthropicApiKey)
				.onChange(async (value) => {
					this.plugin.settings.anthropicApiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Model Name')
			.setDesc('The Anthropic model to use (default: claude-sonnet-4-5-20250929)')
			.addText(text => text
				.setPlaceholder('claude-sonnet-4-5-20250929')
				.setValue(this.plugin.settings.modelName)
				.onChange(async (value) => {
					this.plugin.settings.modelName = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('p', {
			text: 'Note: This plugin sends your note content to Anthropic\'s API. Make sure you\'re comfortable with this before using the plugin with sensitive information.',
			cls: 'setting-item-description'
		});
	}
}
