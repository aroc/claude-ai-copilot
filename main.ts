import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import Anthropic from '@anthropic-ai/sdk';

interface AICopilotSettings {
	anthropicApiKey: string;
	modelName: string;
}

const DEFAULT_SETTINGS: AICopilotSettings = {
	anthropicApiKey: '',
	modelName: 'claude-sonnet-4-5-20250929'
}

const SYSTEM_PROMPT = `You are an AI assistant helping to edit and improve notes in Obsidian.

IMPORTANT: The user will provide you with the full content of their current note and a specific request for changes. You must return the COMPLETE note with only the requested changes applied. Do NOT make any changes beyond what the user explicitly requests.

Rules:
- Only modify what the user specifically asks you to change
- Preserve all other content exactly as it appears
- Maintain the original formatting, structure, and style
- Do not add unnecessary improvements or suggestions unless asked
- Return the entire note content, not just the changed parts
- Do not include any explanations or comments about the changes

Your response should be the complete note content, ready to replace the current note.`;

export default class AICopilotPlugin extends Plugin {
	settings: AICopilotSettings;

	async onload() {
		await this.loadSettings();

		// Add command to open AI prompt
		this.addCommand({
			id: 'open-ai-prompt',
			name: 'Open AI Co-Pilot Prompt',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				new PromptModal(this.app, this, editor, view).open();
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

	async processWithAI(noteContent: string, userPrompt: string): Promise<string> {
		if (!this.settings.anthropicApiKey) {
			throw new Error('Anthropic API key not configured. Please add your API key in the plugin settings.');
		}

		const anthropic = new Anthropic({
			apiKey: this.settings.anthropicApiKey,
			dangerouslyAllowBrowser: true,
		});

		try {
			const message = await anthropic.messages.create({
				model: this.settings.modelName,
				max_tokens: 8096,
				system: SYSTEM_PROMPT,
				messages: [
					{
						role: 'user',
						content: `Current note content:\n\n${noteContent}\n\nUser request: ${userPrompt}\n\nPlease return the complete modified note:`
					}
				]
			});

			// Extract the text content from the response
			const textContent = message.content.find(block => block.type === 'text');
			if (!textContent || textContent.type !== 'text') {
				throw new Error('No text content in AI response');
			}

			return textContent.text;
		} catch (error) {
			console.error('AI processing error:', error);
			throw new Error(`Failed to process with AI: ${error.message}`);
		}
	}
}

class PromptModal extends Modal {
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

		contentEl.createEl('h2', { text: 'AI Co-Pilot' });

		contentEl.createEl('p', {
			text: 'Enter your request to modify the current note:',
			cls: 'setting-item-description'
		});

		// Create textarea for prompt input
		this.promptInput = contentEl.createEl('textarea', {
			placeholder: 'e.g., "Fix all spelling errors", "Summarize this note", "Add headers to organize the content"...',
		});
		this.promptInput.style.width = '100%';
		this.promptInput.style.minHeight = '100px';
		this.promptInput.style.marginBottom = '1em';
		this.promptInput.style.padding = '0.5em';
		this.promptInput.style.fontFamily = 'inherit';

		// Create button container
		const buttonContainer = contentEl.createDiv();
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '0.5em';

		// Cancel button
		const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
		});

		// Submit button
		const submitButton = buttonContainer.createEl('button', {
			text: 'Apply Changes',
			cls: 'mod-cta'
		});
		submitButton.addEventListener('click', () => {
			this.handleSubmit();
		});

		// Focus the textarea
		this.promptInput.focus();

		// Handle Enter key (Shift+Enter for newline, Enter to submit)
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

		// Get the current note content
		const currentContent = this.editor.getValue();

		if (!currentContent) {
			new Notice('No content in current note');
			return;
		}

		// Close the modal
		this.close();

		// Show processing notice
		const processingNotice = new Notice('Processing with AI...', 0); // 0 = infinite duration

		try {
			// Call the AI API
			const modifiedContent = await this.plugin.processWithAI(currentContent, prompt);

			// Replace the entire note content
			this.editor.setValue(modifiedContent);

			// Show success notice
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
