// core/websocketHandler.js
import { WebSocketServer, WebSocket } from 'ws';
import url from 'url';

const CHAT_WEBSOCKET_PATH = '/api/chat_ws';
const activeTaskSockets = new Map(); // Key: taskId (string), Value: Set<WebSocket>

export default function initializeWebSocketHandler(
    httpServer,
    eventEmitter,
    memoryManager,
    getTaskDirectoryPath
    // TODO: Potentially pass OrchestratorAgent class or a factory function if direct agent interaction is needed here
) {

    const wss = new WebSocketServer({ server: httpServer, path: CHAT_WEBSOCKET_PATH });
    console.log(\`[WebSocket] Server initialized and listening on path \${CHAT_WEBSOCKET_PATH}\`);

    eventEmitter.on('newMessage', (savedMessage) => {
        const taskId = savedMessage.taskId; // Assumes savedMessage includes taskId from MemoryManager
        if (taskId && activeTaskSockets.has(taskId)) {
            const clients = activeTaskSockets.get(taskId);
            const messageString = JSON.stringify(savedMessage);
            clients.forEach(clientWs => {
                if (clientWs.readyState === WebSocket.OPEN) {
                    try {
                        clientWs.send(messageString);
                    } catch (sendError) {
                        console.error(\`[WebSocket] Error sending message to client for task \${taskId}:\`, sendError);
                        // Optionally handle client removal if send fails repeatedly
                    }
                }
            });
            // console.log(\`[WebSocket] Broadcasted message ID \${savedMessage.id} to \${clients.size} clients for task \${taskId}\`);
        }
    });

    wss.on('connection', (ws, req) => {
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        let taskId; // Defined here to be available in all event handlers for this ws connection

        try {
            const requestUrl = url.parse(req.url, true);
            taskId = requestUrl.query.taskId;

            if (!taskId || typeof taskId !== 'string' || taskId.trim() === '') {
                console.log(\`[WebSocket] Connection attempt from \${clientIp} without valid taskId. Path: \${req.url}. Closing.\`);
                ws.terminate();
                return;
            }
            console.log(\`[WebSocket] Client \${clientIp} connected for taskId: \${taskId}\`);

            if (!activeTaskSockets.has(taskId)) {
                activeTaskSockets.set(taskId, new Set());
            }
            activeTaskSockets.get(taskId).add(ws);
            console.log(\`[WebSocket] Added client \${clientIp} to task \${taskId}. Total for task: \${activeTaskSockets.get(taskId).size}\`);

            ws.send(JSON.stringify({ type: 'system', message: \`Successfully connected to WebSocket for taskId \${taskId}.\` }));

        } catch (error) {
            console.error(\`[WebSocket] Error during initial connection setup for \${clientIp}: \${error.stack}\`);
            ws.terminate(); // Terminate on setup error
            return;
        }

        ws.on('message', async (messageBuffer) => {
            const messageString = messageBuffer.toString();
            let parsedMessage;
            try {
                parsedMessage = JSON.parse(messageString);
            } catch (e) {
                console.error(\`[WebSocket] Error parsing JSON from \${clientIp} (Task: \${taskId}):\`, e);
                try { ws.send(JSON.stringify({ type: 'error', content: { text: 'Invalid JSON message format.' }, senderId: 'system', timestamp: new Date().toISOString() })); } catch (sendErr) { console.error("WS Send Error:", sendErr); }
                return;
            }

            console.log(\`[WebSocket] Received parsed message from \${clientIp} (Task: \${taskId}):\`, parsedMessage);

            if (!parsedMessage.messageContent || typeof parsedMessage.messageContent.text !== 'string' || !parsedMessage.senderId || !parsedMessage.messageContent.type) {
                console.error(\`[WebSocket] Invalid message structure from \${clientIp} (Task: \${taskId}):\`, parsedMessage);
                try { ws.send(JSON.stringify({ type: 'error', content: { text: 'Invalid message structure. Required: senderId, messageContent.type, messageContent.text.' }, senderId: 'system', timestamp: new Date().toISOString() })); } catch (sendErr) { console.error("WS Send Error:", sendErr); }
                return;
            }

            let taskDirPath;
            try {
                taskDirPath = getTaskDirectoryPath(taskId); // Use the raw taskId from connection
                await memoryManager.initializeTaskMemory(taskDirPath);
            } catch (pathError) {
                console.error(\`[WebSocket] Error resolving taskDirPath for \${taskId} from \${clientIp}: \${pathError.message}\`);
                try { ws.send(JSON.stringify({ type: 'error', content: { text: 'Server error: Could not identify task context.' }, senderId: 'system', timestamp: new Date().toISOString() })); } catch (sendErr) { console.error("WS Send Error:", sendErr); }
                return;
            }

            const messageDataToSave = {
                taskId: taskId,
                senderId: parsedMessage.senderId,
                content: parsedMessage.messageContent,
                clientMessageId: parsedMessage.clientMessageId,
                relatedToMessageId: parsedMessage.relatedToMessageId
            };

            try {
                // memoryManager.addChatMessage will emit 'newMessage', which is handled by the listener above for broadcasting
                const savedMsg = await memoryManager.addChatMessage(taskDirPath, messageDataToSave);
                console.log(\`[WebSocket] Message from \${clientIp} (Task: \${taskId}) saved (ID: \${savedMsg.id}), event emitted for broadcast.\`);

                if (parsedMessage.senderId !== 'agent' && parsedMessage.messageContent.type === 'text') {
                     console.log(\`[WebSocketHandler] TODO: Trigger OrchestratorAgent for taskId: \${taskId} with new message: "\${parsedMessage.messageContent.text}" (clientMessageId: \${parsedMessage.clientMessageId})\`);
                    // This is where OrchestratorAgent would be invoked.
                    // Example:
                    // const orchestrator = new OrchestratorAgent(...dependenciesForAgent...);
                    // await orchestrator.handleUserTask(parsedMessage.messageContent.text, [], null, taskId, 'CONTINUE_CHAT');
                    // The result of this (agent's response messages) would then also be saved via memoryManager.addChatMessage,
                    // which would trigger broadcast via EventEmitter.
                }
            } catch (error) {
                console.error(\`[WebSocket] Error during message persistence for \${clientIp} (Task: \${taskId}):\`, error);
                try { ws.send(JSON.stringify({ type: 'error', content: { text: 'Error processing message server-side.' }, senderId: 'system', timestamp: new Date().toISOString() })); } catch (sendErr) { console.error("WS Send Error:", sendErr); }
            }
        });

        ws.on('close', () => {
            if (taskId && activeTaskSockets.has(taskId)) { // Ensure taskId was defined
                activeTaskSockets.get(taskId).delete(ws);
                console.log(\`[WebSocket] Removed client \${clientIp} from task \${taskId}. Remaining clients: \${activeTaskSockets.get(taskId).size}\`);
                if (activeTaskSockets.get(taskId).size === 0) {
                    activeTaskSockets.delete(taskId);
                    console.log(\`[WebSocket] No more clients for task \${taskId}, removed task from active sockets.\`);
                }
            }
            console.log(\`[WebSocket] Client \${clientIp} (Task: \${taskId || 'unknown'}) disconnected\`);
        });

        ws.on('error', (error) => {
            console.error(\`[WebSocket] Error on connection with \${clientIp} (Task: \${taskId || 'unknown'}):\`, error);
            if (taskId && activeTaskSockets.has(taskId)) { // Ensure taskId was defined
                activeTaskSockets.get(taskId).delete(ws);
                 if (activeTaskSockets.get(taskId).size === 0) {
                    activeTaskSockets.delete(taskId);
                }
            }
        });
    });

    return wss; // Optionally return the wss instance
}
