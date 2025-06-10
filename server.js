const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Added for Gemini
const app = express();
const port = 3000;

// Initialize GoogleGenerativeAI
const apiKey = process.env.GEMINI_API_KEY;
let genAI;
if (apiKey) {
  genAI = new GoogleGenerativeAI(apiKey);
} else {
  console.warn('GEMINI_API_KEY environment variable not set. Gemini functionality will be disabled.');
}

// Async helper function to call Gemini
async function callGemini(promptString) {
  if (!genAI) {
    // This case should ideally be caught before calling callGemini,
    // but as a safeguard within the function itself:
    throw new Error("Gemini API client not initialized. Check API key.");
  }
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const result = await model.generateContent(promptString);
    const response = await result.response;
    const text = response.text();
    return text;
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    // Re-throw or throw a new error to be caught by the caller
    throw new Error(`Error generating content from Gemini: ${error.message}`);
  }
}

// --- Tool Definition: WebSearchSimulatorTool ---
class WebSearchSimulatorTool {
  async execute(inputObject) {
    if (!inputObject || typeof inputObject.query !== 'string') {
      return { result: null, error: "Invalid input: query string is required." };
    }

    const originalQuery = inputObject.query;
    const query = originalQuery.toLowerCase();

    if (query.includes("history of ai") || query.includes("ai history")) {
      return {
        result: "Simulated Search Result: The history of AI dates back to antiquity, with philosophical roots. Modern AI began in the mid-20th century with pioneers like Alan Turing, John McCarthy, and Marvin Minsky. Key milestones include the Dartmouth Workshop, expert systems, machine learning, and deep learning breakthroughs.",
        error: null
      };
    } else if (query.includes("latest ai breakthroughs") || query.includes("recent ai news")) {
      return {
        result: "Simulated Search Result: Recent AI breakthroughs (as of early 2024) include advancements in large language models (LLMs) like GPT-4 and Gemini, generative AI for images and video, and applications in scientific discovery (e.g., protein folding). Ethical considerations and AI safety remain key discussion points.",
        error: null
      };
    } else if (query.includes("what is langgraph")) {
      return {
        result: "Simulated Search Result: LangGraph is a library for building stateful, multi-actor applications with LLMs. It allows developers to define agentic workflows as graphs, where nodes represent computations (often LLM calls or tool uses) and edges represent the flow of state.",
        error: null
      };
    } else {
      return {
        result: `Simulated Search Result: Your query '${originalQuery}' did not match any specific predefined results. This is a simulated search; in a real system, this would search the web.`,
        error: null
      };
    }
  }
}

// Middleware to parse JSON bodies and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the root directory (e.g., style.css)
app.use(express.static(__dirname));

// GET endpoint to serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Temporary GET route to test Gemini
app.get('/test-gemini', async (req, res) => {
  if (!genAI) {
    return res.status(500).send("Gemini API client not initialized. Check API key.");
  }
  const prompt = "Explain what a large language model is in one sentence.";
  try {
    const geminiResponse = await callGemini(prompt);
    res.send(geminiResponse);
  } catch (error) {
    // callGemini now throws, so catch it here
    res.status(500).send(`Error calling Gemini: ${error.message}`);
  }
});

// --- Helper Function 1: Generate Plan ---
async function generatePlanWithGemini(userTask, callGeminiFunc) {
  const tools = [
    { name: "GeminiStepExecutor", description: "Useful for general reasoning, text generation, complex instructions, or when no other specific tool seems appropriate." },
    { name: "WebSearchSimulator", description: "Useful for finding specific information, facts, or emulating a web search for a query." }
  ];

  const toolsDescriptionString = tools.map((tool, index) => `${index + 1}. ${tool.name}: ${tool.description}`).join("\n        ");
  const toolNamesArrayStringified = tools.map(tool => `"${tool.name}"`).join(", ");

  const planningPrompt = `User task: '${userTask}'.
You have the following tools available:
        ${toolsDescriptionString}

Break this down into a JSON array of objects to achieve the task. Each object must have two keys: 'stepDescription' (a string describing the action) and 'toolName' (a string: must be exactly one of [${toolNamesArrayStringified}]).
The steps should be logically sequenced.
Ensure the output is only the JSON array.
Example for a task like 'Research and summarize the discovery of Penicillin':
[
  { "stepDescription": "Search for the history of Penicillin discovery", "toolName": "WebSearchSimulator" },
  { "stepDescription": "Based on the search results, identify key scientists and dates.", "toolName": "GeminiStepExecutor" },
  { "stepDescription": "Draft a summary of the Penicillin discovery story.", "toolName": "GeminiStepExecutor" }
]`;
  let rawResponseFromGemini = "";

  try {
    const planResponseString = await callGeminiFunc(planningPrompt);
    rawResponseFromGemini = planResponseString;
    let cleanedPlanResponseString = planResponseString.trim();
    if (cleanedPlanResponseString.startsWith('```json')) {
      cleanedPlanResponseString = cleanedPlanResponseString.substring(7).trim();
    } else if (cleanedPlanResponseString.startsWith('```')) {
      cleanedPlanResponseString = cleanedPlanResponseString.substring(3).trim();
    }
    if (cleanedPlanResponseString.endsWith('```')) {
      cleanedPlanResponseString = cleanedPlanResponseString.slice(0, -3).trim();
    }

    const parsedPlan = JSON.parse(cleanedPlanResponseString);

    if (!Array.isArray(parsedPlan) || parsedPlan.length === 0) {
      console.error("Gemini generated an empty or non-array plan:", cleanedPlanResponseString);
      return { success: false, message: "Generated plan is empty or not an array.", details: "Gemini returned an empty or non-array plan.", rawResponse: cleanedPlanResponseString };
    }

    // Validate structure of each plan step
    for (const step of parsedPlan) {
      if (typeof step !== 'object' || step === null ||
          typeof step.stepDescription !== 'string' || !step.stepDescription.trim() ||
          typeof step.toolName !== 'string' || !step.toolName.trim()) {
        console.error("Invalid step structure in plan:", step, "Full plan:", cleanedPlanResponseString);
        return { success: false, message: "Generated plan contains invalid step structures.", details: "Each step must be an object with non-empty 'stepDescription' and 'toolName' strings.", rawResponse: cleanedPlanResponseString };
      }
      // Optional: Validate if step.toolName is one of the known tools
      if (!tools.find(t => t.name === step.toolName)) {
        console.warn("Plan contains a step with an unknown toolName:", step.toolName, "Step:", step);
        // For now, we'll allow unknown tool names and let execution handle it,
        // but one could return an error here if strict tool usage is required.
      }
    }

    return { success: true, plan: parsedPlan, rawResponse: null }; // Indicate success

  } catch (error) { // Catches errors from callGeminiFunc or JSON.parse
    console.error("Error in generatePlanWithGemini:", error);
    const isParsingError = error instanceof SyntaxError;
    const message = isParsingError ? "Failed to parse tool-aware plan from Gemini." : "Failed to generate tool-aware plan due to an API error.";
    return { success: false, message: message, details: error.message, rawResponse: rawResponseFromGemini };
  }
}

// --- Tool Definition: GeminiStepExecutorTool ---
class GeminiStepExecutorTool {
  constructor(callGeminiFunction) {
    this.callGemini = callGeminiFunction;
  }

  async execute(originalTask, stepDescription, contextSummary) {
    const executionPrompt = `Original task: '${originalTask}'.\n\nContext from previous completed steps:\n${contextSummary}\nConsidering the 'Original task' and the 'Context from previous completed steps', provide a concise output for successfully completing the current step: '${stepDescription}'. Focus only on the output for this specific step.`;

    try {
      const stepResultText = await this.callGemini(executionPrompt);
      return { result: stepResultText, error: null };
    } catch (error) {
      console.error(`Error executing step ("${stepDescription}") with GeminiStepExecutorTool:`, error);
      // Ensure the error message is propagated; callGemini now throws an Error object.
      return { result: null, error: error.message || "Unknown error during step execution." };
    }
  }
}

// --- Helper Function: Execute Plan Loop (with tool dispatch) ---
async function executePlanLoop(userTask, planArray, callGeminiFunc) {
  const executionLog = [];
  let contextSummaryForNextStep = "No previous steps executed yet.\n\n";

  // 1. Instantiate Tools
  const geminiExecutor = new GeminiStepExecutorTool(callGeminiFunc);
  const searchSimulator = new WebSearchSimulatorTool(); // Does not need callGeminiFunc
  const availableTools = {
    "GeminiStepExecutor": geminiExecutor,
    "WebSearchSimulator": searchSimulator
  };

  for (const planStep of planArray) { // planStep is an object: { stepDescription, toolName }
    const stepDescription = planStep.stepDescription;
    const toolName = planStep.toolName;

    // Validate planStep structure (already partially done in generatePlanWithGemini, but good for robustness)
    if (typeof stepDescription !== 'string' || !stepDescription.trim() ||
        typeof toolName !== 'string' || !toolName.trim()) {
      console.warn("Skipping invalid plan step object in executePlanLoop:", planStep);
      executionLog.push({
        step: String(stepDescription || "Invalid step object"),
        tool: String(toolName || "N/A"),
        error: "Invalid step object structure. Missing/empty stepDescription or toolName.",
        status: "skipped"
      });
      continue; // Skip this invalid step
    }

    // 2. Select Tool
    const selectedTool = availableTools[toolName];
    if (!selectedTool) {
      console.error(`Unknown tool specified in plan: ${toolName}`);
      executionLog.push({ step: stepDescription, tool: toolName, error: `Unknown tool specified: ${toolName}`, status: "failed" });
      break; // Terminate loop if tool is unknown, as plan execution cannot proceed reliably
    }

    // 3. Prepare Tool Input & Call Tool's execute Method
    let stepOutcome;
    try {
      if (toolName === "GeminiStepExecutor") {
        stepOutcome = await selectedTool.execute(userTask, stepDescription, contextSummaryForNextStep);
      } else if (toolName === "WebSearchSimulator") {
        stepOutcome = await selectedTool.execute({ query: stepDescription });
      } else {
        // This case should ideally be caught by the unknown tool check above
        console.error(`Tool execution logic not implemented for ${toolName} in executePlanLoop`);
        stepOutcome = { result: null, error: `Tool execution logic not implemented for ${toolName}` };
      }
    } catch (toolError) { // Catch errors if tool.execute() itself throws unexpectedly
        console.error(`Error during ${toolName}.execute():`, toolError);
        stepOutcome = { result: null, error: toolError.message || "An unexpected error occurred during tool execution."};
    }

    // 4. Update executionLog and contextSummaryForNextStep
    if (stepOutcome.error) {
      executionLog.push({ step: stepDescription, tool: toolName, error: stepOutcome.error, status: "failed" });
      break; // Terminate loop on first failure
    } else {
      executionLog.push({ step: stepDescription, tool: toolName, result: stepOutcome.result, status: "completed" });
      contextSummaryForNextStep += `Summary of step "${stepDescription}" (using ${toolName}): ${stepOutcome.result}\n\n`;
    }
  }
  return executionLog;
}

// --- Main API Endpoint ---
app.post('/api/generate-plan', async (req, res) => {
  const userTask = req.body.task;
  if (!userTask) {
    return res.status(400).json({ message: "Task is required in the request body.", context: { originalTask: userTask || null } });
  }
  if (!genAI) {
    return res.status(500).json({ message: "API client not initialized.", details: "Server configuration issue: GEMINI_API_KEY may be missing.", context: { originalTask: userTask } });
  }

  try {
    const planResult = await generatePlanWithGemini(userTask, callGemini);

    if (!planResult.success) { // Check the success flag
      return res.status(500).json({
        message: planResult.message || "Failed to generate plan.", // Use message from planResult
        details: planResult.details,
        context: { originalTask: userTask, rawResponse: planResult.rawResponse }
      });
    }
    const planArray = planResult.plan;

    const executionLog = await executePlanLoop(userTask, planArray, callGemini);

    res.json({
      originalTask: userTask,
      plan: planArray,
      executionLog: executionLog
    });

  } catch (unexpectedError) {
    console.error("Unexpected error in /api/generate-plan route handler:", unexpectedError);
    res.status(500).json({ message: "An unexpected server error occurred.", details: unexpectedError.message, context: { originalTask: userTask } });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
