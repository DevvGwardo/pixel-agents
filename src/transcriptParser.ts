import * as path from 'path';
import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import {
	cancelWaitingTimer,
	startWaitingTimer,
	clearAgentActivity,
	startPermissionTimer,
	cancelPermissionTimer,
} from './timerManager.js';
import {
	TOOL_DONE_DELAY_MS,
	TEXT_IDLE_DELAY_MS,
	BASH_COMMAND_DISPLAY_MAX_LENGTH,
	TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from './constants.js';

export const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'AskUserQuestion']);

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
	const base = (p: unknown) => typeof p === 'string' ? path.basename(p) : '';
	switch (toolName) {
		// Claude Code tools
		case 'Read': return `Reading ${base(input.file_path)}`;
		case 'Edit': return `Editing ${base(input.file_path)}`;
		case 'Write': return `Writing ${base(input.file_path)}`;
		case 'Bash': {
			const cmd = (input.command as string) || '';
			return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
		}
		case 'Glob': return 'Searching files';
		case 'Grep': return 'Searching code';
		case 'WebFetch': return 'Fetching web content';
		case 'WebSearch': return 'Searching the web';
		case 'Task': {
			const desc = typeof input.description === 'string' ? input.description : '';
			return desc ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}` : 'Running subtask';
		}
		case 'AskUserQuestion': return 'Waiting for your answer';
		case 'EnterPlanMode': return 'Planning';
		case 'NotebookEdit': return `Editing notebook`;
		// OpenClaw tools
		case 'exec': {
			const cmd = (input.command as string) || '';
			return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
		}
		case 'web_fetch': return 'Fetching web content';
		case 'browser': return 'Browsing web';
		case 'canvas': return 'Drawing on canvas';
		case 'nodes': return 'Working with nodes';
		case 'cron': return 'Scheduling task';
		case 'discord': return 'Using Discord';
		case 'slack': return 'Using Slack';
		case 'sessions': return 'Managing sessions';
		default: return `Using ${toolName}`;
	}
}

/**
 * Resolve the "role" of a transcript record.
 *
 * Claude Code format: record.type is 'assistant' | 'user' | 'system' | 'progress'
 * OpenClaw format:    record.type is always 'message', role lives at record.message.role
 *                     Other record types: 'session', 'model_change', 'thinking_level_change', 'custom'
 */
function resolveRole(record: Record<string, unknown>): string {
	// Claude Code style — record.type directly indicates the role
	if (record.type === 'assistant' || record.type === 'user' || record.type === 'system' || record.type === 'progress') {
		return record.type as string;
	}
	// OpenClaw style — record.type is 'message', role is in record.message.role
	if (record.type === 'message') {
		const msg = record.message as Record<string, unknown> | undefined;
		return (msg?.role as string) || '';
	}
	return record.type as string || '';
}

/**
 * Extract tool-call blocks from an assistant message content array.
 * Handles both Claude Code ("tool_use") and OpenClaw ("toolCall") block types.
 */
function extractToolCalls(blocks: Array<Record<string, unknown>>): Array<{
	id: string; name: string; input: Record<string, unknown>;
}> {
	const tools: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
	for (const block of blocks) {
		// Claude Code: { type: "tool_use", id, name, input }
		if (block.type === 'tool_use' && block.id) {
			tools.push({
				id: block.id as string,
				name: (block.name as string) || '',
				input: (block.input as Record<string, unknown>) || {},
			});
		}
		// OpenClaw: { type: "toolCall", id, name, arguments }
		if (block.type === 'toolCall' && block.id) {
			// OpenClaw toolCall IDs can contain a pipe separator — use the full ID
			const args = (block.arguments as Record<string, unknown>) ||
				(typeof block.partialJson === 'string' ? tryParseJson(block.partialJson) : {});
			tools.push({
				id: block.id as string,
				name: (block.name as string) || '',
				input: args,
			});
		}
	}
	return tools;
}

function tryParseJson(s: string): Record<string, unknown> {
	try { return JSON.parse(s); } catch { return {}; }
}

export function processTranscriptLine(
	agentId: number,
	line: string,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) {return;}
	try {
		const record = JSON.parse(line);
		const role = resolveRole(record);

		if (role === 'assistant' && Array.isArray(record.message?.content)) {
			const blocks = record.message.content as Array<Record<string, unknown>>;
			const toolCalls = extractToolCalls(blocks);

			if (toolCalls.length > 0) {
				cancelWaitingTimer(agentId, waitingTimers);
				agent.isWaiting = false;
				agent.hadToolsInTurn = true;
				webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
				let hasNonExemptTool = false;
				for (const tool of toolCalls) {
					const status = formatToolStatus(tool.name, tool.input);
					console.log(`[Pixel Agents] Agent ${agentId} tool start: ${tool.id} ${status}`);
					agent.activeToolIds.add(tool.id);
					agent.activeToolStatuses.set(tool.id, status);
					agent.activeToolNames.set(tool.id, tool.name);
					if (!PERMISSION_EXEMPT_TOOLS.has(tool.name)) {
						hasNonExemptTool = true;
					}
					webview?.postMessage({
						type: 'agentToolStart',
						id: agentId,
						toolId: tool.id,
						status,
					});
				}
				if (hasNonExemptTool) {
					startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
				}
			} else if (blocks.some(b => b.type === 'text') && !agent.hadToolsInTurn) {
				startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
			}
		} else if (role === 'progress') {
			processProgressRecord(agentId, record, agents, waitingTimers, permissionTimers, webview);
		} else if (role === 'toolResult') {
			// OpenClaw-style: toolResult is a separate message record
			const msg = record.message as Record<string, unknown> | undefined;
			const toolCallId = (msg?.toolCallId as string) || (msg?.tool_use_id as string) || (record.tool_use_id as string);
			if (toolCallId) {
				console.log(`[Pixel Agents] Agent ${agentId} tool done (OpenClaw): ${toolCallId}`);
				if (agent.activeToolNames.get(toolCallId) === 'Task') {
					agent.activeSubagentToolIds.delete(toolCallId);
					agent.activeSubagentToolNames.delete(toolCallId);
					webview?.postMessage({
						type: 'subagentClear',
						id: agentId,
						parentToolId: toolCallId,
					});
				}
				agent.activeToolIds.delete(toolCallId);
				agent.activeToolStatuses.delete(toolCallId);
				agent.activeToolNames.delete(toolCallId);
				const completedId = toolCallId;
				setTimeout(() => {
					webview?.postMessage({
						type: 'agentToolDone',
						id: agentId,
						toolId: completedId,
					});
				}, TOOL_DONE_DELAY_MS);
				if (agent.activeToolIds.size === 0) {
					agent.hadToolsInTurn = false;
				}
			}
		} else if (role === 'user') {
			const content = record.message?.content;
			if (Array.isArray(content)) {
				const blocks = content as Array<{ type: string; tool_use_id?: string }>;
				const hasToolResult = blocks.some(b => b.type === 'tool_result');
				if (hasToolResult) {
					for (const block of blocks) {
						if (block.type === 'tool_result' && block.tool_use_id) {
							console.log(`[Pixel Agents] Agent ${agentId} tool done: ${block.tool_use_id}`);
							const completedToolId = block.tool_use_id;
							// If the completed tool was a Task, clear its subagent tools
							if (agent.activeToolNames.get(completedToolId) === 'Task') {
								agent.activeSubagentToolIds.delete(completedToolId);
								agent.activeSubagentToolNames.delete(completedToolId);
								webview?.postMessage({
									type: 'subagentClear',
									id: agentId,
									parentToolId: completedToolId,
								});
							}
							agent.activeToolIds.delete(completedToolId);
							agent.activeToolStatuses.delete(completedToolId);
							agent.activeToolNames.delete(completedToolId);
							const toolId = completedToolId;
							setTimeout(() => {
								webview?.postMessage({
									type: 'agentToolDone',
									id: agentId,
									toolId,
								});
							}, TOOL_DONE_DELAY_MS);
						}
					}
					// All tools completed — allow text-idle timer as fallback
					if (agent.activeToolIds.size === 0) {
						agent.hadToolsInTurn = false;
					}
				} else {
					// New user text prompt — new turn starting
					cancelWaitingTimer(agentId, waitingTimers);
					clearAgentActivity(agent, agentId, permissionTimers, webview);
					agent.hadToolsInTurn = false;
				}
			} else if (typeof content === 'string' && content.trim()) {
				// New user text prompt — new turn starting
				cancelWaitingTimer(agentId, waitingTimers);
				clearAgentActivity(agent, agentId, permissionTimers, webview);
				agent.hadToolsInTurn = false;
			}
		} else if ((role === 'system' && record.subtype === 'turn_duration') ||
				   (role === 'system' && record.subtype === 'turn_end')) {
			cancelWaitingTimer(agentId, waitingTimers);
			cancelPermissionTimer(agentId, permissionTimers);

			// Definitive turn-end: clean up any stale tool state
			if (agent.activeToolIds.size > 0) {
				agent.activeToolIds.clear();
				agent.activeToolStatuses.clear();
				agent.activeToolNames.clear();
				agent.activeSubagentToolIds.clear();
				agent.activeSubagentToolNames.clear();
				webview?.postMessage({ type: 'agentToolsClear', id: agentId });
			}

			agent.isWaiting = true;
			agent.permissionSent = false;
			agent.hadToolsInTurn = false;
			webview?.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	} catch {
		// Ignore malformed lines
	}
}

function processProgressRecord(
	agentId: number,
	record: Record<string, unknown>,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) {return;}

	const parentToolId = record.parentToolUseID as string | undefined;
	if (!parentToolId) {return;}

	const data = record.data as Record<string, unknown> | undefined;
	if (!data) {return;}

	// bash_progress / mcp_progress: tool is actively executing, not stuck on permission.
	const dataType = data.type as string | undefined;
	if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
		if (agent.activeToolIds.has(parentToolId)) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
		}
		return;
	}

	// Verify parent is an active Task tool (agent_progress handling)
	if (agent.activeToolNames.get(parentToolId) !== 'Task') {return;}

	const msg = data.message as Record<string, unknown> | undefined;
	if (!msg) {return;}

	const msgType = msg.type as string;
	const innerMsg = msg.message as Record<string, unknown> | undefined;
	const content = innerMsg?.content;
	if (!Array.isArray(content)) {return;}

	if (msgType === 'assistant') {
		const subToolCalls = extractToolCalls(content);
		let hasNonExemptSubTool = false;
		for (const tool of subToolCalls) {
			const status = formatToolStatus(tool.name, tool.input);
			console.log(`[Pixel Agents] Agent ${agentId} subagent tool start: ${tool.id} ${status} (parent: ${parentToolId})`);

			let subTools = agent.activeSubagentToolIds.get(parentToolId);
			if (!subTools) {
				subTools = new Set();
				agent.activeSubagentToolIds.set(parentToolId, subTools);
			}
			subTools.add(tool.id);

			let subNames = agent.activeSubagentToolNames.get(parentToolId);
			if (!subNames) {
				subNames = new Map();
				agent.activeSubagentToolNames.set(parentToolId, subNames);
			}
			subNames.set(tool.id, tool.name);

			if (!PERMISSION_EXEMPT_TOOLS.has(tool.name)) {
				hasNonExemptSubTool = true;
			}

			webview?.postMessage({
				type: 'subagentToolStart',
				id: agentId,
				parentToolId,
				toolId: tool.id,
				status,
			});
		}
		if (hasNonExemptSubTool) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
		}
	} else if (msgType === 'user') {
		for (const block of content) {
			if (block.type === 'tool_result' && block.tool_use_id) {
				console.log(`[Pixel Agents] Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`);

				const subTools = agent.activeSubagentToolIds.get(parentToolId);
				if (subTools) {
					subTools.delete(block.tool_use_id);
				}
				const subNames = agent.activeSubagentToolNames.get(parentToolId);
				if (subNames) {
					subNames.delete(block.tool_use_id);
				}

				const toolId = block.tool_use_id;
				setTimeout(() => {
					webview?.postMessage({
						type: 'subagentToolDone',
						id: agentId,
						parentToolId,
						toolId,
					});
				}, 300);
			}
		}
		let stillHasNonExempt = false;
		for (const [, subNames] of agent.activeSubagentToolNames) {
			for (const [, toolName] of subNames) {
				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					stillHasNonExempt = true;
					break;
				}
			}
			if (stillHasNonExempt) {break;}
		}
		if (stillHasNonExempt) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
		}
	}
}
