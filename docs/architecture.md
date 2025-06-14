# Manus System Architecture

## 1. Introduction

The Manus system is designed as a modular and extensible AI-powered multi-agent platform. Its primary goal is to break down complex user tasks into manageable sub-tasks, delegate them to specialized agents, and synthesize the results to achieve the overall objective. The architecture emphasizes clear separation of concerns, configurability, and the ability to integrate various Large Language Models (LLMs) and external tools.

Key architectural principles include:
*   **Modularity**: Components (agents, tools, AI services) are designed to be self-contained and replaceable.
*   **Extensibility**: The system can be easily extended with new agents, tools, and AI service integrations.
*   **Configuration-Driven**: Agent capabilities, API keys, and some behaviors are managed through external configuration files and environment variables.
*   **Asynchronous Communication**: Queues are used for task and result passing between the orchestrator and worker agents, allowing for non-blocking operations.
*   **Persistent Context**: A Memory Bank لكل مهمة يسمح بالاحتفاظ بالمعلومات الهامة واستخدامها عبر جلسات العمل أو في المهام المعقدة طويلة الأمد.

## 2. High-Level Architectural Overview

At a high level, Manus operates as follows:

1.  An **API Layer** (currently via `index.js` using Express) receives a user task.
2.  The task is passed to the **Orchestrator Agent**.
3.  The Orchestrator Agent, using its **Plan Manager** and an **AI Service** (like OpenAI or Gemini), generates a multi-stage execution plan. This plan may leverage predefined **Plan Templates** or be entirely AI-generated. The **Memory Bank** can provide context for planning.
4.  The Orchestrator Agent's **Plan Executor** takes this plan and executes it stage by stage.
    *   Sub-tasks are dispatched via a **SubTaskQueue** to appropriate **Worker Agents** (e.g., `ResearchAgent`, `UtilityAgent`).
    *   Worker Agents use their configured **Tools** (e.g., `WebSearchTool`, `CalculatorTool`, `Context7DocumentationTool`) to perform actions.
    *   Results from Worker Agents are sent back via a **ResultsQueue**.
    *   The Plan Executor also handles special tasks directly assigned to the "Orchestrator" role, such as calling an AI Service via `LLMStepExecutor` or interacting with the `FileSystemTool`.
5.  Throughout execution, the Orchestrator maintains a **Current Working Context (CWC)**, summarizing progress, findings, and errors. The CWC is also persisted in the **Memory Bank**.
6.  If steps fail, the Orchestrator can trigger a **replanning** cycle with the Plan Manager, providing context about the failure.
7.  Once the plan is complete (or if it fails definitively), the Orchestrator synthesizes a final answer (often using an AI Service) and returns it via the API.
8.  The **Context7 Client** and **Context7DocumentationTool** allow the system to fetch up-to-date documentation from an external Context7 MCP server to enrich LLM prompts.

*(A textual diagram or a link to a visual diagram could be inserted here in a real project).*

## 3. Key System Components

### 3.1. Entry Point (`index.js`)

*   **Responsibilities**:
    *   Initializes and configures the Express.js web server.
    *   Defines the primary external API endpoint: `POST /api/generate-plan`.
    *   Handles environment variable loading (e.g., API keys via `dotenv`).
    *   Initializes all core services and components:
        *   `SubTaskQueue` and `ResultsQueue`.
        *   AI Services (`OpenAIService`, `GeminiService`) based on environment keys.
        *   An `activeAIService` is selected (defaulting to OpenAI, can be chosen per API request).
        *   All `Tools` are instantiated, including `Context7Client` and `Context7DocumentationTool`.
        *   Worker Agents (`ResearchAgent`, `UtilityAgent`) are instantiated with their respective tools and queues.
        *   The `OrchestratorAgent` is instantiated *per API request* inside the `/api/generate-plan` handler, receiving the `activeAIService` for that request.
    *   Starts worker agents' listening processes.

### 3.2. Task and Result Queues (`core/SubTaskQueue.js`, `core/ResultsQueue.js`)

*   **Purpose**: Decouple the Orchestrator from Worker Agents, enabling asynchronous task processing.
*   **`SubTaskQueue`**:
    *   Used by `PlanExecutor` (on behalf of Orchestrator) to enqueue sub-tasks for specific agent roles.
    *   Worker Agents subscribe to tasks matching their role.
    *   Emits events to notify subscribed agents of new tasks.
*   **`ResultsQueue`**:
    *   Used by Worker Agents to send back the results of their completed sub-tasks.
    *   `PlanExecutor` subscribes (typically `subscribeOnce`) to specific task results to continue plan execution.

### 3.3. AI Services (`services/ai/`)

*   **`BaseAIService.js`**:
    *   An abstract base class defining the common interface for interacting with different LLM providers.
    *   Key methods: `async generateText(prompt, params)` and `async completeChat(messages, params)`.
    *   Ensures that concrete implementations (like `OpenAIService`, `GeminiService`) adhere to a consistent contract.
*   **`OpenAIService.js`**:
    *   Concrete implementation for OpenAI models (e.g., GPT-3.5-turbo, GPT-4).
    *   Uses the official `openai` Node.js library.
    *   Handles API key (`OPENAI_API_KEY`), model selection (via `params` or `baseConfig`), and API error handling.
    *   Primarily uses the Chat Completions API.
*   **`GeminiService.js`**:
    *   Concrete implementation for Google Gemini models (e.g., `gemini-pro`).
    *   Uses the `@google/generative-ai` Node.js SDK.
    *   Handles API key (`GEMINI_API_KEY`), model selection, and API error handling.
    *   Supports both text generation and chat-like interactions.
*   **Selection**: The `index.js` instantiates available AI services. The `OrchestratorAgent` (and through it, `PlanManager` and `PlanExecutor`) receives the `activeAIService` instance to use for a given user task, which can be selected via the `/api/generate-plan` request.
*   **Configuration**: Each AI service can be initialized with a `baseConfig` object in `index.js` that specifies default models for different operations (e.g., `planningModel`, `synthesisModel`, `summarizationModel`).

### 3.4. Orchestrator Agent (`agents/OrchestratorAgent.js`)

*   **Role**: The central coordinator of task processing.
*   **`handleUserTask(userTaskString, parentTaskId, taskIdToLoad, executionMode)`**: The main method that manages the entire lifecycle of a user task.
    *   Supports different `executionMode`s: `EXECUTE_FULL_PLAN`, `PLAN_ONLY`, `SYNTHESIZE_ONLY`, `EXECUTE_PLANNED_TASK`.
*   **Current Working Context (CWC)**:
    *   An internal state object (`this.currentWorkingContext`) that the Orchestrator maintains throughout task processing.
    *   Includes: `summaryOfProgress`, `keyFindings` (from tool executions), `identifiedEntities`, `pendingQuestions`, `nextObjective`, `confidenceScore`, `errorsEncountered`.
    *   CWC is updated programmatically and can also be refined using an LLM call (`this.aiService.generateText`) based on recent findings and errors.
    *   Persisted to the Memory Bank (`current_working_context.json`).
*   **Planning**: Delegates plan generation to `PlanManager`.
*   **Execution**: Delegates plan execution to `PlanExecutor`.
*   **Replanning**: If `PlanExecutor` reports a failure, the Orchestrator can initiate a replanning cycle with `PlanManager`, providing the CWC, execution context so far, and details of the failed step.
*   **Memory Interaction**: Uses `MemoryManager` to:
    *   Initialize memory for a new task.
    *   Save the initial `task_definition.md`.
    *   Continuously save/update `current_working_context.json`.
    *   Load memory (task definition, past decisions, CWC snapshot) to provide context to `PlanManager`.
    *   Record key decisions/learnings (e.g., about replanning) in `key_decisions_and_learnings.md`.
    *   Archive the `final_answer_archive.md` and `execution_log_summary.md`.
*   **Final Synthesis**: Uses `this.aiService.generateText` to synthesize the final answer based on the original task, execution history, and the final CWC.

### 3.5. Plan Manager (`core/PlanManager.js`)

*   **Responsibility**: Generating executable, multi-stage plans.
*   **`getPlan(...)` Method**:
    *   **Template-based plans**: First attempts to match the `userTaskString` against predefined regex-based plan templates located in `config/plan_templates/`.
    *   **LLM-based planning**: If no template matches or if it's a replanning scenario, it constructs a detailed prompt for the configured `aiService` (`this.aiService.generateText`).
        *   The prompt includes: the user task, `memoryContext` (loaded by Orchestrator), descriptions of available worker agents and their tools (from `agentCapabilities`), descriptions of special Orchestrator actions (`LLMStepExecutor`, `ExploreSearchResults`, `FileSystemTool`, `FileDownloaderTool`), and detailed instructions on the required JSON plan format.
        *   For replanning, additional context like CWC, past execution history, and failed step details are included.
*   **Plan Validation (`parseAndValidatePlan`)**: The JSON response from the LLM is rigorously validated for structural correctness, valid agent roles, known tools, unique `stepId`s, and correct output reference syntax (`@{outputs...}`).
*   **Output**: Returns a plan (array of stages, where each stage is an array of sub-task objects) or an error message.

### 3.6. Plan Executor (`core/PlanExecutor.js`)

*   **Responsibility**: Executing the stages of a plan generated by `PlanManager`.
*   **`executePlan(planStages, parentTaskId, userTaskString)` Method**:
    *   Iterates through plan stages sequentially. Sub-tasks within a stage are intended for parallel execution (though current implementation with `Promise.all` on results might serialize if agents are busy or if it awaits each result individually before dispatching all in stage - actual parallelism depends on agent availability and queue processing).
    *   **Output Reference Resolution (`_resolveOutputReferences`)**: Before dispatching a sub-task or executing an Orchestrator action, resolves any `@{outputs.SOURCE_STEP_ID.FIELD_NAME}` placeholders in `sub_task_input` using data from previously completed steps (stored in `stepOutputs`).
    *   **Task Dispatch**: For tasks assigned to Worker Agents, it constructs a `taskMessage` and enqueues it to `SubTaskQueue`. It then waits for the result via `ResultsQueue.subscribeOnce`.
    *   **Orchestrator Special Actions**:
        *   `LLMStepExecutor`: Directly uses `this.aiService` (e.g., `generateText` or `completeChat`) to execute a prompt defined in the step. Input can be a string prompt or an array of chat messages. Can specify a model for the step.
        *   `ExploreSearchResults`: Takes results from a previous `WebSearchTool` step, uses an internal `ReadWebpageTool` to read content from several result links, and aggregates the content.
        *   `FileSystemTool` / `FileDownloaderTool`: Instantiates these tools with a task-specific workspace path and executes the specified file operations.
    *   **Data Summarization (`_summarizeStepData`)**: If the `result_data` from a step is too long, it can be summarized using `this.aiService.generateText` before being stored in `processed_result_data`.
    *   **Execution Context**: Builds `executionContext`, an array detailing each executed step, its input, status, raw and processed results, and any errors.
    *   **Failure Handling**: If a step fails, execution of the current plan halts, and `PlanExecutor` returns information about the failure to `OrchestratorAgent` for potential replanning.

### 3.7. Worker Agents (`agents/ResearchAgent.js`, `agents/UtilityAgent.js`)

*   **General Model**:
    *   Subscribe to `SubTaskQueue` for tasks matching their `agentRole`.
    *   Upon receiving a task, they select the appropriate `Tool` based on `tool_name` from their `toolsMap`.
    *   Execute the tool with `sub_task_input`.
    *   Enqueue the result (or error) to `ResultsQueue`.
*   **`ResearchAgent`**: Equipped with `WebSearchTool`, `ReadWebpageTool`, and `Context7DocumentationTool`.
*   **`UtilityAgent`**: Equipped with `CalculatorTool`.
*   New agents can be added by creating a class, defining its tools, and registering it in `index.js` and `config/agentCapabilities.json`.

### 3.8. Tools (`tools/`)

*   **Purpose**: Encapsulate specific, reusable actions that agents can perform. Each tool typically has an `execute(input)` method.
*   Examples:
    *   `WebSearchTool.js`: Performs web searches.
    *   `ReadWebpageTool.js`: Reads web page content.
    *   `CalculatorTool.js`: Evaluates mathematical expressions.
    *   `FileSystemTool.js`: Interacts with a sandboxed file system for the task.
    *   `FileDownloaderTool.js`: Downloads files from URLs.
    *   `Context7DocumentationTool.js`: Fetches documentation from a Context7 MCP server.

### 3.9. Memory Bank (`core/MemoryManager.js` & `saved_tasks/`)

*   **Purpose**: Provides persistent storage for task-related context, decisions, and outcomes.
*   **`MemoryManager.js`**: Offers an API to initialize, read, write, and append to memory files (Markdown, JSON).
*   **Storage Structure**: Each task (`parentTaskId`) gets a dedicated directory (`saved_tasks/tasks_MMDDYYYY/{parentTaskId}/memory_bank/`) containing files like `task_definition.md`, `current_working_context.json`, `key_decisions_and_learnings.md`, etc.
*   **Summarization (`getSummarizedMemory`)**: `MemoryManager` can summarize large memory files using an AI service. Summaries are cached based on the SHA256 hash of the original content to avoid redundant summarization. Metadata for summaries (original content hash, timestamp) is stored in `.meta.json` files.
*   **Usage**: `OrchestratorAgent` uses `MemoryManager` extensively to load context for planning and to save critical information during and after task execution.

### 3.10. Context7 Integration (`services/Context7Client.js`, `tools/Context7DocumentationTool.js`)

*   **Purpose**: To provide LLMs with up-to-date documentation for software libraries, reducing errors and improving the relevance of generated code/explanations.
*   **`Context7Client.js`**: A low-level client that sends JSON-RPC 2.0 requests to a Context7 MCP server (specified by `CONTEXT7_SERVER_URL`). It handles calls to MCP "tools" like `resolve-library-id` and `get-library-docs`.
*   **`Context7DocumentationTool.js`**: An agent-usable tool that abstracts the two-step process of resolving a library ID and then fetching its documentation using `Context7Client`.

### 3.11. System Configuration

*   **`.env` file**: Stores API keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `SEARCH_API_KEY`, `CSE_ID`), server port (`PORT`), and `CONTEXT7_SERVER_URL`.
*   **`config/agentCapabilities.json`**: Defines available agent roles, their descriptions, and the tools they can use, along with tool descriptions. This file is crucial for `PlanManager` to generate valid plans.
*   **`config/plan_templates/`**: Contains predefined JSON plan templates that `PlanManager` can use for common, well-defined tasks, bypassing LLM-based plan generation if a template matches.

## 4. Core Data Flows

*(This section would benefit greatly from diagrams in a real-world scenario)*

### 4.1. New Task Request (`/api/generate-plan`)

1.  `index.js` (Express server) receives POST request.
2.  `aiService` instance is selected/created based on `req.body.aiService` (or default).
3.  `OrchestratorAgent` instance is created with the selected `aiService`.
4.  `OrchestratorAgent.handleUserTask` is invoked.
5.  `taskDirPath` is determined, `MemoryManager.initializeTaskMemory` is called.
6.  `task_definition.md` and initial `current_working_context.json` are saved to memory.
7.  **Planning**:
    *   Orchestrator loads relevant context from Memory Bank (task definition, past decisions) into `memoryContextForPlanning`.
    *   Orchestrator calls `PlanManager.getPlan(userTask, ..., memoryContextForPlanning, currentCWC)`.
    *   `PlanManager` tries to use a template. If not found/applicable:
        *   Constructs a prompt for `this.aiService.generateText` including task, agent capabilities, tool descriptions, memory context, and plan format instructions.
        *   Receives JSON plan string from AI Service.
        *   Validates the plan via `parseAndValidatePlan`.
    *   Orchestrator saves updated CWC to memory.
8.  **Execution**:
    *   Orchestrator calls `PlanExecutor.executePlan(plan, ...)`.
    *   `PlanExecutor` iterates through stages/steps:
        *   Resolves `@{outputs...}` references.
        *   If step is for Orchestrator: Executes directly (e.g., `LLMStepExecutor` calls `this.aiService`, `FileSystemTool` performs file op).
        *   If step is for Worker Agent: Enqueues task to `SubTaskQueue`. Waits for result on `ResultsQueue`.
        *   (Worker Agent picks up task, uses Tool, puts result in `ResultsQueue`).
        *   `PlanExecutor` may summarize step results using `this.aiService`.
        *   Builds `executionContext`.
    *   Orchestrator saves updated CWC to memory.
9.  **Replanning (if a step fails)**:
    *   `PlanExecutor` returns failure details to Orchestrator.
    *   Orchestrator records failure in CWC (and saves to memory).
    *   Orchestrator calls `PlanManager.getPlan` again with `isRevision=true` and additional context (CWC, execution history, failed step info, memory context).
    *   Loop back to execution if new plan obtained.
    *   Records replanning attempt outcome in `key_decisions_and_learnings.md`.
10. **CWC LLM Update**: Orchestrator uses `this.aiService` to refine CWC's `summaryOfProgress` and `nextObjective`. Updated CWC saved to memory.
11. **Final Answer Synthesis**: Orchestrator uses `this.aiService` to generate `finalAnswer` based on task, execution context, and CWC.
12. **Final Save**:
    *   Final CWC, `final_answer_archive.md`, `execution_log_summary.md` saved to Memory Bank.
    *   Main task state (`task_state.json`) and journal (`journal.json`) are saved.
13. Response returned via API.

### 4.2. Using Context7DocumentationTool

1.  `PlanManager` generates a plan containing a step for `ResearchAgent` to use `Context7DocumentationTool` with specific `libraryName` and `topic`.
2.  `PlanExecutor` dispatches this task to `ResearchAgent`.
3.  `ResearchAgent` executes `Context7DocumentationTool.execute({libraryName, topic})`.
4.  `Context7DocumentationTool` calls `Context7Client.resolveLibraryId(libraryName)`.
5.  `Context7Client` sends JSON-RPC request to Context7 Server. Gets ID.
6.  `Context7DocumentationTool` calls `Context7Client.getLibraryDocs(libraryId, topic)`.
7.  `Context7Client` sends JSON-RPC request. Gets documentation text.
8.  `Context7DocumentationTool` returns documentation text to `ResearchAgent`.
9.  `ResearchAgent` puts result in `ResultsQueue`.
10. `PlanExecutor` receives result. Documentation is now available in `stepOutputs` for subsequent steps.
11. A following `LLMStepExecutor` step can reference this documentation via `@{outputs...}` in its prompt.

## 5. Extensibility

The system is designed for extensibility:

*   **New Agents**: Create a new agent class, define its capabilities in `agentCapabilities.json`, and register it in `index.js`.
*   **New Tools**: Create a new tool class, add it to an agent's `toolsMap` in `index.js`, and describe it in `config/agentCapabilities.json`.
*   **New AI Services**: Create a new class inheriting from `BaseAIService.js`, implement its methods, and add logic in `index.js` to select/configure it.

(Refer to [docs/development_guide.md](docs/development_guide.md) for more details on extending the system).
