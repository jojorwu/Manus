// services/LLMService.js

// require('dotenv').config(); // Решено, что dotenv конфигурируется в index.js

const geminiLLMService = async (prompt) => {
    console.log(`LLM Service called with prompt (first 100 chars): "${prompt.substring(0,100)}..."`);
    // GEMINI_API_KEY должен быть доступен из process.env
    if (!process.env.GEMINI_API_KEY) {
        const errorMsg = "GEMINI_API_KEY is not set in .env file. LLM service cannot operate.";
        console.error(errorMsg);
        throw new Error(errorMsg);
    }

    // Check if the prompt is for planning
    if (prompt.includes("create a multi-stage execution plan")) {
        // Attempt to extract userTaskString
        let userTaskString = "unknown task"; // Default
        const taskRegex = /User task: "([^"]+)"/;
        const taskMatch = prompt.match(taskRegex);
        if (taskMatch && taskMatch[1]) {
            userTaskString = taskMatch[1];
        } else {
            // Fallback for a slightly different prompt structure from OrchestratorAgent
            const orchestratorTaskRegex = /Original user task: '([^']+)'/;
            const orchestratorMatch = prompt.match(orchestratorTaskRegex);
            if (orchestratorMatch && orchestratorMatch[1]) {
                userTaskString = orchestratorMatch[1];
            } else {
                console.log("Could not extract userTaskString from prompt for planning.");
            }
        }

        console.log(`Extracted userTaskString for planning: "${userTaskString}"`);

        if (userTaskString.toLowerCase().includes("weather")) {
            const weatherPlan = [
                [
                    {
                        "assigned_agent_role": "ResearchAgent",
                        "tool_name": "WebSearchTool",
                        "sub_task_input": { "query": userTaskString }, // Use extracted task directly
                        "narrative_step": `Search for ${userTaskString}.`
                    }
                ]
            ];
            return JSON.stringify(weatherPlan);
        } else if (userTaskString.toLowerCase().includes("calculate") || userTaskString.match(/\d+\s*[\+\-\*\/]\s*\d+/)) {
            const calculatorPlan = [
                [
                    {
                        "assigned_agent_role": "UtilityAgent",
                        "tool_name": "CalculatorTool",
                        "sub_task_input": { "expression": userTaskString }, // Use extracted task directly
                        "narrative_step": `Calculate the expression '${userTaskString}'.`
                    }
                ]
            ];
            return JSON.stringify(calculatorPlan);
        } else if (userTaskString !== "unknown task") {
            const generalPlan = [
                [
                    {
                        "assigned_agent_role": "ResearchAgent",
                        "tool_name": "WebSearchTool",
                        "sub_task_input": { "query": `general information on ${userTaskString}` },
                        "narrative_step": `Perform a general web search based on the user task: "${userTaskString}".`
                    }
                ]
            ];
            return JSON.stringify(generalPlan);
        } else {
            // Fallback to an empty plan if userTaskString is still "unknown task"
            console.log("Returning empty plan as fallback.");
            return "[]";
        }
    } else {
        // This is a synthesis request
        let originalUserTask = "the user's request"; // Default
        const synthesisTaskRegex = /The original user task was: '([^']+)'/;
        const synthesisMatch = prompt.match(synthesisTaskRegex);
        if (synthesisMatch && synthesisMatch[1]) {
            originalUserTask = synthesisMatch[1];
        } else {
            console.log("Could not extract original user task from prompt for synthesis.");
        }

        // Simulate a result based on the task type if possible, otherwise generic
        let simulatedResult = "a simulated result";
        if (originalUserTask.toLowerCase().includes("weather")) {
            simulatedResult = "The weather is sunny with a chance of rain (simulated).";
        } else if (originalUserTask.toLowerCase().includes("calculate") || originalUserTask.match(/\d+\s*[\+\-\*\/]\s*\d+/)) {
            // Super simple eval for stub, NOT for production
            try {
                // Basic sanitization to prevent arbitrary code execution, though still risky
                const sanitizedExpression = originalUserTask.replace(/[^-()\d/*+.]/g, '');
                if (sanitizedExpression) {
                   // Using a safer way to evaluate simple math expressions
                   // This is still a stub and not a full secure calculator
                   if (sanitizedExpression.includes('+')) {
                       const parts = sanitizedExpression.split('+');
                       simulatedResult = (parseFloat(parts[0]) + parseFloat(parts[1])).toString();
                   } else if (sanitizedExpression.includes('-')) {
                       const parts = sanitizedExpression.split('-');
                       simulatedResult = (parseFloat(parts[0]) - parseFloat(parts[1])).toString();
                   } else if (sanitizedExpression.includes('*')) {
                       const parts = sanitizedExpression.split('*');
                       simulatedResult = (parseFloat(parts[0]) * parseFloat(parts[1])).toString();
                   } else if (sanitizedExpression.includes('/')) {
                       const parts = sanitizedExpression.split('/');
                       const divisor = parseFloat(parts[1]);
                       if (divisor === 0) simulatedResult = "Error: Division by zero (simulated)";
                       else simulatedResult = (parseFloat(parts[0]) / divisor).toString();
                   } else {
                       simulatedResult = "Result of calculation (simulated).";
                   }
                } else {
                    simulatedResult = "Invalid expression for calculation (simulated).";
                }
            } catch (e) {
                console.error("Error evaluating expression for simulation:", e);
                simulatedResult = "Error in calculation (simulated).";
            }
        }

        return `Based on the execution, the answer to '${originalUserTask}' is ${simulatedResult}.`;
    }
};

module.exports = geminiLLMService;
