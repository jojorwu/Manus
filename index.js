require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');

// Core Components
const OrchestratorAgent = require('./agents/OrchestratorAgent');
const ResearchAgent = require('./agents/ResearchAgent');
const UtilityAgent = require('./agents/UtilityAgent');
const SubTaskQueue = require('./core/SubTaskQueue');
const ResultsQueue = require('./core/ResultsQueue');
const MemoryManager = require('./core/MemoryManager');

// Tools
const WebSearchTool = require('./tools/WebSearchTool');
const ReadWebpageTool = require('./tools/ReadWebpageTool');
const CalculatorTool = require('./tools/CalculatorTool');
const Context7Client = require('./services/Context7Client');
const Context7DocumentationTool = require('./tools/Context7DocumentationTool');

// AI Services
const GeminiService = require('./services/ai/GeminiService');
const OpenAIService = require('./services/ai/OpenAIService');
// const AnthropicAPIService = require('./services/ai/AnthropicAPIService'); // Example if added

const { initializeLocalization, t } = require('./utils/localization');

initializeLocalization();

// --- GLOBAL INSTANCES ---
const subTaskQueue = new SubTaskQueue();
const resultsQueue = new ResultsQueue();
const savedTasksBaseDir = path.join(process.cwd(), 'tasks'); // Define base path for all task-related data
const memoryManager = new MemoryManager(); // Instantiate MemoryManager (constructor doesn't take baseDir anymore)

const agentApiKeysConfig = {
    googleSearch: { apiKey: process.env.SEARCH_API_KEY, cseId: process.env.CSE_ID }
};

// Initialize Tools
const webSearchTool = new WebSearchTool(agentApiKeysConfig.googleSearch);
const readWebpageTool = new ReadWebpageTool();
const calculatorTool = new CalculatorTool();
const context7ClientInstance = new Context7Client(process.env.CONTEXT7_SERVER_URL || 'http://localhost:8080/mcp');
const context7DocumentationTool = new Context7DocumentationTool(context7ClientInstance);

// Initialize AI Services (examples)
const openAIService = new OpenAIService(process.env.OPENAI_API_KEY, {
    defaultModel: 'gpt-4o', planningModel: 'gpt-4-turbo',
    cwcUpdateModel: 'gpt-4o', synthesisModel: 'gpt-4-turbo',
    summarizationModel: 'gpt-3.5-turbo' // Cheaper for summarization
});
const geminiService = new GeminiService(process.env.GEMINI_API_KEY, {
    defaultModel: 'gemini-1.5-flash-latest', planningModel: 'gemini-1.5-pro-latest',
    cwcUpdateModel: 'gemini-1.5-flash-latest', synthesisModel: 'gemini-1.5-pro-latest'
});
// const anthropicService = new AnthropicAPIService(process.env.ANTHROPIC_API_KEY, { /* ... */ });

// Initialize Worker Agents
const researchAgentTools = { "WebSearchTool": webSearchTool, "ReadWebpageTool": readWebpageTool, "Context7DocumentationTool": context7DocumentationTool };
const researchAgent = new ResearchAgent(subTaskQueue, resultsQueue, researchAgentTools, agentApiKeysConfig);
const utilityAgentTools = { "CalculatorTool": calculatorTool };
const utilityAgent = new UtilityAgent(subTaskQueue, resultsQueue, utilityAgentTools, agentApiKeysConfig);
researchAgent.startListening();
utilityAgent.startListening();

// --- EXPRESS APP SETUP ---
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- API ROUTES ---

// Helper to construct task directory path
// TODO: This is a simplified assumption. In a real system, task creation date might not be "today".
// Task metadata (including full path or creation date) should be stored and retrieved.
const getTaskDirectoryPath = (taskId) => {
    const today = new Date().toISOString().split('T')[0];
    // Assuming taskId from URL is just the unique ID part (e.g., timestamp or UUID)
    // And OrchestratorAgent creates tasks under dated folders.
    return path.join(savedTasksBaseDir, today, taskId.startsWith('task_') ? taskId : \`task_\${taskId}\`);
};


app.post('/api/generate-plan', upload.array('files'), async (req, res) => {
    const { task, taskIdToLoad, mode, aiService: requestedService, agentId } = req.body;
    const uploadedFileObjects = (req.files || []).map(file => ({ name: file.originalname, content: file.buffer.toString() }));
    const effectiveMode = mode || "EXECUTE_FULL_PLAN";

    if ((effectiveMode === "EXECUTE_FULL_PLAN" || effectiveMode === "PLAN_ONLY") && (!task || typeof task !== 'string' || task.trim() === "")) {
        return res.status(400).json({ success: false, message: \`'task' is required for \${effectiveMode} mode.\` });
    }
    if ((effectiveMode === "SYNTHESIZE_ONLY" || effectiveMode === "EXECUTE_PLANNED_TASK") && (!taskIdToLoad || typeof taskIdToLoad !== 'string' || taskIdToLoad.trim() === "")) {
        return res.status(400).json({ success: false, message: \`'taskIdToLoad' is required for \${effectiveMode} mode.\` });
    }
    if (!["EXECUTE_FULL_PLAN", "PLAN_ONLY", "SYNTHESIZE_ONLY", "EXECUTE_PLANNED_TASK"].includes(effectiveMode)) {
        return res.status(400).json({ success: false, message: \`Unknown mode '\${effectiveMode}'.\` });
    }

    const parentTaskId = uuidv4(); // This is more like a session ID for this specific request

    try {
        console.log(\`[API /api/generate-plan] Mode: \${effectiveMode}, TaskIdToLoad: \${taskIdToLoad || 'N/A'}, AgentId: \${agentId || 'default'}, ParentTaskId: \${parentTaskId}\`);

        let activeAIService;
        const serviceIdentifier = agentId || requestedService;
        if (serviceIdentifier?.toLowerCase() === 'gemini') activeAIService = geminiService;
        // else if (serviceIdentifier?.toLowerCase() === 'anthropic') activeAIService = anthropicService;
        else activeAIService = openAIService; // Default

        console.log(\`Request \${parentTaskId}: Using AI Service: \${activeAIService.getServiceName()} for orchestrator.\`);

        // Note: MemoryManager instance is already created globally.
        // OrchestratorAgent constructor does not take baseDir for MemoryManager.
        const orchestratorAgent = new OrchestratorAgent(
            activeAIService, subTaskQueue, memoryManager, /* memoryManager instance */
            null, agentApiKeysConfig, resultsQueue, savedTasksBaseDir
        );

        const result = await orchestratorAgent.handleUserTask(task, uploadedFileObjects, parentTaskId, taskIdToLoad, effectiveMode);
        res.json(result);
    } catch (error) {
        console.error(\`Error in /api/generate-plan (parentTaskId: \${parentTaskId}):\`, error.stack);
        res.status(500).json({ success: false, message: \`Internal server error: \${error.message.substring(0,100)}\`, parentTaskId });
    }
});

app.get('/api/agent-instances', (req, res) => {
    const availableAgents = [
        { id: 'openai', name: 'OpenAI (GPT Series)', description: 'Uses OpenAI models for orchestration.'},
        { id: 'gemini', name: 'Gemini (1.5 Series)', description: 'Uses Gemini models for orchestration.' },
        // { id: 'anthropic', name: 'Anthropic (Claude 3)', description: 'Uses Anthropic models for orchestration.'}
    ];
    res.json(availableAgents);
});

// --- CHAT API ENDPOINTS ---

app.post('/api/tasks/:taskId/chat', async (req, res) => {
    const { taskId: rawTaskId } = req.params; // e.g., just the timestamp part
    const { messageContent, clientMessageId, senderId, relatedToMessageId } = req.body;

    console.log(\`[CHAT API] Received POST on /api/tasks/\${rawTaskId}/chat\`);

    if (!messageContent || !messageContent.text || typeof messageContent.text !== 'string' || messageContent.text.trim() === '') {
        return res.status(400).json({ error: 'Message content and non-empty text are required.' });
    }
    if (!senderId) {
        return res.status(400).json({ error: 'senderId is required.' });
    }

    let taskDirPath;
    try {
        // TODO: Implement a robust way to find the full taskDirPath (including date folder) for the given rawTaskId.
        // This might involve querying a metadata store or scanning directories if tasks are short-lived.
        // For this stub, we'll use the helper that assumes "today" for the date folder.
        // This is a SIGNIFICANT LIMITATION for tasks not created on the current day.
        taskDirPath = getTaskDirectoryPath(rawTaskId);
        await memoryManager.initializeTaskMemory(taskDirPath); // Ensure chat file is ready
    } catch (pathError) {
        console.error(\`[CHAT API] Error resolving taskDirPath for \${rawTaskId}: \${pathError.message}\`);
        return res.status(404).json({ error: 'Task not found or path could not be determined.' });
    }

    try {
        const messageDataToSave = {
            taskId: rawTaskId, // Store the raw task ID
            senderId: senderId,
            content: messageContent, // { type: 'text', text: '...' }
            clientMessageId: clientMessageId,
            relatedToMessageId: relatedToMessageId
            // role will be inferred by addChatMessage or can be passed if available
        };

        const savedMessage = await memoryManager.addChatMessage(taskDirPath, messageDataToSave);

        console.log(\`[CHAT API] Message saved for task \${rawTaskId} with server ID \${savedMessage.id}\`);

        // TODO: If senderId is not 'agent', potentially trigger OrchestratorAgent or a ChatAgent
        // to process the user's message and generate a response. This might involve:
        // 1. Loading taskState for rawTaskId.
        // 2. Calling a method on OrchestratorAgent like agent.handleChatMessage(taskState, savedMessage).
        // 3. That method would then use an LLM to generate a reply and save it via memoryManager.addChatMessage.
        // This POST endpoint would then typically wait for the agent's immediate ack or first response part if streaming.
        // For now, we just accept the message.

        res.status(202).json({
            status: 'accepted',
            serverMessageId: savedMessage.id,
            clientMessageId: savedMessage.clientMessageId,
            taskId: savedMessage.taskId,
            timestamp: savedMessage.timestamp,
            sender: savedMessage.sender,
            content: savedMessage.content
        });
    } catch (error) {
        console.error(\`[CHAT API] Error processing message for task \${rawTaskId}: \${error.stack}\`);
        res.status(500).json({ error: 'Failed to save or process chat message.' });
    }
});

app.get('/api/tasks/:taskId/chat', async (req, res) => {
    const { taskId: rawTaskId } = req.params;
    const { since_timestamp, limit = "20", sort_order = 'asc' } = req.query;
    const timeout = parseInt(req.query.timeout, 10) || 0; // Default to 0 (no long polling)

    console.log(\`[CHAT API] Received GET on /api/tasks/\${rawTaskId}/chat. Query: \`, req.query);

    let taskDirPath;
    try {
        // TODO: Same robust path resolution needed as in POST.
        taskDirPath = getTaskDirectoryPath(rawTaskId);
    } catch (pathError) {
        console.error(\`[CHAT API] Error resolving taskDirPath for \${rawTaskId}: \${pathError.message}\`);
        return res.status(404).json({ error: 'Task not found or path could not be determined for chat history.' });
    }

    const fetchMessages = async () => {
        return await memoryManager.getChatHistory(taskDirPath, {
            since_timestamp,
            limit: parseInt(limit, 10),
            sort_order
        });
    };

    try {
        let messages = await fetchMessages();

        if (timeout > 0 && messages.length === 0 && since_timestamp) {
            const startTime = Date.now();
            const pollingInterval = 1000; // Check every 1 second
            const endTime = startTime + timeout;

            while (Date.now() < endTime) {
                await new Promise(resolve => setTimeout(resolve, pollingInterval));
                messages = await fetchMessages();
                if (messages.length > 0) {
                    console.log(\`[CHAT API] Long poll for \${rawTaskId}: Found new messages.\`);
                    break;
                }
                if (Date.now() >= endTime) {
                    console.log(\`[CHAT API] Long poll for \${rawTaskId}: Timeout reached.\`);
                    break;
                }
            }
        }

        const lastTimestamp = messages.length > 0 ? messages[messages.length - 1].timestamp : new Date().toISOString();
        if (sort_order === 'desc' && messages.length > 0) {
             // If descending, the first message is the latest for lastTimestamp logic
             // However, getChatHistory already sorts. If asc, last is latest. If desc, first is latest.
             // For simplicity, if sorted desc, the "last" in time is messages[0].
             // This needs to be consistent with how client uses lastTimestamp.
             // Client usually wants the timestamp of the newest message in the returned batch.
        }


        res.status(200).json({
            taskId: rawTaskId,
            messages: messages,
            lastTimestamp: messages.length > 0
                ? (sort_order === 'asc' ? messages[messages.length - 1].timestamp : messages[0].timestamp)
                : since_timestamp || new Date(0).toISOString() // If no messages, return original since_timestamp or epoch
        });
    } catch (error) {
        console.error(\`[CHAT API] Error fetching chat history for task \${rawTaskId}: \${error.stack}\`);
        res.status(500).json({ error: 'Failed to fetch chat history.' });
    }
});


// --- Root and Server Listen ---
app.get('/', (req, res) => {
    res.json({ status: 'Backend server is running', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(\`Server is running on http://localhost:\${PORT}\`);
    console.log("Available AI services for Orchestrator: OpenAI, Gemini. (Anthropic can be enabled).");
    console.log("API endpoint for tasks: POST /api/generate-plan");
    console.log("API endpoints for chat: POST /api/tasks/:taskId/chat, GET /api/tasks/:taskId/chat");
});
