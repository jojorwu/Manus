require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');

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
    "ReadWebpageTool": readWebpageTool
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

app.use(express.json());

// API эндпоинт для задач
app.post('/api/generate-plan', async (req, res) => {
    const { task, taskIdToLoad, mode, aiService: requestedService } = req.body; // Added aiService

    // Определяем режим по умолчанию, если не указан
    const effectiveMode = mode || "EXECUTE_FULL_PLAN";

    if (effectiveMode === "EXECUTE_FULL_PLAN") {
        if (!task || typeof task !== 'string' || task.trim() === "") {
            return res.status(400).json({ success: false, message: "Invalid request: 'task' must be a non-empty string for EXECUTE_FULL_PLAN mode." });
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
        // Логируем полученные параметры (кроме всего тела запроса, чтобы не дублировать)
        console.log(`Received API request for mode: ${effectiveMode}, task (if any): "${task ? task.substring(0, 50) + '...' : 'N/A'}", taskIdToLoad (if any): ${taskIdToLoad}, requested AI Service: ${requestedService || 'default'}, generated parentTaskId: ${parentTaskId}`);

        // Выбор AI сервиса для текущего запроса
        let activeAIService;
        if (requestedService && typeof requestedService === 'string') {
            if (requestedService.toLowerCase() === 'gemini') {
                activeAIService = geminiService;
            } else if (requestedService.toLowerCase() === 'openai') {
                activeAIService = openAIService;
            } else {
                console.warn(`Invalid aiService '${requestedService}' requested. Falling back to default.`);
                activeAIService = openAIService; // Default
            }
        } else {
            activeAIService = openAIService; // Default if not specified
        }

        console.log(`Request ${parentTaskId}: Using AI Service: ${activeAIService.getServiceName()} for this task.`);

        // Инициализация OrchestratorAgent внутри обработчика с выбранным AI сервисом
        const orchestratorAgent = new OrchestratorAgent(subTaskQueue, resultsQueue, activeAIService, agentApiKeysConfig);
        // Если OrchestratorAgent требует FileSystemTool, он должен быть доступен здесь
        // Предполагая, что fileSystemTool глобально инициализирован и может быть передан, если OrchestratorAgent.js был изменен для его приема.
        // Если OrchestratorAgent сам инстанцирует FileSystemTool или он не нужен в конструкторе, этот вызов остается как есть.
        // На данный момент, OrchestratorAgent.js не принимает fileSystemTool в конструкторе, а устанавливает его как свойство.
        // Это можно сделать и здесь, если необходимо: orchestratorAgent.fileSystemTool = fileSystemTool; (fileSystemTool - глобальный)
        // Однако, для чистоты, лучше если OrchestratorAgent управляет своими зависимостями или они передаются в конструктор.
        // Для этого задания, предположим, что текущий конструктор OrchestratorAgent достаточен.


        // userTaskString для handleUserTask будет либо `task` из запроса, либо загружен из состояния внутри handleUserTask.
        // Передаем `task` как есть; OrchestratorAgent должен будет это учитывать.
        const result = await orchestratorAgent.handleUserTask(task, parentTaskId, taskIdToLoad, effectiveMode);
        console.log("Orchestrator result:", result); // Consider logging less for very large results
        res.json(result);
    } catch (error) {
        console.error(`Error in /api/generate-plan (parentTaskId: ${parentTaskId}):`, error);
        res.status(500).json({ success: false, message: "Internal server error", error: error.message, parentTaskId: parentTaskId });
    }
});

// Простое сообщение о состоянии для корневого пути
app.get('/', (req, res) => {
    res.json({ status: 'Backend server is running', timestamp: new Date().toISOString() });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log("Ensure you have a .env file with GEMINI_API_KEY, SEARCH_API_KEY, and CSE_ID.");
    console.log("Available agents: Orchestrator, Research, Utility.");
    console.log("ResearchAgent tools: WebSearchTool, ReadWebpageTool.");
    console.log("UtilityAgent tools: CalculatorTool.");
    console.log("API endpoint for tasks: POST /api/generate-plan with modes: EXECUTE_FULL_PLAN, SYNTHESIZE_ONLY, PLAN_ONLY, EXECUTE_PLANNED_TASK.");
});
