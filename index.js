require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');
const EventEmitter = require('events');

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

const { initializeLocalization, t } = require('./utils/localization');

initializeLocalization();

// --- GLOBAL INSTANCES ---
const globalEventEmitter = new EventEmitter();
const subTaskQueue = new SubTaskQueue();
const resultsQueue = new ResultsQueue();
const savedTasksBaseDir = path.join(process.cwd(), 'tasks');
const memoryManager = new MemoryManager(globalEventEmitter);

const agentApiKeysConfig = {
    googleSearch: { apiKey: process.env.SEARCH_API_KEY, cseId: process.env.CSE_ID }
};

const webSearchTool = new WebSearchTool(agentApiKeysConfig.googleSearch);
const readWebpageTool = new ReadWebpageTool();
const calculatorTool = new CalculatorTool();
const context7ClientInstance = new Context7Client(process.env.CONTEXT7_SERVER_URL || 'http://localhost:8080/mcp');
const context7DocumentationTool = new Context7DocumentationTool(context7ClientInstance);

const openAIService = new OpenAIService(process.env.OPENAI_API_KEY, {
    defaultModel: 'gpt-4o', planningModel: 'gpt-4-turbo',
    cwcUpdateModel: 'gpt-4o', synthesisModel: 'gpt-4-turbo',
    summarizationModel: 'gpt-3.5-turbo'
});
const geminiService = new GeminiService(process.env.GEMINI_API_KEY, {
    defaultModel: 'gemini-1.5-flash-latest', planningModel: 'gemini-1.5-pro-latest',
    cwcUpdateModel: 'gemini-1.5-flash-latest', synthesisModel: 'gemini-1.5-pro-latest'
});

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

// --- HTTP SERVER CREATION ---
const server = http.createServer(app);

// --- API ROUTES ---
const getTaskDirectoryPath = (taskId) => {
    const today = new Date().toISOString().split('T')[0];
    // TODO: This is a simplified assumption for tasks created "today".
    // Robustly resolve task path if tasks can span multiple days or have different structures.
    return path.join(savedTasksBaseDir, today, taskId.startsWith('task_') ? taskId : \`task_\${taskId}\`);
};

app.post('/api/generate-plan', upload.array('files'), async (req, res) => {
    // ... (generate-plan route handler - no changes)
    const { task, taskIdToLoad, mode, aiService: requestedService, agentId } = req.body;
    const uploadedFileObjects = (req.files || []).map(file => ({ name: file.originalname, content: file.buffer.toString() }));
    const effectiveMode = mode || "EXECUTE_FULL_PLAN";
    if ((effectiveMode === "EXECUTE_FULL_PLAN" || effectiveMode === "PLAN_ONLY") && (!task || typeof task !== 'string' || task.trim() === "")) { return res.status(400).json({ success: false, message: \`'task' is required for \${effectiveMode} mode.\` }); }
    if ((effectiveMode === "SYNTHESIZE_ONLY" || effectiveMode === "EXECUTE_PLANNED_TASK") && (!taskIdToLoad || typeof taskIdToLoad !== 'string' || taskIdToLoad.trim() === "")) { return res.status(400).json({ success: false, message: \`'taskIdToLoad' is required for \${effectiveMode} mode.\` }); }
    if (!["EXECUTE_FULL_PLAN", "PLAN_ONLY", "SYNTHESIZE_ONLY", "EXECUTE_PLANNED_TASK"].includes(effectiveMode)) { return res.status(400).json({ success: false, message: \`Unknown mode '\${effectiveMode}'.\` }); }
    const parentTaskId = uuidv4();
    try {
        console.log(\`[API /api/generate-plan] Mode: \${effectiveMode}, TaskIdToLoad: \${taskIdToLoad || 'N/A'}, AgentId: \${agentId || 'default'}, ParentTaskId: \${parentTaskId}\`);
        let activeAIService;
        const serviceIdentifier = agentId || requestedService;
        if (serviceIdentifier?.toLowerCase() === 'gemini') activeAIService = geminiService;
        else activeAIService = openAIService;
        console.log(\`Request \${parentTaskId}: Using AI Service: \${activeAIService.getServiceName()} for orchestrator.\`);
        const orchestratorAgent = new OrchestratorAgent( activeAIService, subTaskQueue, memoryManager, null, agentApiKeysConfig, resultsQueue, savedTasksBaseDir );
        const result = await orchestratorAgent.handleUserTask(task, uploadedFileObjects, parentTaskId, taskIdToLoad, effectiveMode);
        res.json(result);
    } catch (error) {
        console.error(\`Error in /api/generate-plan (parentTaskId: \${parentTaskId}):\`, error.stack);
        res.status(500).json({ success: false, message: \`Internal server error: \${error.message.substring(0,100)}\`, parentTaskId });
    }
});

app.get('/api/agent-instances', (req, res) => {
    const availableAgents = [ { id: 'openai', name: 'OpenAI (GPT Series)', description: 'Uses OpenAI models for orchestration.'}, { id: 'gemini', name: 'Gemini (1.5 Series)', description: 'Uses Gemini models for orchestration.' }, ];
    res.json(availableAgents);
});

// --- CHAT API ENDPOINTS ---
app.post('/api/tasks/:taskId/chat', async (req, res) => {
    const { taskId: rawTaskId } = req.params;
    const { messageContent, clientMessageId, senderId, relatedToMessageId } = req.body;
    if (!messageContent || !messageContent.text || typeof messageContent.text !== 'string' || messageContent.text.trim() === '') { return res.status(400).json({ error: 'Message content and non-empty text are required.' }); }
    if (!senderId) { return res.status(400).json({ error: 'senderId is required.' }); }
    let taskDirPath;
    try { taskDirPath = getTaskDirectoryPath(rawTaskId); await memoryManager.initializeTaskMemory(taskDirPath); }
    catch (pathError) { return res.status(404).json({ error: 'Task not found or path could not be determined.' }); }
    try {
        const messageDataToSave = { taskId: rawTaskId, senderId, content: messageContent, clientMessageId, relatedToMessageId };
        const savedMessage = await memoryManager.addChatMessage(taskDirPath, messageDataToSave);
        console.log(\`[CHAT API] Message saved for task \${rawTaskId} with server ID \${savedMessage.id}. Event emitted.\`);
        res.status(202).json({ status: 'accepted', serverMessageId: savedMessage.id, clientMessageId: savedMessage.clientMessageId, taskId: savedMessage.taskId, timestamp: savedMessage.timestamp, sender: savedMessage.sender, content: savedMessage.content });
    } catch (error) { res.status(500).json({ error: 'Failed to save or process chat message.' }); }
});

app.get('/api/tasks/:taskId/chat', async (req, res) => {
    const { taskId: rawTaskId } = req.params;
    const { since_timestamp, limit = "20", sort_order = 'asc' } = req.query;
    // Timeout parameter is no longer used for long polling here.

    console.log(\`[CHAT API] Received GET on /api/tasks/\${rawTaskId}/chat. Query: \`, { since_timestamp, limit, sort_order });

    let taskDirPath;
    try {
        taskDirPath = getTaskDirectoryPath(rawTaskId);
    } catch (pathError) {
        console.error(\`[CHAT API] Error resolving taskDirPath for \${rawTaskId}: \${pathError.message}\`);
        return res.status(404).json({ error: 'Task not found or path could not be determined for chat history.' });
    }

    try {
        const messages = await memoryManager.getChatHistory(taskDirPath, {
            since_timestamp,
            limit: parseInt(limit, 10),
            sort_order
        });

        // Determine the lastTimestamp based on the actual messages returned and sort order
        let lastTimestampInResponse;
        if (messages.length > 0) {
            lastTimestampInResponse = (sort_order === 'asc')
                ? messages[messages.length - 1].timestamp
                : messages[0].timestamp;
        } else {
            lastTimestampInResponse = since_timestamp || new Date(0).toISOString();
        }

        res.status(200).json({
            taskId: rawTaskId,
            messages: messages,
            lastTimestamp: lastTimestampInResponse
        });
    } catch (error) {
        console.error(\`[CHAT API] Error fetching chat history for task \${rawTaskId}: \${error.stack}\`);
        res.status(500).json({ error: 'Failed to fetch chat history.' });
    }
});

// --- Root Route ---
app.get('/', (req, res) => {
    res.json({ status: 'Backend server is running', timestamp: new Date().toISOString() });
});

// --- WEBSOCKET SERVER SETUP ---
const CHAT_WEBSOCKET_PATH = '/api/chat_ws';
const wss = new WebSocketServer({ server, path: CHAT_WEBSOCKET_PATH });
const activeTaskSockets = new Map();

console.log(\`WebSocket server is listening on path \${CHAT_WEBSOCKET_PATH}\`);

globalEventEmitter.on('newMessage', (savedMessage) => {
    const taskId = savedMessage.taskId;
    if (taskId && activeTaskSockets.has(taskId)) {
        const clients = activeTaskSockets.get(taskId);
        const messageString = JSON.stringify(savedMessage);
        clients.forEach(clientWs => {
            if (clientWs.readyState === WebSocket.OPEN) {
                try { clientWs.send(messageString); }
                catch (sendError) { console.error(\`[WebSocket] Error sending to client for task \${taskId}:\`, sendError); }
            }
        });
        console.log(\`[WebSocket] Broadcasted message ID \${savedMessage.id} to \${clients.size} clients for task \${taskId}\`);
    }
});

wss.on('connection', (ws, req) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const requestUrl = url.parse(req.url, true);
    const taskId = requestUrl.query.taskId;

    if (!taskId || typeof taskId !== 'string' || taskId.trim() === '') {
        console.log(\`[WebSocket] Connection from \${clientIp} without valid taskId. Path: \${req.url}. Closing.\`);
        ws.terminate(); return;
    }
    console.log(\`[WebSocket] Client \${clientIp} connected for taskId: \${taskId}\`);

    if (!activeTaskSockets.has(taskId)) activeTaskSockets.set(taskId, new Set());
    activeTaskSockets.get(taskId).add(ws);
    console.log(\`[WebSocket] Added client \${clientIp} to task \${taskId}. Total for task: \${activeTaskSockets.get(taskId).size}\`);

    ws.on('message', async (messageBuffer) => {
        const messageString = messageBuffer.toString();
        let parsedMessage;
        try { parsedMessage = JSON.parse(messageString); }
        catch (e) {
            console.error(\`[WebSocket] Error parsing JSON from \${clientIp} (Task: \${taskId}):\`, e);
            ws.send(JSON.stringify({ type: 'error', content: { text: 'Invalid JSON.' }, senderId: 'system', ts: new Date().toISOString() }));
            return;
        }
        console.log(\`[WebSocket] Parsed message from \${clientIp} (Task: \${taskId}):\`, parsedMessage);

        if (!parsedMessage.messageContent || typeof parsedMessage.messageContent.text !== 'string' || !parsedMessage.senderId || !parsedMessage.messageContent.type) {
            console.error(\`[WebSocket] Invalid message structure from \${clientIp} (Task: \${taskId}):\`, parsedMessage);
            ws.send(JSON.stringify({ type: 'error', content: { text: 'Invalid structure. Needs: senderId, messageContent.type, messageContent.text.' }, senderId: 'system', ts: new Date().toISOString() }));
            return;
        }
        let taskDirPath;
        try { taskDirPath = getTaskDirectoryPath(taskId); await memoryManager.initializeTaskMemory(taskDirPath); }
        catch (pathError) {
            console.error(\`[WebSocket] Error resolving taskDirPath for \${taskId} from \${clientIp}: \${pathError.message}\`);
            ws.send(JSON.stringify({ type: 'error', content: { text: 'Server error: Task context issue.' }, senderId: 'system', ts: new Date().toISOString() }));
            return;
        }
        const messageDataToSave = { taskId, senderId: parsedMessage.senderId, content: parsedMessage.messageContent, clientMessageId: parsedMessage.clientMessageId, relatedToMessageId: parsedMessage.relatedToMessageId };
        try {
            await memoryManager.addChatMessage(taskDirPath, messageDataToSave);
            console.log(\`[WebSocket] Message from \${clientIp} (Task: \${taskId}) processed and event emitted.\`);
            if (parsedMessage.senderId !== 'agent' && parsedMessage.messageContent.type === 'text') {
                 console.log(\`[WebSocket] TODO: Trigger OrchestratorAgent for taskId: \${taskId} with new message: "\${parsedMessage.messageContent.text}"\`);
            }
        } catch (error) {
            console.error(\`[WebSocket] Error during message persistence for \${clientIp} (Task: \${taskId}):\`, error);
            ws.send(JSON.stringify({ type: 'error', content: { text: 'Error processing message server-side.' }, senderId: 'system', ts: new Date().toISOString() }));
        }
    });

    ws.on('close', () => {
        if (activeTaskSockets.has(taskId)) {
            activeTaskSockets.get(taskId).delete(ws);
            console.log(\`[WebSocket] Removed client \${clientIp} from task \${taskId}. Remaining clients: \${activeTaskSockets.get(taskId).size}\`);
            if (activeTaskSockets.get(taskId).size === 0) {
                activeTaskSockets.delete(taskId);
                console.log(\`[WebSocket] No more clients for task \${taskId}, removed task from active sockets.\`);
            }
        }
        console.log(\`[WebSocket] Client \${clientIp} (Task: \${taskId}) disconnected\`);
    });
    ws.on('error', (error) => {
        console.error(\`[WebSocket] Error on connection with \${clientIp} (Task: \${taskId}):\`, error);
        if (activeTaskSockets.has(taskId)) {
            activeTaskSockets.get(taskId).delete(ws);
             if (activeTaskSockets.get(taskId).size === 0) {
                activeTaskSockets.delete(taskId);
            }
        }
    });

    try { ws.send(JSON.stringify({ type: 'system', message: \`Successfully connected to WebSocket for taskId \${taskId}.\` })); }
    catch (error) { console.error(\`[WebSocket] Failed to send welcome message to \${clientIp} (Task: \${taskId}):\`, error); }
});

// --- START SERVER ---
server.listen(PORT, () => {
    console.log(\`HTTP and WebSocket Server running on http://localhost:\${PORT}\`);
    console.log(\`WebSocket endpoint for chat: ws://localhost:\${PORT}\${CHAT_WEBSOCKET_PATH}?taskId=YOUR_TASK_ID\`);
});
