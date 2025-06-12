require('dotenv').config();
require('dotenv').config(); // Ensure this is at the very top
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const logger = require('./core/logger'); // Import the configured logger

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
const geminiLLMService = require('./services/LLMService');

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

// Инициализация агентов
const orchestratorAgent = new OrchestratorAgent(subTaskQueue, resultsQueue, geminiLLMService, agentApiKeysConfig);

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
    const { task, taskIdToLoad, mode } = req.body;

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
    } else {
        return res.status(400).json({ success: false, message: `Invalid request: Unknown mode '${effectiveMode}'.` });
    }

    const parentTaskId = uuidv4(); // Генерируем уникальный ID для этой сессии обработки

    try {
        logger.info(`Received API request for mode: ${effectiveMode}, generated parentTaskId: ${parentTaskId}`, {
            mode: effectiveMode,
            taskProvided: !!task,
            taskSnippet: task ? task.substring(0, 50) + '...' : 'N/A',
            taskIdToLoad,
            parentTaskId
        });

        // userTaskString для handleUserTask будет либо `task` из запроса, либо загружен из состояния внутри handleUserTask.
        // Передаем `task` как есть; OrchestratorAgent должен будет это учитывать.
        const result = await orchestratorAgent.handleUserTask(task, parentTaskId, taskIdToLoad, effectiveMode);

        // Log a summary of the result, not the whole object if it's large
        logger.info("Orchestrator processing completed.", { parentTaskId, success: result.success, finalAnswerPresent: !!result.finalAnswer });
        logger.debug("Full orchestrator result:", { parentTaskId, result });

        res.json(result);
    } catch (error) {
        logger.error(`Error in /api/generate-plan (parentTaskId: ${parentTaskId}).`, { parentTaskId, error: error.message, stack: error.stack, originalError: error });
        res.status(500).json({ success: false, message: "Internal server error", error: error.message, parentTaskId: parentTaskId });
    }
});

// Простое сообщение о состоянии для корневого пути
app.get('/', (req, res) => {
    res.json({ status: 'Backend server is running', timestamp: new Date().toISOString() });
});

// Запуск сервера
app.listen(PORT, () => {
    logger.info(`Server is running on http://localhost:${PORT}`);
    logger.info("Ensure you have a .env file with GEMINI_API_KEY, SEARCH_API_KEY, and CSE_ID (if using relevant tools).");
    logger.info("Available agents: Orchestrator, Research, Utility.");
    logger.info("ResearchAgent tools: WebSearchTool, ReadWebpageTool.");
    logger.info("UtilityAgent tools: CalculatorTool.");
    logger.info("API endpoint for tasks: POST /api/generate-plan with modes: EXECUTE_FULL_PLAN, SYNTHESIZE_ONLY, PLAN_ONLY.");
    logger.info(`Default log level: ${logger.level}. Set LOG_LEVEL environment variable to change.`);
});
