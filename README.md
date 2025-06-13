# Gemini Powered AI Agent

> Current Version: **v0.1.0-beta** — For a detailed list of features and changes, please see the [CHANGELOG.md](./CHANGELOG.md).

## Overview

This project is a Node.js-based AI agent that leverages the Google Gemini API to understand tasks, generate multi-step execution plans, and execute those plans using a variety of tools. It currently aims to feature a Gemini execution tool for general reasoning, a Web Search tool, a Calculator tool, and a Webpage Reading tool (note: some tools like WebSearch and ReadWebpage are currently stubs, see "Known Issues / Limitations"). The agent is designed to handle complex tasks by breaking them into stages, with parallel execution of sub-tasks within each stage. It saves task states and supports different operational modes via its API. Interaction with the agent is primarily through a modern React-based web interface.

## Project Architecture

This project consists of two main components: a Node.js backend that houses the AI agent logic, and a modern React frontend for user interaction.

*   **Backend (Root Directory - `index.js`):**
    *   Built with Node.js and Express.js.
    *   Responsible for all core AI agent functionalities:
        *   Receiving user tasks via API endpoints.
        *   Interacting with the Google Gemini API for planning, step execution, replanning, and context summarization.
        *   Managing and dispatching tasks to various tools (e.g., Web Search, Calculator, Webpage Reader, GeminiStepExecutor).
        *   Handling the execution flow, including staged/parallel execution and context management.
    *   Exposes an API (currently `/api/generate-plan`) that the frontend consumes.
        The `/api/generate-plan` endpoint accepts a POST request with a JSON body.
        - `task` (string, required for `EXECUTE_FULL_PLAN` and `PLAN_ONLY` modes): The user's task description.
        - `mode` (string, optional, defaults to "EXECUTE_FULL_PLAN"): Specifies the operational mode.
            - `"EXECUTE_FULL_PLAN"`: Generates a new plan, executes it, saves the task state, and returns the synthesized answer.
            - `"SYNTHESIZE_ONLY"`: Loads a previously saved task state using `taskIdToLoad`, re-synthesizes the final answer based on its `executionContext` and `userTaskString`, and returns the result. Does not re-execute or re-save the plan.
            - `"PLAN_ONLY"`: Receives a user `task`, generates a multi-stage execution plan, saves the task state (including the plan and a status like "PLAN_GENERATED"), and returns the `taskId` and the generated `plan` to the user. Does not execute the plan.
            - `"EXECUTE_PLANNED_TASK"`: Loads a task state (identified by `taskIdToLoad`) that should ideally have a pre-generated plan (e.g., from a prior "PLAN_ONLY" call). It then executes this plan, synthesizes a final answer, updates the task state file with the execution results and new status (e.g., "COMPLETED" or "FAILED_EXECUTION"), and returns the outcome. The `task` field is not used in the request.
        - `taskIdToLoad` (string, required for `SYNTHESIZE_ONLY` and `EXECUTE_PLANNED_TASK` modes): The ID of a previously saved task state to load. Not used in `PLAN_ONLY` mode.
    *   Its root path (`/`) now returns a simple JSON health/status message, and it serves static assets (which could include a production build of the frontend if placed in the root).

*   **Frontend (`frontend/` Directory):**
    *   A modern single-page application (SPA) built with React and Vite.
    *   Styled using Tailwind CSS and Shadcn/UI components for a polished user experience.
    *   Provides the user interface for:
        *   Submitting tasks to the agent.
        *   Displaying the agent's generated plan (including stages, steps, and chosen tools).
        *   Showing a detailed execution log of the agent's actions and results, including any replanning activity.
    *   Communicates with the backend by making HTTP requests to its API endpoints.

**Interaction Flow:**

1.  The user interacts with the React frontend, submitting a task.
2.  The frontend sends this task to the backend's API endpoint (e.g., `/api/generate-plan`).
3.  The Node.js backend processes the task:
    *   Generates a plan using Gemini.
    *   Executes the plan stage by stage. Sub-tasks within each stage are run in parallel. Execution halts if a stage fails.
    *   Handles context summarization and replanning as needed.
4.  The backend returns a JSON response to the frontend, containing the original task, the final plan, and a detailed execution log.
5.  The React frontend then parses this JSON response and renders it in a user-friendly format.

## Key Features

*   **LLM-Driven Planning:** Uses Google Gemini to dynamically generate multi-step, multi-stage plans based on user tasks.
*   **Template-Based Planning for Common Tasks**: For predefined common queries (e.g., simple weather requests, calculations), the system can use plan templates stored in `config/plan_templates/`. This bypasses LLM-based plan generation, leading to faster responses, predictable execution, and reduced LLM usage for recognized intents.
*   **Tool-Aware Execution:** Gemini determines which tool is appropriate for each step in the plan.
*   **Multi-Tool Architecture:**
    *   **GeminiStepExecutor:** For general reasoning, text generation, summarization, and executing complex instructions.
    *   **WebSearchTool:** For performing real-time web searches using the Google Custom Search Engine API.
    *   **CalculatorTool:** For evaluating mathematical expressions.
    *   **ReadWebpageTool:** Uses Playwright (Chromium) to fetch a fully rendered webpage, enabling better handling of Single Page Applications (SPAs). After rendering, it uses `cheerio` to parse the HTML and extract the main textual content. Common non-content elements (scripts, styles, navigation, etc.) are removed, and the text is cleaned and truncated if it exceeds a maximum length. This process is more robust for modern web pages but may take longer than simple HTTP requests.
*   **Staged and Parallel Execution:** Plans are structured into stages that are executed sequentially. Sub-tasks within the same stage are executed in parallel (using `Promise.all()`), allowing for faster completion of independent tasks within a phase of work. The LLM is responsible for generating plans in this staged format.
*   **Contextual Memory & Summarization:** Information from completed steps is carried forward. (Note: The "Long contexts are automatically summarized using Gemini to maintain efficiency" part of this point refers to a more general context summarization, not the specific step-result summarization described next).
*   **Context-Aware Result Summarization**: For tasks generating extensive data from tools, individual step results may be summarized by an LLM before being passed to the final answer synthesis. This helps manage context window limitations and focuses the LLM on the most pertinent information. The full, raw data from each step is still preserved in the saved task state.
*   **Enhanced Information Retrieval with `ExploreSearchResults`**: The OrchestratorAgent can perform a deeper analysis of web search results. If a plan includes the `ExploreSearchResults` special action after a `WebSearchTool` step, the Orchestrator will read the content of a specified number of top web pages from the search results (using `ReadWebpageTool` internally). This allows the system to gather more comprehensive information than just search snippets, leading to more detailed and well-informed answers.
    *   *Note:* This feature's effectiveness is currently linked to `ReadWebpageTool`'s capabilities (which primarily returns partial HTML content, not cleaned text) and the potential for large aggregated text volumes that might challenge LLM context windows if many pages are explored.
*   **Multi-Stage Replanning:** If a step fails, the agent can attempt a focused "step fix" or a more comprehensive "full replan" using Gemini.
*   **Modern Web Interface:** A React/Vite/Tailwind/Shadcn/UI frontend for task submission and detailed progress/result viewing, located in the `frontend/` directory.

## Plan Structure

The AI agent now expects and processes plans that are structured into stages to enable parallel execution. The plan generated by the LLM and processed by the OrchestratorAgent must be a JSON array of stages. Each stage is, in turn, a JSON array of sub-task objects.

*   **Stages**: The outer array represents sequential stages. These are executed one after another.
*   **Sub-tasks**: The inner arrays represent sub-tasks within a specific stage. These sub-tasks are executed in parallel. All sub-tasks in a stage must complete (or at least those not failing, depending on error handling) before the next stage begins.

Example of a two-stage plan:
```json
[
  [
    { "assigned_agent_role": "ResearchAgent", "tool_name": "WebSearchTool", "sub_task_input": { "query": "weather in Paris" }, "narrative_step": "Search for weather in Paris." },
    { "assigned_agent_role": "ResearchAgent", "tool_name": "WebSearchTool", "sub_task_input": { "query": "currency exchange rate USD to EUR" }, "narrative_step": "Search for USD to EUR exchange rate." }
  ],
  [
    { "assigned_agent_role": "UtilityAgent", "tool_name": "CalculatorTool", "sub_task_input": { "expression": "100 * 1.1" }, "narrative_step": "Calculate something based on previous results." }
  ]
]
```
This structure is defined in the planning prompt sent to the LLM.

## Task State Persistence

To facilitate debugging, analysis, and to lay the groundwork for future features like task resumption, the system now persists the state of each processed task.

*   **Storage Location**: Task state files are saved in the `saved_tasks/` directory at the project root. Within `saved_tasks/`, subdirectories are created for each day in the format `tasks_MMDDYYYY` (e.g., `tasks_07042024`).
*   **File Naming**: Each task state is saved in a JSON file named `task_state_{taskId}.json`, where `{taskId}` is the unique parent task ID generated for the user's request.
*   **File Content**: The JSON file contains a comprehensive snapshot of the task, including:
    *   `taskId`: The unique ID of the task.
    *   `userTaskString`: The original user request.
    *   `createdAt`, `updatedAt`: Timestamps for task creation and last update.
    *   `status`: The final status of the task (e.g., "COMPLETED", "FAILED_PLANNING", "FAILED_EXECUTION").
    *   `plan`: The multi-stage plan generated by the LLM.
    *   `executionContext`: A detailed array of objects (`ContextEntry`), where each object represents an executed step, its inputs, status, and results or errors.
    *   `finalAnswer`: The final synthesized answer provided to the user (if any).
    *   `errorSummary`: A summary of the error if the task failed.

The API (`/api/generate-plan`) now supports a `"SYNTHESIZE_ONLY"` mode that can load these saved task states to re-synthesize answers or analyze previous executions. Additionally, the new "EXECUTE_PLANNED_TASK" mode can load a task state (typically one with a status like "PLAN_GENERATED"), execute its plan, and then update the saved state with the execution results and a final status like "COMPLETED" or "FAILED_EXECUTION". Full task resumption is a potential future enhancement.

## Known Issues / Limitations (v0.1.0-beta)

This initial beta version has the following known limitations:

*   **Tool Implementations**:
    *   `ReadWebpageTool` now uses Playwright (Chromium) to fetch and render pages, significantly improving its ability to extract text from Single Page Applications (SPAs). It then uses `cheerio` for text cleaning. While more powerful, this can increase execution time per URL. Its handling of direct links to non-HTML content (e.g., JSON, TXT) now depends on how the browser renders them before text extraction. For optimal performance with many URLs (e.g., in `ExploreSearchResults`), further optimization of Playwright instance management might be needed.
    *   `WebSearchTool` has been implemented to use the Google Custom Search Engine API for web searches.
    *   `CalculatorTool` is functional for basic mathematical expressions.
*   **Task State Loading**:
    *   The `SYNTHESIZE_ONLY` mode's file search logic for `taskIdToLoad` is basic and may be inefficient if many dated directories exist. A more robust lookup mechanism (e.g., an index or requiring more specific path information) is needed.
*   **Task Execution Flow**:
    *   No `EXECUTE_PLANNED_TASK` mode: Currently, there's no dedicated mode to execute a plan that was previously generated by `PLAN_ONLY`. The `EXECUTE_FULL_PLAN` mode always re-plans.
    *   No task resumption: If a task fails midway during `EXECUTE_FULL_PLAN`, it cannot be resumed from the point of failure.
*   **User Interface**:
    *   The existing frontend (`frontend/`) is likely designed for the original single-mode operation and does not yet support interacting with the new API modes (`PLAN_ONLY`, `SYNTHESIZE_ONLY`) or visualizing saved task states.
*   **Error Handling & Retries**:
    *   Advanced error handling, such as configurable retries for failed sub-tasks or LLM calls, is not yet implemented.
*   **Context Management**:
    *   While `ContextEntry` provides structured step-by-step context, very long execution histories might still lead to large contexts for the final synthesis LLM call. Automatic summarization of intermediate `ContextEntry.result_data` is not yet implemented.

## Technology Stack

*   **Backend:** Node.js, Express.js, `dotenv`
*   **LLM:** Google Gemini API (via `@google/generative-ai`)
*   **Tools & Libraries (Backend):**
    *   Web Search: Google Custom Search Engine (CSE) API (via `axios`)
    *   Calculator: `mathjs`
    *   Web Page Reading: `axios` (basic text extraction)
    *   HTTP Client: `axios`
*   **Frontend (`frontend/` directory):** React, Vite, Tailwind CSS, Shadcn/UI, `axios`

## Design Documents

Detailed conceptual designs for key architectural aspects of this project can be found in the `docs/` directory:

*   **[Multi-Agent System Design](./docs/multi_agent_design.md):** Outlines the architecture for the multi-agent system, including agent roles, task queue mechanisms, inter-agent communication, and API key management.
*   **[Persistent Task Memory Design](./docs/persistent_memory_design.md):** Describes the conceptual design for saving agent task states to files for persistence, including data to persist, directory/file structure, content schemas, and agent interaction logic.

## Setup and Installation

### Prerequisites

*   Node.js (v18.x or later recommended)
*   npm (usually comes with Node.js)

### Installation

1.  Clone this repository (if you haven't already).
2.  Navigate to the project root directory.
3.  Install backend dependencies:
    ```bash
    npm install
    ```
4.  Navigate to the `frontend` directory and install frontend dependencies:
    ```bash
    cd frontend
    npm install
    cd ..
    ```
    *   **Playwright Browsers:** After `npm install`, Playwright may require an additional step to download browser binaries if they are not already present or if you want specific browsers. Run:
        ```bash
        npx playwright install --with-deps
        ```
        This command installs default browsers (Chromium, Firefox, WebKit) and their system dependencies. You can also install specific browsers (e.g., `npx playwright install chromium`).

### Environment Variables

Create a `.env` file in the **root** of the project directory. This file is essential for storing your API keys and other configuration.

*   **`GEMINI_API_KEY`**: Your API key for the Google Gemini API.
    *   Obtain from Google AI Studio ([https://aistudio.google.com/](https://aistudio.google.com/)).
*   **`SEARCH_API_KEY`**: Your API key for the Google Custom Search Engine API.
    *   Obtain from the Google Cloud Console. Enable the "Custom Search API".
*   **`CSE_ID`**: Your Custom Search Engine ID.
    *   Create a Custom Search Engine and get its ID from the CSE control panel ([https://programmablesearchengine.google.com/](https://programmablesearchengine.google.com/)). Configure it to search the web or specific sites.

**Example `.env` file (place in project root):**
```
GEMINI_API_KEY="YOUR_GEMINI_API_KEY_HERE"
SEARCH_API_KEY="YOUR_GOOGLE_SEARCH_API_KEY_HERE"
CSE_ID="YOUR_CSE_ID_HERE"
```
*(Note: The `index.js` is configured to use the `dotenv` package (which is included in `package.json`) to load these variables. Ensure dependencies are installed via `npm install`.)*

## Development Workflow: Running the Application

This project has two main parts that need to be run simultaneously for development using the new React-based user interface:

**1. Backend Server:**

*   **Ensure Prerequisites and Environment Variables are set up as described above.**
*   **Running the Backend:**
    *   Open your terminal in the **project root directory**.
    *   Start the server:
        ```bash
        node index.js
        ```
    *   The backend server will typically start on `http://localhost:3000`.
    *   API endpoints (like `/api/generate-plan`) will be available at this address.
    *   Its root path (`/`) provides a JSON status message. Static assets are also served from the root (which could include a production build of the frontend if placed there).
    *   Changes to `index.js` require a manual restart unless using a tool like `nodemon`.

**2. Frontend Development Server (New React UI):**

*   **Ensure frontend dependencies are installed (see "Installation" section).**
*   **Running the Frontend Dev Server:**
    *   Open a **new terminal window/tab**.
    *   Navigate to the `frontend` directory:
        ```bash
        cd frontend
        ```
    *   Start the Vite development server:
        ```bash
        npm run dev
        ```
    *   The frontend development server will typically start on `http://localhost:5173` (Vite will indicate the exact port).
    *   This server provides Hot Module Replacement (HMR), so frontend code changes often update in the browser automatically.

**Accessing the New UI:**
Once both servers are running, access the new React UI via the Vite dev server URL (e.g., `http://localhost:5173`). It will communicate with the backend API at `http://localhost:3000`.

## How to Use (New React UI)

1.  Open your web browser and navigate to the frontend URL (typically `http://localhost:5173`).
2.  You will see an input field where you can enter your task for the AI agent.
3.  Type the task (e.g., "What is the capital of France? Then, calculate 100/5. Finally, search for recent news about it.").
4.  Click the "Generate Plan & Execute" button.
5.  The interface will display:
    *   Your original task.
    *   The multi-stage plan generated by Gemini, including the tool chosen for each step.
    *   A detailed execution log showing the outcome (result or error) for each step, grouped by stage. This includes any replanning attempts if failures occur, and context summarization events.

### Example Workflow: Separate Planning and Execution

You can now separate the planning and execution phases:

1.  **Generate and Save a Plan**:
    Send a POST request to `/api/generate-plan` with:
    ```json
    {
      "task": "Plan a trip to Mars, including key mission stages and required research.",
      "mode": "PLAN_ONLY"
    }
    ```
    The API will return a response containing a `taskId` and the generated `plan`. The task state (with the plan) will be saved.

2.  **Execute the Saved Plan**:
    Later, send another POST request to `/api/generate-plan` with:
    ```json
    {
      "taskIdToLoad": "the_taskId_received_from_step_1",
      "mode": "EXECUTE_PLANNED_TASK"
    }
    ```
    The system will load the task, execute the saved plan, update the task state file, and return the final results.

## Modifying, Forking, and Contributing

This project is set up to be understandable and extensible.

### Forking

*   Fork this repository on GitHub to create your own version for modification.

### Making Modifications

*   **Backend Logic:**
    *   Main application setup and orchestration: `index.js`
    *   Core agent definitions (Orchestrator, Research, Utility): `agents/` directory
    *   Tool definitions (WebSearchTool, CalculatorTool, etc.): `tools/` directory
    *   LLM service interaction (e.g., `geminiLLMService`): `services/` directory
    *   Task and result queues: `core/` directory
    *   Agent capabilities configuration: `config/agentCapabilities.json` (defines roles and tools for the OrchestratorAgent)
*   **Frontend UI:** The React UI is in the `frontend/` directory, primarily within `frontend/src/`. Key components include `App.jsx`, `TaskInputForm.jsx`, and `ResultsDisplay.jsx`.

### Plan Templates

To accelerate processing for common or simple tasks and to ensure consistent execution paths, the `OrchestratorAgent` can utilize predefined plan templates.

*   **Location**: Templates are stored as JSON files in the `config/plan_templates/` directory.
*   **Format**: Each template is a JSON file representing a valid multi-stage plan (an array of stages, where each stage is an array of sub-task objects). Templates can use placeholders in the format `{{PLACEHOLDER_NAME}}` within `sub_task_input` fields or `narrative_step` strings.
    *   Examples: `weather_query_template.json`, `calculator_template.json`.
*   **Matching Logic**: The `OrchestratorAgent` (in its `loadPlanTemplates` method) maintains a list of `templateDefinitions`. Each definition includes:
    *   The template's file name.
    *   A regular expression (`regex`) to match against the user's task string.
    *   A `paramMapping` object that maps placeholder names (e.g., `CITY_NAME`) to the capture group indices from the regex.
*   **Workflow**: When a task is received (in `EXECUTE_FULL_PLAN` or `PLAN_ONLY` mode), the `OrchestratorAgent` first attempts to match the user's task string against these predefined templates using `tryGetPlanFromTemplate`. If a match is found, the corresponding template is populated with parameters extracted by the regex, and this plan is used, bypassing LLM-based plan generation. If no template matches, the system falls back to LLM-based planning.
*   **Adding New Templates**:
    1.  Create a new JSON file for your plan in `config/plan_templates/`, using placeholders as needed.
    2.  In `agents/OrchestratorAgent.js`, update the `templateDefinitions` array within the `loadPlanTemplates` method to include metadata for your new template (its name, file name, regex for matching, and `paramMapping`).

*   **Adding New Tools (Backend):**
    1.  Define your new tool class in a new file within the `tools/` directory (e.g., `tools/MyNewTool.js`) with an `async execute(inputObject)` method, and export the class.
    2.  Import your new tool in `index.js` (e.g., `const MyNewTool = require('./tools/MyNewTool');`).
    3.  Instantiate it in `index.js` where other tools are initialized (e.g., `const myNewTool = new MyNewTool();`).
    4.  Pass the new tool instance to the relevant agent(s) via their constructor or a dedicated method, typically by adding it to the `toolsMap` provided to the agent in `index.js`.
    5.  Update the `config/agentCapabilities.json` file. Add or modify an agent role entry to include the description of the new tool and its association with that role. This configuration is loaded by the OrchestratorAgent to understand available tools and assign them for planning.
    6.  Ensure the agent that will use the tool (e.g., `ResearchAgent.js`, `UtilityAgent.js`, or a new agent) has logic in its `processTaskMessage` method to handle the `tool_name` and call its `execute` method with the correct `sub_task_input`.

### Contributing (Basic Guidelines)

1.  **Open an Issue:** Discuss proposed changes or new features by opening an issue first.
2.  **Create a Pull Request:** Fork the repo, create a feature branch, make your changes, and then open a PR against the main repository's `main` branch. Describe your changes clearly.

```
