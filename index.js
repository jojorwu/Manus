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
    } else {
        return res.status(400).json({ success: false, message: `Invalid request: Unknown mode '${effectiveMode}'.` });
    }

    const parentTaskId = uuidv4(); // Генерируем уникальный ID для этой сессии обработки

    try {
        // Логируем полученные параметры (кроме всего тела запроса, чтобы не дублировать)
        console.log(`Received API request for mode: ${effectiveMode}, task (if any): "${task ? task.substring(0, 50) + '...' : 'N/A'}", taskIdToLoad (if any): ${taskIdToLoad}, generated parentTaskId: ${parentTaskId}`);

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
    console.log("API endpoint for tasks: POST /api/generate-plan with modes: EXECUTE_FULL_PLAN, SYNTHESIZE_ONLY.");
});
