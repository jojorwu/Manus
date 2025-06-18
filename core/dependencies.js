// core/dependencies.js
import path from 'path';
import EventEmitter from 'events';

// Import local modules using ES module syntax
import ResearchAgent from '../agents/ResearchAgent.js';
import UtilityAgent from '../agents/UtilityAgent.js';
import SubTaskQueue from './SubTaskQueue.js'; // Assuming these are in 'core' relative to 'core'
import ResultsQueue from './ResultsQueue.js'; // Adjust paths if they are elsewhere
import MemoryManager from './MemoryManager.js';

import WebSearchTool from '../tools/WebSearchTool.js';
import ReadWebpageTool from '../tools/ReadWebpageTool.js';
import CalculatorTool from '../tools/CalculatorTool.js';
import Context7Client from '../services/Context7Client.js';
import Context7DocumentationTool from '../tools/Context7DocumentationTool.js';

import GeminiService from '../services/ai/GeminiService.js';
import OpenAIService from '../services/ai/OpenAIService.js';
// import AnthropicAPIService from '../services/ai/AnthropicAPIService.js'; // Example

// --- GLOBAL EVENT EMITTER ---
const globalEventEmitter = new EventEmitter();

// --- QUEUES ---
const subTaskQueue = new SubTaskQueue();
const resultsQueue = new ResultsQueue();

// --- STORAGE AND MEMORY ---
// Note: process.cwd() might behave differently depending on how the application is started.
// It's generally better if critical paths like this are configurable via environment variables or a config file.
const savedTasksBaseDir = process.env.SAVED_TASKS_BASE_DIR || path.join(process.cwd(), 'tasks');
const memoryManager = new MemoryManager(globalEventEmitter); // Pass emitter

// --- CONFIGURATIONS ---
const agentApiKeysConfig = {
    googleSearch: {
        apiKey: process.env.SEARCH_API_KEY,
        cseId: process.env.CSE_ID
    }
    // Add other API key configurations as needed
};

// --- TOOLS ---
const webSearchTool = new WebSearchTool(agentApiKeysConfig.googleSearch);
const readWebpageTool = new ReadWebpageTool();
const calculatorTool = new CalculatorTool();
const context7ClientInstance = new Context7Client(process.env.CONTEXT7_SERVER_URL || 'http://localhost:8080/mcp');
const context7DocumentationTool = new Context7DocumentationTool(context7ClientInstance);

// --- AI SERVICES ---
const openAIService = new OpenAIService(process.env.OPENAI_API_KEY, {
    defaultModel: 'gpt-4o',
    planningModel: 'gpt-4-turbo',
    cwcUpdateModel: 'gpt-4o',
    synthesisModel: 'gpt-4-turbo',
    summarizationModel: 'gpt-3.5-turbo', // Or a specific summarization fine-tuned model
    fastModel: 'gpt-3.5-turbo' // For classification
});
const geminiService = new GeminiService(process.env.GEMINI_API_KEY, {
    defaultModel: 'gemini-1.5-flash-latest',
    planningModel: 'gemini-1.5-pro-latest',
    cwcUpdateModel: 'gemini-1.5-flash-latest',
    synthesisModel: 'gemini-1.5-pro-latest',
    summarizationModel: 'gemini-1.5-flash-latest',
    fastModel: 'gemini-1.5-flash-latest' // For classification
});
// const anthropicService = new AnthropicAPIService(process.env.ANTHROPIC_API_KEY, { /* ... */ });

// --- WORKER AGENTS ---
const researchAgentTools = {
    "WebSearchTool": webSearchTool,
    "ReadWebpageTool": readWebpageTool,
    "Context7DocumentationTool": context7DocumentationTool
};
const researchAgent = new ResearchAgent(subTaskQueue, resultsQueue, researchAgentTools, agentApiKeysConfig);

const utilityAgentTools = {
    "CalculatorTool": calculatorTool
};
const utilityAgent = new UtilityAgent(subTaskQueue, resultsQueue, utilityAgentTools, agentApiKeysConfig);

// Start worker agents
researchAgent.startListening();
utilityAgent.startListening();

console.log('[Dependencies] Global instances, AI services, tools, and worker agents initialized.');

export {
    globalEventEmitter,
    subTaskQueue,
    resultsQueue,
    memoryManager,
    savedTasksBaseDir,
    agentApiKeysConfig,
    // AI Services (needed by OrchestratorAgent via routeDependencies)
    openAIService,
    geminiService,
    // anthropicService, // If added
    // Individual tools might also be exported if needed elsewhere directly,
    // but typically agents access them via their configurations.
    webSearchTool,
    readWebpageTool,
    calculatorTool,
    context7DocumentationTool
};
