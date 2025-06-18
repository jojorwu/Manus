// routes/apiRoutes.js
const express = require('express');
const { v4: uuidv4 } = require('uuid'); // uuidv4 is used in /generate-plan

// Note: multer instance ('upload') and getTaskDirectoryPath are passed via dependencies

function initializeApiRoutes(dependencies) {
    const router = express.Router();
    const {
        OrchestratorAgent, // Class
        geminiService, openAIService, // AI Service instances
        subTaskQueue, memoryManager, resultsQueue,
        savedTasksBaseDir, agentApiKeysConfig, // Configs and shared instances
        upload, // multer instance
        getTaskDirectoryPath // Helper function
    } = dependencies;

    // Route: POST /generate-plan
    router.post('/generate-plan', upload.array('files'), async (req, res) => {
        const { task, taskIdToLoad, mode, aiService: requestedService, agentId } = req.body;
        const uploadedFileObjects = (req.files || []).map(file => ({
            name: file.originalname,
            content: file.buffer.toString()
        }));
        const effectiveMode = mode || "EXECUTE_FULL_PLAN";

        // Validation logic (ensure this is comprehensive as needed)
        if ((effectiveMode === "EXECUTE_FULL_PLAN" || effectiveMode === "PLAN_ONLY") && (!task || typeof task !== 'string' || task.trim() === "")) {
            return res.status(400).json({ success: false, message: \`'task' is required for \${effectiveMode} mode.\` });
        }
        if ((effectiveMode === "SYNTHESIZE_ONLY" || effectiveMode === "EXECUTE_PLANNED_TASK") && (!taskIdToLoad || typeof taskIdToLoad !== 'string' || taskIdToLoad.trim() === "")) {
            return res.status(400).json({ success: false, message: \`'taskIdToLoad' is required for \${effectiveMode} mode.\` });
        }
        if (!["EXECUTE_FULL_PLAN", "PLAN_ONLY", "SYNTHESIZE_ONLY", "EXECUTE_PLANNED_TASK"].includes(effectiveMode)) {
            return res.status(400).json({ success: false, message: \`Unknown mode '\${effectiveMode}'.\` });
        }

        const parentTaskId = uuidv4(); // For tracking this specific request session

        try {
            console.log(\`[API /generate-plan] Mode: \${effectiveMode}, TaskIdToLoad: \${taskIdToLoad || 'N/A'}, AgentId: \${agentId || 'default'}, ParentTaskId: \${parentTaskId}\`);

            let activeAIService;
            const serviceIdentifier = agentId || requestedService;
            if (serviceIdentifier?.toLowerCase() === 'gemini') {
                activeAIService = geminiService;
            } else { // Default to OpenAI
                activeAIService = openAIService;
            }
            console.log(\`Request \${parentTaskId}: Using AI Service: \${activeAIService.getServiceName()} for orchestrator.\`);

            // OrchestratorAgent expects memoryManager and savedTasksBaseDir to be passed
            const orchestratorAgent = new OrchestratorAgent(
                activeAIService,
                subTaskQueue,
                memoryManager, // Passed from dependencies
                null, // reportGenerator - can be null if not used
                agentApiKeysConfig,
                resultsQueue,
                savedTasksBaseDir // Passed from dependencies
            );

            const result = await orchestratorAgent.handleUserTask(task, uploadedFileObjects, parentTaskId, taskIdToLoad, effectiveMode);
            res.json(result);
        } catch (error) {
            console.error(\`Error in /api/generate-plan (parentTaskId: \${parentTaskId}):\`, error.stack);
            res.status(500).json({ success: false, message: \`Internal server error: \${error.message.substring(0,100)}\`, parentTaskId });
        }
    });

    // Route: GET /agent-instances
    router.get('/agent-instances', (req, res) => {
        const availableAgents = [
            { id: 'openai', name: 'OpenAI (GPT Series)', description: 'Uses OpenAI models for orchestration.'},
            { id: 'gemini', name: 'Gemini (1.5 Series)', description: 'Uses Gemini models for orchestration.' },
            // { id: 'anthropic', name: 'Anthropic (Claude 3)', description: 'Uses Anthropic models for orchestration.'} // Example
        ];
        res.json(availableAgents);
    });

    // Route: POST /tasks/:taskId/chat
    router.post('/tasks/:taskId/chat', async (req, res) => {
        const { taskId: rawTaskId } = req.params;
        const { messageContent, clientMessageId, senderId, relatedToMessageId } = req.body;

        if (!messageContent || !messageContent.text || typeof messageContent.text !== 'string' || messageContent.text.trim() === '') {
            return res.status(400).json({ error: 'Message content and non-empty text are required.' });
        }
        if (!senderId) {
            return res.status(400).json({ error: 'senderId is required.' });
        }

        let taskDirPath;
        try {
            taskDirPath = getTaskDirectoryPath(rawTaskId); // Using helper from dependencies
            await memoryManager.initializeTaskMemory(taskDirPath);
        } catch (pathError) {
            console.error(\`[API /tasks/:taskId/chat POST] Error resolving taskDirPath for \${rawTaskId}: \${pathError.message}\`);
            return res.status(404).json({ error: 'Task not found or path could not be determined.' });
        }

        try {
            const messageDataToSave = {
                taskId: rawTaskId,
                senderId,
                content: messageContent,
                clientMessageId,
                relatedToMessageId
            };
            const savedMessage = await memoryManager.addChatMessage(taskDirPath, messageDataToSave);
            console.log(\`[API /tasks/:taskId/chat POST] Message saved for task \${rawTaskId} with server ID \${savedMessage.id}. Event emitted.\`);

            // The 'newMessage' event handled by WebSocket server in index.js will broadcast.
            // OrchestratorAgent processing for this message would be triggered by WebSocket handler in index.js.

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
            console.error(\`[API /tasks/:taskId/chat POST] Error processing message for task \${rawTaskId}: \${error.stack}\`);
            res.status(500).json({ error: 'Failed to save or process chat message.' });
        }
    });

    // Route: GET /tasks/:taskId/chat
    router.get('/tasks/:taskId/chat', async (req, res) => {
        const { taskId: rawTaskId } = req.params;
        const { since_timestamp, limit = "20", sort_order = 'asc' } = req.query;

        console.log(\`[API /tasks/:taskId/chat GET] Received GET for \${rawTaskId}. Query: \`, { since_timestamp, limit, sort_order });

        let taskDirPath;
        try {
            taskDirPath = getTaskDirectoryPath(rawTaskId); // Using helper from dependencies
        } catch (pathError) {
            console.error(\`[API /tasks/:taskId/chat GET] Error resolving taskDirPath for \${rawTaskId}: \${pathError.message}\`);
            return res.status(404).json({ error: 'Task not found or path could not be determined for chat history.' });
        }

        try {
            const messages = await memoryManager.getChatHistory(taskDirPath, {
                since_timestamp,
                limit: parseInt(limit, 10),
                sort_order
            });

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
            console.error(\`[API /tasks/:taskId/chat GET] Error fetching chat history for task \${rawTaskId}: \${error.stack}\`);
            res.status(500).json({ error: 'Failed to fetch chat history.' });
        }
    });

    return router;
}

module.exports = initializeApiRoutes;
