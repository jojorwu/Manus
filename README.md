# Gemini Powered AI Agent

## Overview

This project is a Node.js-based AI agent that leverages the Google Gemini API to understand tasks, generate multi-step execution plans, and execute those plans using a variety of tools. It currently features a Gemini execution tool for general reasoning and text generation, and a real Web Search tool powered by the Google Custom Search Engine API. The agent is designed to handle complex tasks by breaking them into stages, with the ability to execute steps within each stage in parallel. It maintains contextual memory between steps to ensure coherent task completion. Interaction with the agent is facilitated through a simple web interface.

## Key Features

*   **LLM-Driven Planning:** Uses Google Gemini to dynamically generate multi-step, multi-stage plans based on user tasks.
*   **Tool-Aware Execution:** Gemini determines which tool is appropriate for each step in the plan.
*   **Multi-Tool Architecture:**
    *   **GeminiStepExecutor:** For general reasoning, text generation, summarization, and executing complex instructions.
    *   **WebSearchTool:** For performing real-time web searches using the Google Custom Search Engine API to gather information.
*   **Staged and Parallel Execution:** Plans are structured into stages. Steps within the same stage can be executed in parallel, while subsequent stages depend on the completion of prior ones.
*   **Contextual Memory:** Information and results from completed steps are carried forward as context for subsequent steps, enabling more coherent and informed execution.
*   **Web Interface:** A simple browser-based UI for submitting tasks and viewing the agent's plan and execution log. (Note: A newer React-based frontend is under development in the `frontend/` directory).

## Technology Stack

*   **Backend:** Node.js, Express.js
*   **LLM:** Google Gemini API (via `@google/generative-ai`)
*   **Web Search:** Google Custom Search Engine (CSE) API (via `axios`)
*   **HTTP Client:** Axios
*   **Frontend (New):** React, Vite, Tailwind CSS, Shadcn/UI

## Setup and Installation

### Prerequisites

*   Node.js (v18.x or later recommended)
*   npm (usually comes with Node.js)

### Installation

1.  Clone this repository (if you haven't already).
2.  Navigate to the project directory.
3.  Install backend dependencies:
    ```bash
    npm install
    ```
4.  (Optional) For the new frontend, navigate to the `frontend` directory and install its dependencies:
    ```bash
    cd frontend
    npm install
    cd ..
    ```

### Environment Variables

Create a `.env` file in the root of the project directory or set the following environment variables in your system. These are crucial for the agent to function:

*   **`GEMINI_API_KEY`**: Your API key for the Google Gemini API.
    *   You can obtain this from Google AI Studio ([https://aistudio.google.com/](https://aistudio.google.com/)).
*   **`SEARCH_API_KEY`**: Your API key for the Google Custom Search Engine API.
    *   This key is obtained from the Google Cloud Console. You'll need to enable the "Custom Search API" for your project.
*   **`CSE_ID`**: Your Custom Search Engine ID.
    *   You can create a Custom Search Engine and get its ID from the CSE control panel ([https://programmablesearchengine.google.com/](https://programmablesearchengine.google.com/)). Ensure it's configured to search the web or the sites you intend for it to access.

**Example `.env` file:**
```
GEMINI_API_KEY="YOUR_GEMINI_API_KEY_HERE"
SEARCH_API_KEY="YOUR_GOOGLE_SEARCH_API_KEY_HERE"
CSE_ID="YOUR_CSE_ID_HERE"
```
*(Note: The application currently loads these directly via `process.env`. If you use a `.env` file, you might need to add a package like `dotenv` to your project and require it in `server.js` for it to be automatically loaded, e.g., `require('dotenv').config();` at the top of `server.js`. For simplicity in this project, we assume environment variables are set directly or `dotenv` is manually added if preferred.)*

## Running the Application

### Backend Server (Old UI)

1.  Ensure your environment variables are set correctly.
2.  Open your terminal in the project root directory.
3.  Run the server:
    ```bash
    node server.js
    ```
4.  The original application with the basic HTML interface will typically be accessible at `http://localhost:3000` in your web browser.

### New Frontend (React + Vite + Tailwind + Shadcn/UI)

This is a new, more advanced UI under development, located in the `frontend/` directory.

To run the new frontend development server:

1.  Navigate to the frontend directory:
    ```bash
    cd frontend
    ```
2.  Install dependencies (if you haven't already from the main setup, or if `frontend/package.json` changed):
    ```bash
    npm install
    ```
3.  Start the Vite development server:
    ```bash
    npm run dev
    ```
4.  The frontend will typically be available at `http://localhost:5173` (or another port indicated by Vite).
5.  **Note:** The backend server (`node server.js` run from the root directory) must also be running for the new frontend to eventually fetch data from its API endpoints (e.g., `/api/generate-plan`).

## How to Use (Old UI)

The instructions below apply to the original UI served from `http://localhost:3000` by `server.js`.

1.  Open your web browser and navigate to `http://localhost:3000`.
2.  You will see an input field labeled "Enter Task:".
3.  Type the task you want the AI agent to perform (e.g., "Research the history of AI and provide a summary", "What were the latest breakthroughs in AI in 2023 according to web search, and then summarize them?").
4.  Click the "Generate Plan and Execute" button (or similar, the button text might be "Generate Plan").
5.  The interface will display:
    *   Your original task.
    *   The multi-stage plan generated by Gemini, including the tool chosen for each step.
    *   A detailed execution log showing the outcome (result or error) for each step, grouped by stage.

```
