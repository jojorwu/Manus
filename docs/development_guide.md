# Manus System Development Guide

## 1. Introduction

This guide is intended for developers looking to extend, modify, or contribute to the Manus multi-agent system. It provides practical instructions on how to add new components like agents and tools, and how to work with key subsystems.

For a comprehensive understanding of the system's components and their interactions, please first refer to the [System Architecture documentation](architecture.md).

## 2. Development Environment Setup

Setting up your development environment is similar to the Quick Start in the main `README.md`:

1.  **Prerequisites**:
    *   Node.js (v18.0.0+ recommended).
    *   npm or yarn.
    *   Git.
2.  **Clone & Install**:
    ```bash
    git clone <your-repo-url>
    cd <repo-name>
    npm install
    # or yarn install
    ```
3.  **Environment Variables (`.env`)**:
    *   Create a `.env` file in the project root (you can copy `.env.example` if it exists).
    *   Fill in the necessary API keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `SEARCH_API_KEY`, `CSE_ID`) and other configurations like `PORT` and `CONTEXT7_SERVER_URL`. These are crucial for running the system with full functionality.
4.  **Recommended Tools**:
    *   An IDE like VS Code with good JavaScript/Node.js support.
    *   Node.js debugger.
    *   Postman or a similar tool for testing the HTTP API.

## 3. Extending the System

Manus is designed to be extensible. Here's how you can add new components:

### 3.1. Adding a New Worker Agent

Worker agents are specialized for certain types of tasks and use a set of tools to accomplish them.

1.  **Create the Agent Class**:
    *   Create a new JavaScript file in the `agents/` directory (e.g., `agents/MyNewAgent.js`).
    *   The class should typically have a constructor and at least two methods: `startListening()` and `processTaskMessage(taskMessage)`.
    ```javascript
    // agents/MyNewAgent.js
    // const { t } = require('../utils/localization'); // For localized logging

    class MyNewAgent {
        constructor(subTaskQueue, resultsQueue, toolsMap, agentApiKeysConfig, agentName = "MyNewAgent") {
            this.subTaskQueue = subTaskQueue;
            this.resultsQueue = resultsQueue;
            this.toolsMap = toolsMap; // e.g., { "MyTool": myToolInstance }
            this.agentApiKeysConfig = agentApiKeysConfig; // Access API keys if tools need them
            this.agentRole = agentName; // Role used for task subscription
            // console.log(t('INIT_DONE', { componentName: this.agentRole }));
        }

        startListening() {
            // console.log(t('AGENT_LISTENING', { agentName: this.agentRole, agentRole: this.agentRole }));
            this.subTaskQueue.subscribe(this.agentRole, this.processTaskMessage.bind(this));
        }

        async processTaskMessage(taskMessage) {
            const { tool_name, sub_task_input, sub_task_id, parent_task_id, narrative_step } = taskMessage;
            // console.log(t('AGENT_RECEIVED_TASK_DETAILS', { agentName: this.agentRole, subTaskId: sub_task_id, toolName: tool_name, narrative: narrative_step }));

            const tool = this.toolsMap[tool_name];
            let outcome = { result: null, error: `Tool '${tool_name}' not found in ${this.agentRole}.` };
            let status = "FAILED";

            if (tool) {
                try {
                    // Add input validation specific to the tool if necessary
                    // const validationError = tool.validateInput ? tool.validateInput(sub_task_input) : null;
                    // if (validationError) {
                    //    outcome = { result: null, error: validationError };
                    // } else {
                         outcome = await tool.execute(sub_task_input, this.agentApiKeysConfig); // Pass API keys if tool needs them
                    // }
                    status = outcome.error ? "FAILED" : "COMPLETED";
                } catch (e) {
                    // console.error(t('AGENT_TOOL_EXEC_ERROR', { agentName: this.agentRole, toolName: tool_name, errorMessage: e.message }), e);
                    outcome = { result: null, error: e.message || "Unknown error during tool execution." };
                    status = "FAILED";
                }
            }

            const resultMessage = {
                sub_task_id,
                parent_task_id,
                worker_agent_role: this.agentRole,
                status,
                result_data: outcome.result,
                error_details: outcome.error ? { message: outcome.error } : null
            };
            this.resultsQueue.enqueueResult(resultMessage);
        }
    }
    module.exports = MyNewAgent;
    ```

2.  **Initialize and Register in `index.js`**:
    *   Import your new agent: `const MyNewAgent = require('./agents/MyNewAgent');`
    *   Instantiate it, providing necessary dependencies (queues, its tools map, API keys config):
        ```javascript
        const myNewAgentTools = { /* "MyTool": myToolInstance, ... */ };
        const myNewAgent = new MyNewAgent(subTaskQueue, resultsQueue, myNewAgentTools, agentApiKeysConfig);
        myNewAgent.startListening();
        ```

3.  **Update `config/agentCapabilities.json`**:
    *   Add a new entry for your agent, defining its `role` (must match `agentName` or the role it subscribes to), `description`, and the list of `tools` it can use (name and description for each). This allows `PlanManager` to assign tasks to it.
    ```json
    {
      "role": "MyNewAgent",
      "description": "Description of what MyNewAgent specializes in.",
      "tools": [
        { "name": "MyTool", "description": "Description of MyTool and its input format." }
      ]
    }
    ```

### 3.2. Adding a New Tool

Tools perform specific actions and are used by agents.

1.  **Create the Tool Class**:
    *   Create a new file in the `tools/` directory (e.g., `tools/MyCustomTool.js`).
    *   The class should have an `async execute(input, agentApiKeysConfig)` method. `agentApiKeysConfig` can be passed if the tool needs API keys (e.g., like `WebSearchTool`).
    *   The `execute` method should return an object: `{ result: <data>, error: <null_or_error_message_string> }`.
    ```javascript
    // tools/MyCustomTool.js
    class MyCustomTool {
        constructor(config = {}) { // Optional config for the tool itself
            this.config = config;
            // console.log(t('INIT_DONE', { componentName: 'MyCustomTool' }));
        }

        async execute(input, agentApiKeysConfig = null) {
            // const { param1, param2 } = input;
            // Access agentApiKeysConfig if needed: agentApiKeysConfig.myService.apiKey
            try {
                // ... perform tool logic ...
                const data = "result of MyCustomTool operation";
                return { result: data, error: null };
            } catch (e) {
                // console.error(t('TOOL_EXEC_ERROR', { toolName: 'MyCustomTool', errorMessage: e.message }), e);
                return { result: null, error: e.message || "Unknown error in MyCustomTool." };
            }
        }
    }
    module.exports = MyCustomTool;
    ```

2.  **Initialize in `index.js`**:
    *   Import your new tool: `const MyCustomTool = require('./tools/MyCustomTool');`
    *   Instantiate it: `const myCustomToolInstance = new MyCustomTool();`

3.  **Assign to Agent(s) in `index.js`**:
    *   Add the instance to the `toolsMap` of the agent(s) that will use it:
        ```javascript
        const myNewAgentTools = {
            "MyCustomTool": myCustomToolInstance,
            // ... other tools for MyNewAgent
        };
        // Or add to an existing agent's toolsMap
        // researchAgentTools["MyCustomTool"] = myCustomToolInstance;
        ```

4.  **Update `config/agentCapabilities.json`**:
    *   Add the new tool to the `tools` list of the relevant agent(s), including its `name` (matching the key in `toolsMap`) and a `description` for the LLM planner.
    ```json
    // Inside an agent's capabilities:
    // ...
    // "tools": [
    //   ...,
    //   { "name": "MyCustomTool", "description": "Description of what MyCustomTool does and its input format, e.g., { param1: 'value' }." }
    // ]
    ```

### 3.3. Adding a New AI Service

AI services abstract interactions with different LLM providers.

1.  **Create the Service Class**:
    *   Create a new file in `services/ai/` (e.g., `services/ai/AnotherAIService.js`).
    *   The class must extend `BaseAIService` (from `services/ai/BaseAIService.js`).
    *   Implement the required methods: `async generateText(prompt, params)` and `async completeChat(messages, params)`.
    *   Handle API key management (e.g., from constructor or environment variables) and specific API calls for that provider.
    ```javascript
    // services/ai/AnotherAIService.js
    const BaseAIService = require('./BaseAIService');

    class AnotherAIService extends BaseAIService {
        constructor(apiKey, baseConfig = {}) {
            super(apiKey, baseConfig);
            this.defaultModel = baseConfig.defaultModel || 'default-model-for-another-ai';
            // Initialize client for AnotherAI, e.g., this.anotherAiClient = new AnotherAIClient(this.apiKey);
        }

        async generateText(prompt, params = {}) {
            // ... implementation for AnotherAI's text generation ...
            // Ensure API key is checked if required
            // Call AnotherAI's SDK/API
            // Return text string
            // Handle errors and throw new Error(`AnotherAI API Error: ...`);
            return `Response from AnotherAIService (generateText) for prompt: ${prompt.substring(0,20)}...`;
        }

        async completeChat(messages, params = {}) {
            // ... implementation for AnotherAI's chat completion ...
            return `Response from AnotherAIService (completeChat) for ${messages.length} messages.`;
        }
    }
    module.exports = AnotherAIService;
    ```

2.  **Initialize in `index.js`**:
    *   Import the new service: `const AnotherAIService = require('./services/ai/AnotherAIService');`
    *   Instantiate it, providing API key (e.g., from `process.env.ANOTHERAI_API_KEY`) and `baseConfig`:
        ```javascript
        const anotherAIService = new AnotherAIService(process.env.ANOTHERAI_API_KEY, {
            defaultModel: 'model-x',
            planningModel: 'model-x-plan',
            // ... other default models for this service
        });
        ```

3.  **Update AI Service Selection Logic in `index.js`**:
    *   In the `/api/generate-plan` handler, update the logic that selects `activeAIService` to include your new service as an option for the `aiService` request parameter.
        ```javascript
        // ... inside /api/generate-plan handler
        // let activeAIService;
        // if (req.body.aiService === "anotherAI") {
        //    activeAIService = anotherAIService;
        // } else if (req.body.aiService === "openai") {
        //    activeAIService = openAIService;
        // } else { ... }
        ```

4.  **Update API Documentation (`docs/api.md`)**:
    *   Add the new service key (e.g., `"anotherAI"`) to the list of allowed values for the `aiService` parameter.

## 4. Working with Key Subsystems

### 4.1. Memory Bank (`MemoryManager`)

*   **API**: `MemoryManager` (`core/MemoryManager.js`) provides methods like:
    *   `initializeTaskMemory(taskDirPath)`
    *   `loadMemory(taskDirPath, fileName, options)` (options: `isJson`, `defaultValue`)
    *   `appendToMemory(taskDirPath, fileName, contentToAppend)`
    *   `overwriteMemory(taskDirPath, fileName, newContent, options)` (options: `isJson`)
    *   `getSummarizedMemory(taskDirPath, fileName, aiService, summarizationOptions)` (options: `maxOriginalLength`, `promptTemplate`, `llmParams`, `cacheSummary`, `forceSummarize`)
*   **Usage**: Primarily used by `OrchestratorAgent` to persist and retrieve task-related context (definitions, CWC snapshots, decisions, summaries). Files are stored in `saved_tasks/tasks_MMDDYYYY/{taskId}/memory_bank/`.
*   **Extending**: If new types of memory files are needed, define their names and formats, then use the `MemoryManager` methods to interact with them. Remember to update `OrchestratorAgent` logic to save/load/use this new memory.

### 4.2. Planning (`PlanManager`)

*   **Capabilities**: `PlanManager` uses `config/agentCapabilities.json` to understand what agents and tools are available. Keep this file updated when adding/changing agents or tools.
*   **Templates**: For common tasks, you can create JSON plan templates in `config/plan_templates/` and define a regex in `PlanManager.loadPlanTemplates()` to match them.
*   **LLM Prompting**: The main prompt for LLM-based planning is constructed in `PlanManager.getPlan`. It includes the task, agent capabilities, memory context, and detailed JSON format instructions. If you modify the plan structure or add new core concepts that the LLM planner needs to know, this prompt may need adjustment.
*   **Plan Validation**: `parseAndValidatePlan` enforces the structure of LLM-generated plans. If you change the required plan structure, this validation logic must also be updated.

### 4.3. Plan Execution (`PlanExecutor`)

*   **Output References**: Understand the `@{outputs.STEP_ID.FIELD_NAME}` syntax for using results from previous steps in `sub_task_input`.
*   **Orchestrator Special Actions**: `LLMStepExecutor`, `ExploreSearchResults`, `FileSystemTool`, `FileDownloaderTool` are handled directly by `PlanExecutor`.
    *   `LLMStepExecutor` now uses the configured `aiService` and can take a `model` parameter in its `sub_task_input`, as well as `prompt` (string) or `messages` (array for chat).
*   **Adding New Special Actions**: Would involve adding a new handler method in `PlanExecutor` and updating `PlanManager`'s prompt to describe it to the LLM.

### 4.4. Localization (`utils/localization.js`)

*   **Mechanism**: Console logs throughout the application are intended to be localized using the `t(key, context)` function from `utils/localization.js`. Translations are stored in `locales/en.json` and `locales/ru.json`.
*   **Adding Translations**: When adding new `console.log/warn/error` statements that should be user-visible or important for debugging in different languages:
    1.  Define a semantic `KEY` for the message.
    2.  Add the `KEY` and its English translation to `locales/en.json`.
    3.  Add the `KEY` and its Russian translation to `locales/ru.json`.
    4.  In your code, use `console.log(t('KEY', { dynamic_param: value }));`.
*   **Initialization**: `initializeLocalization()` is called in `index.js` to detect system locale and load translations. (Note: New modules like AI services, MemoryManager, Context7Client currently have their logs commented out pending explicit localization efforts).

## 5. Testing

*   **Unit Tests**: Jest is the presumed testing framework. Write unit tests for new modules and significant new functionality. Mock dependencies to isolate units. Examples exist for `OpenAIService`, `GeminiService`, `Context7Client`, `Context7DocumentationTool`, and `MemoryManager`.
*   **Integration Tests**: Test interactions between components. For example, ensuring `OrchestratorAgent` correctly uses `MemoryManager` or that `PlanExecutor` correctly dispatches tasks that an agent can execute. (These are typically run manually or with more complex test setups).
*   **End-to-End Tests**: Submit tasks via the `/api/generate-plan` endpoint and verify the overall output and behavior. This is crucial for testing new features like Context7 integration or Memory Bank usage.

## 6. Debugging

*   **Logs**: The system aims for comprehensive (and localized) logging. Check console output from `npm start`.
*   **Node.js Debugger**: Use your IDE's debugger or `node --inspect`.
*   **Saved State**: Examine files in `saved_tasks/tasks_MMDDYYYY/{taskId}/`:
    *   `task_state.json`: Contains the full state of a completed or failed task (plan, execution context, CWC, final answer).
    *   `journal.json`: Detailed event log from Orchestrator and PlanExecutor.
    *   `memory_bank/`: Contains various persisted memory artifacts.
*   **API Tools**: Use Postman or similar to send requests to `/api/generate-plan` and inspect responses.

This guide should provide a solid starting point for developing and extending the Manus system. Remember to keep documentation (including this guide and `architecture.md`) updated as you make changes.
