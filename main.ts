import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, prepareSimpleSearch } from 'obsidian';
import Anthropic from '@anthropic-ai/sdk';

interface AICopilotSettings {
	anthropicApiKey: string;
	modelName: string;
	enableDeleteFiles: boolean;
}

const DEFAULT_SETTINGS: AICopilotSettings = {
	anthropicApiKey: '',
	modelName: 'claude-sonnet-4-5-20250929',
	enableDeleteFiles: false
}

const SINGLE_NOTE_SYSTEM_PROMPT = `You are an AI assistant helping to edit and improve notes in Obsidian.

IMPORTANT: The user will provide you with the full content of their current note and a specific request for changes. You must return the COMPLETE note with only the requested changes applied. Do NOT make any changes beyond what the user explicitly requests.

Rules:
- If the note is empty, generate the requested content from scratch
- If the note has existing content, prefer appending or inserting new content rather than replacing existing content, unless the user explicitly asks to replace or modify specific parts
- Only modify what the user specifically asks you to change
- Preserve all other content EXACTLY as it appears - do not reformat, restructure, or modify anything that wasn't explicitly requested
- Maintain the original formatting, structure, and style
- Do not add headings, formatting, or structure changes unless explicitly requested
- Do not add unnecessary improvements or suggestions unless asked
- Return the entire note content, not just the changed parts
- Do not include any explanations or comments about the changes

LIMITATIONS:
- You can ONLY edit the content of the current note
- You CANNOT rename files, create new files, or make changes to other notes
- If the user asks to rename the file, create multiple files, or make vault-wide changes, return ONLY this message: [ERROR: Please use the 'Make changes anywhere with Claude' command to rename files, create new files, or make changes across multiple notes]
- Do not attempt to fulfill requests outside of editing the current note's content

CRITICAL FORMATTING RULES:
- NEVER wrap your response in markdown code blocks (i.e., do NOT use \`\`\`markdown ... \`\`\`)
- Your entire response is already treated as markdown content
- Return the raw note content directly without any code block wrapper
- Wrapping content in code blocks will break the note formatting in Obsidian
- Do NOT include any part of the user prompt, metadata, or instructions in your response
- Your response should ONLY contain the modified note content, nothing else

Your response should be the complete note content, ready to replace the current note.`;

function getVaultAgentSystemPrompt(enableDeleteFiles: boolean): string {
	const deleteFileTool = enableDeleteFiles ? '\n- delete_file: Delete a file (moves to trash according to user preferences)' : '';

	return `You are an AI assistant helping to manage and organize notes in an Obsidian vault.

You have access to tools that allow you to:
- list_files: List files in the vault or a specific folder (optionally filter by pattern)
- search_files: Search for files containing specific text or keywords
- get_file_metadata: Get detailed metadata about files (creation date, tags, links, frontmatter, etc.)
- read_file: Read any file in the vault
- write_file: Write or update any file in the vault (you must provide the complete file content)
- create_file: Create a new file in the vault
- rename_file: Rename or move a file (automatically updates all links to it)${deleteFileTool}

IMPORTANT RULES:
- When writing/updating a file, you must provide the COMPLETE file content, not just changes
- File paths should be relative to the vault root (e.g., "folder/note.md")
- All markdown files should use the .md extension
- Only make changes that the user explicitly requests
- Be thoughtful about which files you modify
- When reading files, be selective to avoid reading too many unnecessary files

NOTE ABOUT OTHER COMMANDS:
- For simple content-only edits to a single note, users can use the 'Edit note with AI' command
- However, you have full vault access here and can handle any file operations

CRITICAL FORMATTING RULE:
- NEVER wrap file content in markdown code blocks (i.e., do NOT use \`\`\`markdown ... \`\`\`)
- File content is already treated as markdown
- Provide the raw content directly without any code block wrapper
- Wrapping content in code blocks will break the formatting in Obsidian

OBSIDIAN INLINE TITLE BEHAVIOR:
- Obsidian displays an "inline title" at the top of each note based on the filename
- This is a DISPLAY-ONLY feature - the inline title is NOT stored in the file content
- Many notes (especially daily notes) do NOT have an H1 heading (# Title) in their actual content
- Do NOT add a level-1 heading (# Title) that matches or duplicates the filename
- Only add an H1 heading if:
  * The user explicitly requests it, OR
  * One already exists in the file (in which case, preserve the existing structure)
- When you see a file without an H1 heading, this is intentional - do NOT "fix" it by adding one
- The inline title feature means files can work perfectly fine without an H1 heading

Your goal is to help the user accomplish their task across their vault. Use the tools as needed to complete the request.`;
}

interface AgentOperation {
	type: 'read' | 'write' | 'create' | 'rename' | 'delete';
	path: string;
	newPath?: string; // For rename operations
}

export default class AICopilotPlugin extends Plugin {
	settings: AICopilotSettings;

	async onload() {
		await this.loadSettings();

		// Command 1: Edit current note only
		this.addCommand({
			id: 'edit-current-note',
			name: 'Edit note with AI',
			checkCallback: (checking: boolean) => {
				const editor = this.app.workspace.activeEditor?.editor;
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);

				if (editor && view) {
					if (!checking) {
						new SingleNotePromptModal(this.app, this, editor, view).open();
					}
					return true;
				}
				return false;
			}
		});

		// Command 2: Act on entire vault
		this.addCommand({
			id: 'act-on-vault',
			name: 'Make changes anywhere with Claude',
			checkCallback: (checking: boolean) => {
				const editor = this.app.workspace.activeEditor?.editor;
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);

				if (editor && view) {
					if (!checking) {
						new VaultAgentPromptModal(this.app, this, editor, view).open();
					}
					return true;
				}
				return false;
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

		// Include current date/time in the message
		const now = new Date();
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const dateTimeString = now.toLocaleString('en-US', {
			weekday: 'long',
			year: 'numeric',
			month: 'long',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			hour12: true,
			timeZone: timeZone
		});

		const conversationHistory: any[] = [
			{
				role: 'user',
				content: `<context>
<current_datetime>${dateTimeString} (${timeZone})</current_datetime>
</context>

<note_content>
${noteContent}
</note_content>

<user_request>
${userPrompt}
</user_request>`
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
	async processVaultAgent(userPrompt: string, currentNotePath?: string, currentNoteContent?: string): Promise<AgentOperation[]> {
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
				name: 'rename_file',
				description: 'Rename or move a file in the vault. This will automatically update all links to the file.',
				input_schema: {
					type: 'object',
					properties: {
						old_path: {
							type: 'string',
							description: 'The current path of the file (e.g., "folder/note.md")'
						},
						new_path: {
							type: 'string',
							description: 'The new path for the file (e.g., "folder/renamed-note.md")'
						}
					},
					required: ['old_path', 'new_path']
				}
			},
			...(this.settings.enableDeleteFiles ? [{
				name: 'delete_file',
				description: 'Delete a file from the vault. The file will be moved to trash according to user preferences.',
				input_schema: {
					type: 'object',
					properties: {
						path: {
							type: 'string',
							description: 'The path to the file to delete (e.g., "folder/note.md")'
						}
					},
					required: ['path']
				}
			}] : []),
			{
				name: 'list_files',
				description: 'List files in the vault or a specific folder. Useful for discovering what files exist and their structure.',
				input_schema: {
					type: 'object',
					properties: {
						folder: {
							type: 'string',
							description: 'Optional: specific folder path to list (e.g., "Archive" or "Daily Notes"). If not provided, lists all files.'
						},
						pattern: {
							type: 'string',
							description: 'Optional: filter files by name pattern (e.g., "daily" to find files with "daily" in the name)'
						},
						include_metadata: {
							type: 'boolean',
							description: 'Optional: include file size and dates in results (default: false)'
						}
					},
					required: []
				}
			},
			{
				name: 'search_files',
				description: 'Search for files containing specific text or keywords in their content. Returns matching files with context.',
				input_schema: {
					type: 'object',
					properties: {
						query: {
							type: 'string',
							description: 'Search query - can be a word, phrase, or space-separated keywords to search for'
						},
						folder: {
							type: 'string',
							description: 'Optional: limit search to a specific folder (e.g., "Projects")'
						},
						case_sensitive: {
							type: 'boolean',
							description: 'Optional: whether search should be case-sensitive (default: false)'
						},
						max_results: {
							type: 'number',
							description: 'Optional: maximum number of files to return (default: 50, helps with performance)'
						}
					},
					required: ['query']
				}
			},
			{
				name: 'get_file_metadata',
				description: 'Get detailed metadata about a specific file including frontmatter, tags, links, and file properties.',
				input_schema: {
					type: 'object',
					properties: {
						path: {
							type: 'string',
							description: 'The path to the file (e.g., "folder/note.md")'
						},
						include_frontmatter: {
							type: 'boolean',
							description: 'Optional: include YAML frontmatter data (default: true)'
						},
						include_links: {
							type: 'boolean',
							description: 'Optional: include outgoing links from the file (default: false)'
						},
						include_tags: {
							type: 'boolean',
							description: 'Optional: include tags found in the file (default: false)'
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

		// Build initial user message with current date/time and optional current note context
		const now = new Date();
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const dateTimeString = now.toLocaleString('en-US', {
			weekday: 'long',
			year: 'numeric',
			month: 'long',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			hour12: true,
			timeZone: timeZone
		});

		let initialMessage = `Current date and time: ${dateTimeString} (${timeZone})\n\n`;

		if (currentNotePath && currentNoteContent !== undefined) {
			initialMessage += `Current note: ${currentNotePath}\n\nCurrent note content:\n${currentNoteContent}\n\nUser request: ${userPrompt}`;
		} else {
			initialMessage += `User request: ${userPrompt}`;
		}

		const messages: Anthropic.MessageParam[] = [
			{
				role: 'user',
				content: initialMessage
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
						system: getVaultAgentSystemPrompt(this.settings.enableDeleteFiles),
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

							case 'rename_file':
								result = await this.handleRenameFile(toolInput.old_path, toolInput.new_path);
								operations.push({ type: 'rename', path: toolInput.old_path, newPath: toolInput.new_path });
								break;

							case 'delete_file':
								result = await this.handleDeleteFile(toolInput.path);
								operations.push({ type: 'delete', path: toolInput.path });
								break;

							case 'list_files':
								result = await this.handleListFiles(
									toolInput.folder,
									toolInput.pattern,
									toolInput.include_metadata || false
								);
								break;

							case 'search_files':
								result = await this.handleSearchFiles(
									toolInput.query,
									toolInput.folder,
									toolInput.case_sensitive || false,
									toolInput.max_results || 50
								);
								break;

							case 'get_file_metadata':
								result = await this.handleGetFileMetadata(
									toolInput.path,
									toolInput.include_frontmatter !== false,
									toolInput.include_links || false,
									toolInput.include_tags || false
								);
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

	// Helper method to strip duplicate H1 headings that match filename
	private stripDuplicateHeading(content: string, filename: string): string {
		const baseFilename = filename.replace(/\.md$/, '');
		const lines = content.split('\n');

		// Check if first non-empty line is H1 matching filename
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line === '') continue;

			// Check if it's an H1 heading matching the filename
			if (line.startsWith('# ') && line.substring(2).trim() === baseFilename) {
				// Remove this line
				lines.splice(i, 1);
				return lines.join('\n');
			}

			// Stop at first non-empty line
			break;
		}

		return content;
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

		// Strip duplicate heading if it matches the filename
		const cleanedContent = this.stripDuplicateHeading(content, file.name);

		await this.app.vault.modify(file, cleanedContent);
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

	async handleRenameFile(oldPath: string, newPath: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(oldPath);

		if (!file) {
			throw new Error(`File not found: ${oldPath}`);
		}

		// Check if destination already exists
		const existingFile = this.app.vault.getAbstractFileByPath(newPath);
		if (existingFile) {
			throw new Error(`Destination already exists: ${newPath}`);
		}

		// Use fileManager.renameFile to automatically update links
		await this.app.fileManager.renameFile(file, newPath);
		return `Successfully renamed ${oldPath} to ${newPath}`;
	}

	async handleDeleteFile(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);

		if (!file) {
			throw new Error(`File not found: ${path}`);
		}

		// Use fileManager.trashFile to respect user's trash preferences
		await this.app.fileManager.trashFile(file);
		return `Successfully deleted ${path}`;
	}

	async handleListFiles(folder?: string, pattern?: string, includeMetadata = false): Promise<string> {
		let files = this.app.vault.getMarkdownFiles();

		// Filter by folder if specified
		if (folder) {
			const normalizedFolder = folder.endsWith('/') ? folder : folder + '/';
			files = files.filter(f => f.path.startsWith(normalizedFolder));
		}

		// Filter by pattern if specified
		if (pattern) {
			const searchFn = prepareSimpleSearch(pattern.toLowerCase());
			files = files.filter(f => searchFn(f.path.toLowerCase()));
		}

		// Build results
		const results = files.map(file => {
			const result: any = {
				path: file.path,
				name: file.name
			};

			if (includeMetadata) {
				result.size = file.stat.size;
				result.created = file.stat.ctime;
				result.modified = file.stat.mtime;
			}

			return result;
		});

		return JSON.stringify({
			files: results,
			count: results.length
		});
	}

	async handleSearchFiles(query: string, folder?: string, caseSensitive = false, maxResults = 50): Promise<string> {
		// Prepare search function using Obsidian's utility
		const searchQuery = caseSensitive ? query : query.toLowerCase();
		const searchFn = prepareSimpleSearch(searchQuery);

		let files = this.app.vault.getMarkdownFiles();

		// Filter by folder if specified
		if (folder) {
			const normalizedFolder = folder.endsWith('/') ? folder : folder + '/';
			files = files.filter(f => f.path.startsWith(normalizedFolder));
		}

		const results = [];
		let filesSearched = 0;

		for (const file of files) {
			if (results.length >= maxResults) break;

			filesSearched++;
			const content = await this.app.vault.cachedRead(file);
			const searchContent = caseSensitive ? content : content.toLowerCase();

			// Check if file matches
			if (searchFn(searchContent)) {
				// Find matching lines for context
				const lines = content.split('\n');
				const matches = [];

				for (let i = 0; i < lines.length; i++) {
					const lineContent = caseSensitive ? lines[i] : lines[i].toLowerCase();
					if (searchFn(lineContent)) {
						matches.push({
							line: i + 1,
							content: lines[i].substring(0, 200) // Limit line length
						});

						if (matches.length >= 5) break; // Max 5 matches per file
					}
				}

				results.push({
					path: file.path,
					matches
				});
			}
		}

		return JSON.stringify({
			results,
			total_files_searched: filesSearched,
			files_with_matches: results.length,
			truncated: results.length >= maxResults
		});
	}

	async handleGetFileMetadata(path: string, includeFrontmatter = true, includeLinks = false, includeTags = false): Promise<string> {
		const file = this.app.vault.getFileByPath(path);

		if (!file || !(file instanceof TFile)) {
			throw new Error(`File not found: ${path}`);
		}

		const result: any = {
			path: file.path,
			name: file.name,
			basename: file.basename,
			extension: file.extension,
			size: file.stat.size,
			created: file.stat.ctime,
			modified: file.stat.mtime
		};

		// Get metadata from cache
		const metadata = this.app.metadataCache.getCache(path);

		if (metadata) {
			if (includeFrontmatter && metadata.frontmatter) {
				result.frontmatter = metadata.frontmatter;
			}

			if (includeLinks && metadata.links) {
				result.links = metadata.links.map(link => link.link);
			}

			if (includeTags && metadata.tags) {
				result.tags = metadata.tags.map(tag => tag.tag);
			}
		}

		return JSON.stringify(result);
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

		contentEl.createEl('h2', { text: 'Edit note with Claude' });

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
			text: 'Run',
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

			// Check if the response is an error message
			if (modifiedContent.startsWith('[ERROR:')) {
				processingNotice.hide();
				// Extract the error message (remove [ERROR: and the closing ])
				const errorMessage = modifiedContent.substring(7, modifiedContent.length - 1).trim();
				new ErrorMessageModal(this.app, errorMessage).open();
				return;
			}

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
	editor?: Editor;
	view?: MarkdownView;
	promptInput: HTMLTextAreaElement;

	constructor(app: App, plugin: AICopilotPlugin, editor?: Editor, view?: MarkdownView) {
		super(app);
		this.plugin = plugin;
		this.editor = editor;
		this.view = view;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		this.modalEl.addClass('ai-copilot-modal');

		contentEl.createEl('h2', { text: 'Make changes anywhere with Claude' });

		const descriptionText = this.plugin.settings.enableDeleteFiles
			? 'How can Claude help edit your files? Claude can read, create, modify, rename, and delete any files in your vault.'
			: 'How can Claude help edit your files? Claude can read, create, modify, and rename files in your vault.';

		contentEl.createEl('p', {
			text: descriptionText,
			cls: 'setting-item-description'
		});

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
			text: 'Run',
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

		// Get current note context if available
		let currentNotePath: string | undefined;
		let currentNoteContent: string | undefined;

		if (this.editor && this.view && this.view.file) {
			currentNotePath = this.view.file.path;
			currentNoteContent = this.editor.getValue();
		}

		this.close();

		const processingNotice = new Notice('Claude is working on your vault...', 0);

		try {
			const operations = await this.plugin.processVaultAgent(prompt, currentNotePath, currentNoteContent);

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

		contentEl.createEl('h2', { text: 'Summary of changes Claude made' });

		// Create scrollable content container
		const scrollContainer = contentEl.createDiv();
		scrollContainer.style.maxHeight = '60vh';
		scrollContainer.style.overflowY = 'auto';
		scrollContainer.style.marginBottom = '1em';

		if (this.operations.length === 0) {
			scrollContainer.createEl('p', {
				text: 'Claude completed without performing any file operations.',
				cls: 'setting-item-description'
			});
		} else {
			// Group operations by type
			const reads = this.operations.filter(op => op.type === 'read');
			const creates = this.operations.filter(op => op.type === 'create');
			const writes = this.operations.filter(op => op.type === 'write');
			const renames = this.operations.filter(op => op.type === 'rename');
			const deletes = this.operations.filter(op => op.type === 'delete');

			// Files read
			if (reads.length > 0) {
				scrollContainer.createEl('h3', { text: `Files Read (${reads.length})` });
				const readList = scrollContainer.createEl('ul');
				reads.forEach(op => {
					readList.createEl('li', { text: op.path });
				});
			}

			// Files created
			if (creates.length > 0) {
				scrollContainer.createEl('h3', { text: `Files Created (${creates.length})` });
				const createList = scrollContainer.createEl('ul');
				createList.style.color = 'var(--text-success)';
				creates.forEach(op => {
					createList.createEl('li', { text: op.path });
				});
			}

			// Files updated
			if (writes.length > 0) {
				scrollContainer.createEl('h3', { text: `Files Updated (${writes.length})` });
				const writeList = scrollContainer.createEl('ul');
				writeList.style.color = 'var(--text-warning)';
				writes.forEach(op => {
					writeList.createEl('li', { text: op.path });
				});
			}

			// Files renamed
			if (renames.length > 0) {
				scrollContainer.createEl('h3', { text: `Files Renamed (${renames.length})` });
				const renameList = scrollContainer.createEl('ul');
				renameList.style.color = 'var(--text-accent)';
				renames.forEach(op => {
					renameList.createEl('li', { text: `${op.path} → ${op.newPath}` });
				});
			}

			// Files deleted
			if (deletes.length > 0) {
				scrollContainer.createEl('h3', { text: `Files Deleted (${deletes.length})` });
				const deleteList = scrollContainer.createEl('ul');
				deleteList.style.color = 'var(--text-error)';
				deletes.forEach(op => {
					deleteList.createEl('li', { text: op.path });
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

// Modal to show error messages from AI
class ErrorMessageModal extends Modal {
	message: string;

	constructor(app: App, message: string) {
		super(app);
		this.message = message;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		this.modalEl.addClass('ai-copilot-modal');

		contentEl.createEl('h2', { text: 'Unable to Complete Request' });

		contentEl.createEl('p', {
			text: this.message,
			cls: 'setting-item-description'
		});

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

		containerEl.createEl('h2', { text: 'Claude AI Co-Pilot Settings' });

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

		new Setting(containerEl)
			.setName('Enable File Deletion')
			.setDesc('Allow the vault agent to delete files. When disabled, the delete_file tool will not be available to the AI.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableDeleteFiles)
				.onChange(async (value) => {
					this.plugin.settings.enableDeleteFiles = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('p', {
			text: 'Note: This plugin sends your note content to Anthropic\'s API. Make sure you\'re comfortable with this before using the plugin with sensitive information.',
			cls: 'setting-item-description'
		});
	}
}
