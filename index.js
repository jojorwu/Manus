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
    const { task } = req.body;
    if (!task || typeof task !== 'string') {
        return res.status(400).json({ success: false, message: "Invalid task: 'task' must be a non-empty string." });
    }

    const parentTaskId = uuidv4(); // Генерируем уникальный ID для этой задачи

    try {
        console.log(`Received task: "${task}", parentTaskId: ${parentTaskId}`);
        // Передаем задачу Оркестратору
        const result = await orchestratorAgent.handleUserTask(task, parentTaskId);
        console.log("Orchestrator result:", result);
        res.json(result);
    } catch (error) {
        console.error("Error in /api/generate-plan:", error);
        res.status(500).json({ success: false, message: "Internal server error", error: error.message });
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
    console.log("API endpoint for tasks: POST /api/generate-plan");
});
