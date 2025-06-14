# Manus: AI-Powered Multi-Agent System

Manus is a flexible and extensible Node.js-based multi-agent system designed to accomplish complex tasks through collaborative AI. It leverages Large Language Models (LLMs) for planning, execution, and data synthesis, and can be integrated with various external tools and services.

## Key Features

*   **Multi-Agent Architecture**: Employs an Orchestrator agent to manage and coordinate tasks executed by specialized worker agents (e.g., ResearchAgent, UtilityAgent).
*   **Dynamic Task Planning**: Utilizes LLMs to generate step-by-step execution plans based on user requests and agent capabilities. Includes support for replanning on failure.
*   **Extensible Toolset**: Agents can use a variety of tools to perform actions, such as web searching, reading web content, calculations, file system operations, and fetching external documentation.
*   **Multi-AI Service Support**:
    *   Abstracted AI service layer (`BaseAIService`) allows integration with multiple LLM providers.
    *   Includes full implementations for **OpenAI** (`OpenAIService`) and **Google Gemini** (`GeminiService`).
    *   Choice of AI service can be specified per API request.
*   **Persistent Memory Bank**:
    *   Tasks can maintain a "memory bank" to store context, key decisions, learnings, and results.
    *   Supports summarization of large memory segments using LLMs to optimize context for future LLM calls.
    *   Summaries are cached based on content hash for efficiency.
*   **Context7 MCP Integration**:
    *   Acts as a client to a Context7 Model Context Protocol (MCP) server.
    *   Can fetch up-to-date documentation for software libraries via `Context7DocumentationTool` to provide LLMs with current information, reducing hallucinations.
*   **Configuration Driven**: Agent capabilities, plan templates, and service configurations are managed externally.

## Architectural Overview

Manus consists of several core components:

*   **Orchestrator Agent**: The central "brain" that receives tasks, generates plans (via `PlanManager`), oversees plan execution (via `PlanExecutor`), manages the `CurrentWorkingContext` (CWC), and interacts with the Memory Bank.
*   **Worker Agents**: Specialized agents (e.g., `ResearchAgent`) that execute specific sub-tasks using their assigned tools.
*   **AI Services**: (`OpenAIService`, `GeminiService`) Provide access to Large Language Models for planning, synthesis, and other AI-driven operations.
*   **Tools**: Modules that perform specific actions (e.g., web search, file operations, fetching documentation).
*   **Memory Manager**: Manages the persistent "Memory Bank" for each task.
*   **Queues**: `SubTaskQueue` and `ResultsQueue` facilitate communication between the Orchestrator and worker agents.

For a detailed description of the architecture, component interactions, and data flows, please see [docs/architecture.md](docs/architecture.md).

## Quick Start

### Prerequisites

*   Node.js (v18.0.0 or higher recommended)
*   npm (usually comes with Node.js) or yarn
*   Access to AI service APIs (OpenAI, Google Gemini)
*   (Optional) A running instance of a Context7 MCP server for documentation fetching.

### Installation

1.  Clone the repository:
    ```bash
    git clone <your-repo-url>
    cd <repo-name>
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
    (or `yarn install`)

### Environment Configuration

Create a `.env` file in the root of the project by copying `.env.example` (if it exists) or creating a new one. Add the following necessary API keys and configurations:

```env
# Server Port
PORT=3000

# OpenAI API Key
OPENAI_API_KEY=your_openai_api_key_here

# Google Gemini API Key
GEMINI_API_KEY=your_gemini_api_key_here

# Google Custom Search Engine (for WebSearchTool)
SEARCH_API_KEY=your_google_search_api_key_here
CSE_ID=your_custom_search_engine_id_here

# Context7 MCP Server URL (optional, defaults to http://localhost:8080/mcp if not set)
# Ensure your Context7 server is running and accessible at this URL.
CONTEXT7_SERVER_URL=http://localhost:8080/mcp
```

**Note on Context7 Server:**
If you plan to use the `Context7DocumentationTool`, you need a running Context7 MCP server. You can run one locally:
```bash
npx -y @upstash/context7-mcp@latest --transport http --port 8080
```
Ensure the `CONTEXT7_SERVER_URL` in your `.env` file matches the URL of your running Context7 server.

### Running the Application

To start the Manus application server:
```bash
npm start
```
(This command might vary based on your `package.json` scripts. Check `scripts.start`.)

The server will typically start on the port specified in your `.env` file (default 3000).

## API Usage

The primary way to interact with Manus is through its HTTP API.

**Endpoint**: `POST /api/generate-plan`

This endpoint accepts a JSON body to define a task, specify an execution mode, and optionally choose an AI service.

**Request Parameters**:

*   `task` (string): The user's task description.
*   `mode` (string, optional): Execution mode (e.g., `EXECUTE_FULL_PLAN`, `PLAN_ONLY`). Defaults to `EXECUTE_FULL_PLAN`.
*   `aiService` (string, optional): AI service to use (`"openai"` or `"gemini"`). Defaults to `"openai"`.
*   `taskIdToLoad` (string, optional): ID of a saved task to resume or use.

**Example Request**:
```json
{
  "task": "Research the latest advancements in quantum computing and provide a summary.",
  "mode": "EXECUTE_FULL_PLAN",
  "aiService": "openai"
}
```

For detailed API documentation, including all modes, parameters, and response structures, please see [docs/api.md](docs/api.md).

## Project Structure

A brief overview of the main project directories:

*   `/agents`: Contains the logic for different types of agents (Orchestrator, Research, etc.).
*   `/config`: Holds configuration files like `agentCapabilities.json` and plan templates.
*   `/core`: Core components of the system, including `PlanManager`, `PlanExecutor`, `MemoryManager`, and queues.
*   `/docs`: Contains detailed documentation files.
*   `/locales`: JSON files for localization of console messages.
*   `/services`: External service integrations, including `Context7Client` and AI service clients (`BaseAIService`, `OpenAIService`, `GeminiService`).
*   `/tools`: Reusable tools that agents can use to perform actions.
*   `/utils`: Utility functions, including localization and task state management.
*   `index.js`: The main entry point for the application, sets up the server and initializes components.
*   `saved_tasks/`: Default directory where task states, journals, and memory banks are saved. (Should be in `.gitignore`)

## Contributing

(Details on how to contribute to the project, if applicable)

## License

(Project's license information, e.g., MIT)
