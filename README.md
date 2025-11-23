# Claude AI Copilot for Obsidian

Claude AI powered vault assistant that can edit notes, create files, and organize your entire vault using natural language.

## Features

- **Natural Language Editing**: Use simple prompts to modify your notes (e.g., "Fix spelling errors", "Add headers", "Summarize this")
- **Powered by Claude**: Uses Anthropic's Claude Sonnet 4.5 for intelligent, context-aware editing
- **Web Search & Fetch**: Claude can search the web and fetch content from URLs to enhance your notes
- **Safe Modifications**: The AI is instructed to only change what you explicitly request, preserving the rest of your note
- **Simple Interface**: Quick command palette access with an easy-to-use prompt modal

## Installation

### For Development

1. Clone or download this repository
2. Navigate to the plugin directory:
   ```bash
   cd obsidian-ai-copilot
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Build the plugin:
   ```bash
   npm run build
   ```

5. Copy the following files to your Obsidian vault's plugins folder:
   - Create folder: `<your-vault>/.obsidian/plugins/ai-copilot/`
   - Copy `main.js`, `manifest.json`, and `styles.css` (if it exists) to this folder

6. Reload Obsidian and enable the plugin in Settings → Community Plugins

### Manual Installation

1. Download the latest release files (`main.js` and `manifest.json`)
2. Create folder `<your-vault>/.obsidian/plugins/ai-copilot/`
3. Copy the downloaded files to this folder
4. Reload Obsidian and enable the plugin

## Configuration

1. Open Obsidian Settings
2. Navigate to "AI Co-Pilot" under Plugin Options
3. Enter your Anthropic API key
   - Get an API key at [https://console.anthropic.com/](https://console.anthropic.com/)
   - You'll need to create an account and add credits
4. (Optional) Customize the model name if you want to use a different Claude model

### Enabling Web Search

To use web search functionality (e.g., "Search for the latest React best practices and add them to this note"), you must **enable web search in your Anthropic account**:

1. Go to [https://console.anthropic.com/](https://console.anthropic.com/)
2. Navigate to your account settings
3. Enable web search for your API key

**Note**: Web search uses your API credits. Web fetch (fetching content from specific URLs) works automatically without additional setup.

## Usage

1. Open any note in Obsidian
2. Open the command palette (Ctrl/Cmd + P)
3. Search for "Open AI Co-Pilot Prompt" and select it
4. Enter your request in the prompt modal
5. Press Enter or click "Apply Changes"
6. Wait for the AI to process your request
7. Your note will be updated with the requested changes

### Example Prompts

**Basic Editing:**
- "Fix all spelling and grammar errors"
- "Add headers to organize this content into sections"
- "Summarize this note in 3 bullet points at the top"
- "Convert this list into a table"
- "Add tags at the bottom based on the content"
- "Rewrite this in a more professional tone"
- "Expand on the second paragraph with more details"

**With Web Search:**
- "Search for the latest best practices on TypeScript and add a section to this note"
- "Find recent news about AI and create a summary"
- "Look up current React hooks patterns and incorporate them here"

**With Web Fetch:**
- "Fetch https://example.com/article and add a summary to this note"
- "Get the content from https://example.com/doc.pdf and extract the key points"

## How It Works

1. When you submit a prompt, the plugin captures the entire content of your current note
2. It sends both the note content and your prompt to Anthropic's Claude API
3. Claude is instructed via a system prompt to only modify what you request and preserve everything else
4. The plugin receives the modified note and replaces the current content
5. All changes are applied atomically, so you can undo with Ctrl/Cmd + Z if needed

## ⚠️ Privacy Notice

This plugin sends user-selected note content to the Anthropic API when explicitly invoked through the "Open AI Co-Pilot Prompt" command.

**What data is sent:**
- The complete content of your current note
- Your prompt/instructions

**When data is sent:**
- Only when you explicitly run the command and submit a prompt
- No automatic or background data transmission
- No telemetry or analytics

**How your API key is stored:**
- API keys are stored locally in Obsidian's plugin settings
- Keys are never transmitted to any server other than Anthropic's API
- Keys are not shared with the plugin author or any third parties

**Your responsibility:**
- Do not use this plugin with sensitive or confidential information unless you accept that it will be processed by Anthropic
- Review Anthropic's privacy policy at [https://www.anthropic.com/legal/privacy](https://www.anthropic.com/legal/privacy)

## Important Notes

- **API Costs**: This plugin uses Anthropic's paid API. Each request will consume API credits based on the size of your note and the response
- **Privacy**: Your note content is sent to Anthropic's servers for processing. Don't use this plugin with sensitive information unless you're comfortable with this
- **Backup**: Always keep backups of your vault. While the plugin is designed to be safe, AI responses can be unpredictable
- **Undo**: If the AI makes unwanted changes, use Ctrl/Cmd + Z to undo

## Development

### Build for Development
```bash
npm run dev
```

This will watch for file changes and automatically rebuild.

### Build for Production
```bash
npm run build
```

### Version Bumping
Update the version in `package.json`, then run:
```bash
npm version patch  # or minor, or major
```

This will automatically update `manifest.json` and `versions.json`.

## Troubleshooting

**"Anthropic API key not configured" error**
- Make sure you've added your API key in the plugin settings

**"Failed to process with AI" error**
- Check your internet connection
- Verify your API key is valid and has credits
- Check the console (Ctrl/Cmd + Shift + I) for more detailed error messages

**Plugin not showing in command palette**
- Make sure the plugin is enabled in Settings → Community Plugins
- Try reloading Obsidian

## Future Enhancements

Potential features for future versions:
- Selection-based editing (modify only selected text)
- Multi-note editing (apply changes across multiple notes)
- Custom system prompts
- Streaming responses for large notes
- Diff view before applying changes
- Prompt history and templates

## License

This plugin is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](./LICENSE).

If you wish to use or distribute this software as part of a commercial or closed-source product,
please contact **Eric Anderson** for a commercial license.

## Disclaimer

This is an experimental plugin. Use at your own risk. Always keep backups of your important notes.

