require('dotenv').config();
const express = require('express');
const multer = require('multer');
// const path = require('path'); // Removed as unused
const http = require('http');
// WebSocket related imports are now in websocketHandler.js
// url module is now used in websocketHandler.js
// EventEmitter is imported via dependencies.js

// Import local modules using CommonJS syntax
const OrchestratorAgent = require('./agents/OrchestratorAgent.js');
const { initializeLocalization } = require('./utils/localization.js'); // Removed t as unused
const initializeApiRoutes = require('./routes/apiRoutes.js');
const initializeWebSocketHandler = require('./core/websocketHandler.js');
const { getTaskDirectoryPath } = require('./utils/taskPathUtils.js'); // Import from new util module

// Import initialized instances from dependencies.js
const {
    globalEventEmitter,
    memoryManager,
    openAIService,
    geminiService,
    subTaskQueue,
    resultsQueue,
    savedTasksBaseDir, // Still needed if getTaskDirectoryPath used it directly, but now getTaskDirectoryPath imports it
    agentApiKeysConfig
} = require('./core/dependencies.js');

initializeLocalization();

// --- EXPRESS APP SETUP ---
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- HTTP SERVER CREATION ---
const server = http.createServer(app);

// --- HELPER FUNCTIONS ---
// getTaskDirectoryPath is now imported from './utils/taskPathUtils.js'
// It uses savedTasksBaseDir, which is initialized in dependencies.js and imported by taskPathUtils.js

// --- SETUP API ROUTES ---
const routeDependencies = {
    OrchestratorAgent,
    geminiService, openAIService,
    subTaskQueue, memoryManager, resultsQueue,
    savedTasksBaseDir, // Pass it to routes if they construct paths, though getTaskDirectoryPath is preferred
    agentApiKeysConfig,
    upload,
    getTaskDirectoryPath // Pass the imported function
};
const apiRouter = initializeApiRoutes(routeDependencies);
app.use('/api', apiRouter);


// --- Root Route (after API routes) ---
app.get('/', (req, res) => {
    res.json({ status: 'Backend server is running', timestamp: new Date().toISOString() });
});

// --- INITIALIZE WEBSOCKET HANDLER ---
initializeWebSocketHandler(server, globalEventEmitter, memoryManager, getTaskDirectoryPath);

// --- START SERVER ---
server.listen(PORT, () => {
    console.log(`HTTP and WebSocket Server running on http://localhost:${PORT}`);
});
