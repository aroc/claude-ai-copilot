# Future Features & Roadmap

This document outlines planned enhancements for the AI Co-Pilot Obsidian plugin.

## Agent Loop System

### Overview
The current implementation works on a single note at a time with a simple request-response pattern. The future vision is to implement a true agentic system that can work across multiple files with an iterative decision-making loop.

### Architecture

#### Multi-File Agent Loop
Instead of the current simple pattern where we:
1. Send entire note content + prompt to AI
2. Receive complete modified note
3. Replace content

We would implement an agent loop where the AI can:
1. Receive a list of all file names in the vault (or a subset based on scope)
2. Decide which files to read, one at a time
3. Build up context and understanding iteratively
4. Make decisions about which files to modify
5. Write to multiple files as needed

#### Technical Implementation
- **Agent SDK**: Use the Claude Code agent-sdk to implement the agentic loop
- **Tool System**: Provide the agent with tools:
  - `list_files()` - Get all available files in scope
  - `read_file(filename)` - Read content of a specific file
  - `write_file(filename, content)` - Modify a specific file
  - `search_files(query)` - Find files matching certain criteria

#### Benefits
- **Cross-Note Intelligence**: Agent can understand relationships between notes
- **Targeted Changes**: Only reads files it needs, more efficient
- **Multi-File Edits**: Can refactor, reorganize, or update information across entire vault
- **Contextual Awareness**: Can gather context from multiple sources before making changes

### Example Use Cases

#### Use Case 1: Cross-Vault Refactoring
**Prompt**: "Change all instances of 'project-alpha' to 'project-nexus' across my vault"

**Agent Loop**:
1. Receives list of all markdown files
2. Searches for files containing "project-alpha"
3. Reads each matching file
4. Modifies and writes back each file with updated name
5. Reports summary of changes made

#### Use Case 2: Knowledge Graph Updates
**Prompt**: "I've updated my tagging system. Update all notes tagged #old-tag to use #new-tag and ensure they're properly linked"

**Agent Loop**:
1. Searches for all files with #old-tag
2. Reads each file to understand context
3. Updates tags and adds appropriate links
4. Writes modified files back
5. Optionally creates an index note linking all updated notes

#### Use Case 3: Smart Note Organization
**Prompt**: "Organize my daily notes into weekly summaries"

**Agent Loop**:
1. Lists all daily note files from a date range
2. Reads each daily note
3. Synthesizes information into weekly summaries
4. Creates new weekly summary notes
5. Adds backlinks from daily notes to summaries

### Scope Control

Users should be able to control the scope of agent operations:
- **Current Note Only** (current implementation)
- **Current Folder**: Agent can access all files in the current folder
- **Vault-Wide**: Agent has access to all files in the vault
- **Custom Scope**: User selects specific folders or files

### Safety & Permissions

#### Change Preview
Before applying changes, show user:
- List of files that will be modified
- Diff preview of changes
- Option to approve or reject changes

#### Rollback System
- Create automatic backups before agent runs
- Provide easy rollback functionality
- Track all changes in a session log

#### Rate Limiting
- Limit number of files agent can modify in one session
- Require confirmation for large-scale changes (e.g., >10 files)
- Set token/cost limits to prevent runaway API usage

## Implementation Phases

### Phase 1: Current State ✅
- Single note editing
- Simple request-response pattern
- Basic Anthropic API integration

### Phase 2: Selection-Based Editing
- Allow users to select specific text in a note
- Agent modifies only the selection
- Preserve rest of note exactly

### Phase 3: Multi-File Read Access
- Agent can list and read multiple files
- Still writes to only current file
- Useful for "summarize these 5 notes" type requests

### Phase 4: Full Agent Loop
- Complete agent-sdk integration
- Multi-file read and write capabilities
- Tool-based architecture
- Change preview and approval system

### Phase 5: Advanced Features
- Streaming responses for real-time feedback
- Custom tool definitions for specialized workflows
- Plugin API for extending agent capabilities
- Integration with Obsidian's graph view and metadata

## Technical Considerations

### Claude Code Agent SDK Integration
The agent-sdk provides:
- **Tool Registration**: Define custom tools for file operations
- **Loop Management**: Handle multi-step agentic reasoning
- **Context Management**: Efficiently manage conversation context across many tool calls
- **Error Handling**: Robust error recovery in agent loops

### API Costs
Multi-file operations will consume more tokens:
- Consider implementing cost estimates before execution
- Show estimated cost to user before running agent
- Allow setting budget limits per session

### Performance
- Implement caching for frequently accessed files
- Batch operations where possible
- Show progress indicators during long-running operations

### Obsidian Integration
- Respect Obsidian's file watching and syncing
- Trigger proper Obsidian events when files change
- Integrate with Obsidian's undo/redo system across multiple files

## User Interface Enhancements

### Agent Activity Monitor
Real-time view showing:
- Current agent task
- Files being read
- Decisions being made
- Changes being applied

### Prompt Templates
Pre-built prompts for common operations:
- "Standardize frontmatter across vault"
- "Find and fix broken links"
- "Generate table of contents for folder"
- "Create index note from folder contents"

### History & Analytics
- Track all agent sessions
- Show statistics (files modified, tokens used, cost)
- Replay previous sessions
- Learn from user approval/rejection patterns

## References

- [Claude Code Agent SDK](https://github.com/anthropics/claude-code)
- Obsidian API Documentation
- Agentic AI Design Patterns
