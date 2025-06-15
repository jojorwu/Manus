require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

// Импорт классов агентов и очередей
const OrchestratorAgent = require('./agents/OrchestratorAgent');
const ResearchAgent = require('./agents/ResearchAgent');
const UtilityAgent = require('./agents/UtilityAgent');
const SubTaskQueue = require('./core/SubTaskQueue');
const ResultsQueue = require('./core/ResultsQueue');

// Импорт классов инструментов
const WebSearchTool = require('./tools/WebSearchTool');
const ReadWebpageTool = require('./tools/ReadWebpageTool');
const CalculatorTool = require('./tools/CalculatorTool');
const Context7Client = require('./services/Context7Client'); // Added
const Context7DocumentationTool = require('./tools/Context7DocumentationTool'); // Added

// Импорт LLM сервиса
// const geminiLLMService = require('./services/LLMService'); // Removed
const GeminiService = require('./services/ai/GeminiService');
const OpenAIService = require('./services/ai/OpenAIService');
const { initializeLocalization, t } = require('./utils/localization');

initializeLocalization(); // Call localization setup

// Инициализация очередей
const subTaskQueue = new SubTaskQueue();
const resultsQueue = new ResultsQueue();

// Конфигурация API ключей для агентов (если необходимо для инструментов)
// README упоминает SEARCH_API_KEY и CSE_ID для WebSearchTool.
// Эти ключи должны быть доступны через process.env
const agentApiKeysConfig = {
    googleSearch: {
        apiKey: process.env.SEARCH_API_KEY,
        cseId: process.env.CSE_ID
    }
    // Другие ключи по мере необходимости
};

// Инициализация инструментов
const webSearchTool = new WebSearchTool(agentApiKeysConfig.googleSearch); // Предполагаем, что конструктор принимает конфиг
const readWebpageTool = new ReadWebpageTool();
const calculatorTool = new CalculatorTool();

// Initialize Context7 Client and Tool
const context7ServerUrl = process.env.CONTEXT7_SERVER_URL || 'http://localhost:8080/mcp';
const context7ClientInstance = new Context7Client(context7ServerUrl);
// console.log(`Context7 Client initialized for server: ${context7ServerUrl}`); // For localization later
const context7DocumentationTool = new Context7DocumentationTool(context7ClientInstance);

// Инициализация AI сервисов с детальной конфигурацией моделей
const openAIService = new OpenAIService(process.env.OPENAI_API_KEY, {
    defaultModel: 'gpt-3.5-turbo',
    planningModel: 'gpt-4',
    cwcUpdateModel: 'gpt-3.5-turbo',
    synthesisModel: 'gpt-4',
    defaultLLMStepModel: 'gpt-3.5-turbo',
    summarizationModel: 'gpt-3.5-turbo'
});

const geminiService = new GeminiService(process.env.GEMINI_API_KEY, {
    defaultModel: 'gemini-pro',
    planningModel: 'gemini-pro',
    cwcUpdateModel: 'gemini-pro',
    synthesisModel: 'gemini-pro',
    defaultLLMStepModel: 'gemini-pro',
    summarizationModel: 'gemini-pro'
});

// Global agents that don't depend on per-request AI service selection
const researchAgentTools = {
    "WebSearchTool": webSearchTool,
    "ReadWebpageTool": readWebpageTool,
    "Context7DocumentationTool": context7DocumentationTool // Added
};
const researchAgent = new ResearchAgent(subTaskQueue, resultsQueue, researchAgentTools, agentApiKeysConfig);

const utilityAgentTools = {
    "CalculatorTool": calculatorTool
};
const utilityAgent = new UtilityAgent(subTaskQueue, resultsQueue, utilityAgentTools, agentApiKeysConfig);

// Запуск прослушивания для рабочих агентов
researchAgent.startListening();
utilityAgent.startListening();

// Настройка Express приложения
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json()); // For parsing application/json

// Multer setup for file uploads
const storage = multer.memoryStorage(); // Store files in memory
const upload = multer({ storage: storage });

// API эндпоинт для задач
app.post('/api/generate-plan', upload.array('files'), async (req, res) => { // Added upload.array('files') middleware
    // req.body will contain text fields, req.files will contain file data
    const { task, taskIdToLoad, mode, aiService: requestedService, agentId } = req.body; // Added agentId, files will be in req.files

    // Files uploaded by multer will be in req.files.
    // OrchestratorAgent expects files in format: { name: string, content: string }
    const uploadedFileObjects = (req.files || []).map(file => ({
        name: file.originalname,
        content: file.buffer.toString() // Assuming files are text-based
    }));

    // Определяем режим по умолчанию, если не указан
    const effectiveMode = mode || "EXECUTE_FULL_PLAN";

    // Task validation needs to consider that 'task' might not be present if files are the primary input for some tasks.
    // However, current modes (EXECUTE_FULL_PLAN, PLAN_ONLY) require a task string.
    if (effectiveMode === "EXECUTE_FULL_PLAN" || effectiveMode === "PLAN_ONLY") {
        if (!task || typeof task !== 'string' || task.trim() === "") {
            // If files are provided, maybe the task string isn't strictly necessary?
            // For now, keeping the validation as per existing logic.
            // Consider if a task can be solely defined by its files in the future.
            return res.status(400).json({ success: false, message: `Invalid request: 'task' must be a non-empty string for ${effectiveMode} mode.` });
        }
    } else if (effectiveMode === "SYNTHESIZE_ONLY") {
        if (!taskIdToLoad || typeof taskIdToLoad !== 'string' || taskIdToLoad.trim() === "") {
            return res.status(400).json({ success: false, message: "Invalid request: 'taskIdToLoad' must be a non-empty string for SYNTHESIZE_ONLY mode." });
        }
        // В этом режиме 'task' не обязателен, так как он будет загружен из состояния
    } else if (effectiveMode === "PLAN_ONLY") {
        if (!task || typeof task !== 'string' || task.trim() === "") {
            return res.status(400).json({ success: false, message: "Invalid request: 'task' must be a non-empty string for PLAN_ONLY mode." });
        }
        // taskIdToLoad не используется в этом режиме
    } else if (effectiveMode === "EXECUTE_PLANNED_TASK") {
        if (!taskIdToLoad || typeof taskIdToLoad !== 'string' || taskIdToLoad.trim() === "") {
            return res.status(400).json({ success: false, message: "Invalid request: 'taskIdToLoad' must be a non-empty string for EXECUTE_PLANNED_TASK mode." });
        }
        // 'task' (userTaskString) не требуется в теле запроса, он будет загружен из состояния.
    } else {
        return res.status(400).json({ success: false, message: `Invalid request: Unknown mode '${effectiveMode}'.` });
    }

    const parentTaskId = uuidv4(); // Генерируем уникальный ID для этой сессии обработки

    try {
        // Логируем полученные параметры
        console.log(`Received API request for mode: ${effectiveMode}, task (if any): "${task ? task.substring(0, 50) + '...' : 'N/A'}", taskIdToLoad (if any): ${taskIdToLoad}, requested AI Service by agentId: ${agentId || 'default'}, generated parentTaskId: ${parentTaskId}, files: ${uploadedFileObjects.length}`);

        // Выбор AI сервиса для текущего запроса based on agentId (which maps to requestedService)
        // This logic assumes agentId from frontend corresponds to an AI service type (e.g., 'openai', 'gemini')
        let activeAIService;
        const serviceIdentifier = agentId || requestedService; // Prioritize agentId if provided

        if (serviceIdentifier && typeof serviceIdentifier === 'string') {
            if (serviceIdentifier.toLowerCase() === 'gemini') {
                activeAIService = geminiService;
            } else if (serviceIdentifier.toLowerCase() === 'openai') {
                activeAIService = openAIService;
            } else {
                console.warn(`Invalid aiService/agentId '${serviceIdentifier}' requested. Falling back to default (OpenAI).`);
                activeAIService = openAIService; // Default
            }
        } else {
            activeAIService = openAIService; // Default if not specified
        }

        console.log(`Request ${parentTaskId}: Using AI Service: ${activeAIService.getServiceName()} for this task.`);

        // Инициализация OrchestratorAgent внутри обработчика с выбранным AI сервисом
        const orchestratorAgent = new OrchestratorAgent(subTaskQueue, resultsQueue, activeAIService, agentApiKeysConfig);

        // userTaskString для handleUserTask будет либо `task` из запроса.
        // uploadedFileObjects is the new array of file objects.
        const result = await orchestratorAgent.handleUserTask(task, uploadedFileObjects, parentTaskId, taskIdToLoad, effectiveMode);
        console.log("Orchestrator result:", result); // Consider logging less for very large results
        res.json(result);
    } catch (error) {
        console.error(`Error in /api/generate-plan (parentTaskId: ${parentTaskId}):`, error);
        // Ensure error details are not too verbose or sensitive for client response
        let clientErrorMessage = "Internal server error";
        if (error.message) {
            clientErrorMessage += `: ${error.message.substring(0, 100)}`; // Limit error message length
        }
        res.status(500).json({ success: false, message: clientErrorMessage, error: error.message, parentTaskId: parentTaskId });
    }
});

// API endpoint to list available "agents" (which are actually AI services for the Orchestrator)
app.get('/api/agent-instances', (req, res) => {
    // This list should ideally be dynamically generated or from a config
    // For now, it reflects the available AI services for the OrchestratorAgent
    const availableAgents = [
        { id: 'openai', name: 'OpenAI Powered Agent' , description: 'Uses OpenAI models for orchestration.'},
        { id: 'gemini', name: 'Gemini Powered Agent', description: 'Uses Gemini models for orchestration.' }
    ];
    res.json(availableAgents);
});

// Простое сообщение о состоянии для корневого пути
app.get('/', (req, res) => {
    res.json({ status: 'Backend server is running', timestamp: new Date().toISOString() });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log("Ensure you have .env file with GEMINI_API_KEY, OPENAI_API_KEY, SEARCH_API_KEY, CSE_ID, and optionally CONTEXT7_SERVER_URL.");
    console.log("Available agents: Orchestrator, Research, Utility.");
    console.log("ResearchAgent tools: WebSearchTool, ReadWebpageTool, Context7DocumentationTool.");
    console.log("UtilityAgent tools: CalculatorTool.");
    console.log("API endpoint for tasks: POST /api/generate-plan with modes: EXECUTE_FULL_PLAN, SYNTHESIZE_ONLY, PLAN_ONLY, EXECUTE_PLANNED_TASK.");
});
