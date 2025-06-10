const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Added for Gemini
const axios = require('axios'); // Added for WebSearchTool
const math = require('mathjs'); // Added for CalculatorTool
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
const GEMINI_TIMEOUT_DURATION = 20000; // 20 seconds

async function callGemini(promptString) {
  if (!genAI) {
    throw new Error("Gemini API client not initialized. Check API key.");
  }

  let timeoutId; // For clearing timeout if Gemini finishes first
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Gemini API call timed out after ${GEMINI_TIMEOUT_DURATION / 1000} seconds.`));
    }, GEMINI_TIMEOUT_DURATION);
  });

  try {
    const geminiPromise = genAI.getGenerativeModel({ model: "gemini-pro" }).generateContent(promptString);

    const raceResult = await Promise.race([
      geminiPromise,
      timeoutPromise
    ]);

    clearTimeout(timeoutId); // Clear the timeout as Gemini call completed

    // If timeoutPromise did not win, raceResult is the result from geminiPromise
    const response = await raceResult.response; // This line might fail if raceResult is from a timeout (it wouldn't have .response)
                                             // However, Promise.race ensures only one promise (the first to settle) provides its result/rejection.
                                             // If timeout wins, it rejects, and execution goes to catch.
    const text = response.text();
    return text;

  } catch (error) {
    clearTimeout(timeoutId); // Ensure timeout is cleared on any error too
    console.error("Error calling Gemini API or timed out:", error.message);
    // Check if it's our specific timeout error
    if (error.message.includes("Gemini API call timed out")) {
      throw error; // Re-throw the timeout error as is
    }
    // For other errors (actual API errors, etc.)
    throw new Error(`Error generating content from Gemini: ${error.message}`);
  }
}

// --- Tool Definition: CalculatorTool ---
class CalculatorTool {
  async execute(inputObject) {
    if (!inputObject || typeof inputObject.expression !== 'string' || !inputObject.expression.trim()) {
      return { result: null, error: "Invalid input: expression string is required for CalculatorTool." };
    }

    try {
      const calculationResult = math.evaluate(inputObject.expression);

      // Check if the result is a function (e.g., from defining a function like 'f(x) = x^2')
      // or if it's an object that might not be directly usable as a simple "result" (e.g. a matrix)
      // For now, we'll specifically check for functions. More complex objects might need specific handling if encountered.
      if (typeof calculationResult === 'function') {
        return { result: null, error: "Calculation error: Expression resulted in a function, not a direct value. Please provide a calculable expression that yields a number, string, or boolean." };
      }

      // Ensure the result is stringified for consistent output.
      return { result: String(calculationResult), error: null };
    } catch (e) {
      console.error(`CalculatorTool error for expression "${inputObject.expression}":`, e.message);
      return { result: null, error: "Calculation error: " + e.message };
    }
  }
}

// --- Tool Definition: WebSearchTool ---
class WebSearchTool {
  constructor() {
    this.apiKey = process.env.SEARCH_API_KEY;
    this.cseId = process.env.CSE_ID;

    if (!this.apiKey || !this.cseId) {
      console.warn("WebSearchTool: SEARCH_API_KEY or CSE_ID environment variable is missing. Web searches will fail.");
    }
  }

  async execute({ query }) { // Destructure query from input object
    if (!this.apiKey || !this.cseId) {
      return { result: null, error: "WebSearchTool is not configured due to missing API key or CSE ID." };
    }
    if (!query || typeof query !== 'string' || !query.trim()) {
        return { result: null, error: "Invalid input: query string is required for WebSearchTool." };
    }

    const searchUrl = 'https://www.googleapis.com/customsearch/v1';
    const params = {
      key: this.apiKey,
      cx: this.cseId,
      q: query,
      num: 5 // Get up to 5 results
    };

    try {
      const response = await axios.get(searchUrl, { params: params, timeout: 8000 }); // Added timeout: 8000ms

      if (response.data && response.data.items && response.data.items.length > 0) {
        const formattedResults = response.data.items
          .map(item => `Title: ${item.title}\nSnippet: ${item.snippet}\n\n`)
          .join('');
        return { result: formattedResults.trim(), error: null };
      } else if (response.data && response.data.error) {
        console.error('Google Search API Error:', response.data.error);
        return { result: null, error: `Google Search API Error: ${response.data.error.message || 'Unknown API error'}` };
      } else {
        return { result: "No search results found.", error: null };
      }
    } catch (error) {
      console.error('Error fetching web search results:', error.message);
      if (error.code === 'ECONNABORTED' || (error.message && error.message.toLowerCase().includes('timeout'))) {
        return { result: null, error: "Web search request timed out after 8 seconds." };
      } else if (error.response && error.response.data && error.response.data.error) {
        // Handle errors returned by the Google API itself (e.g., bad API key, quota exceeded)
        return { result: null, error: `Google Search API Error: ${error.response.data.error.message || 'Failed to fetch search results due to API error'}` };
      }
      return { result: null, error: `Failed to fetch search results: ${error.message}` };
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
    { name: "WebSearchTool", description: "Useful for finding specific, real-time information or facts from the web. Input should be a search query." },
    { name: "CalculatorTool", description: "Useful for evaluating mathematical expressions. Input should be a valid mathematical expression string (e.g., '2+2', 'sqrt(16)', '10 meters to cm')." }
  ];

  const toolsDescriptionString = tools.map((tool, index) => `${index + 1}. ${tool.name}: ${tool.description}`).join("\n        ");
  const toolNamesArrayStringified = tools.map(tool => `"${tool.name}"`).join(", "); // This will now include "WebSearchTool"

  const planningPrompt = `User task: '${userTask}'.
You have the following tools available:
        ${toolsDescriptionString}

Break this down into a JSON array of 'stages' to achieve the task. Each stage object in the array must have two keys:
1. 'stage': An integer representing the stage number (e.g., 1, 2, 3...).
2. 'steps': An array of one or more step objects.
Each step object within a stage's 'steps' array must have two keys:
1. 'stepDescription': A string describing the action for that step.
2. 'toolName': A string indicating which tool to use (must be exactly one of [${toolNamesArrayStringified}]).

Steps within the same stage are considered parallelizable if the task allows. Subsequent stages depend on the completion of all steps in the preceding stage.
The overall plan should be logically sequenced by stage. Ensure the output is only the JSON array of stages.

Example for a task like 'Research impacts of remote work and summarize findings':
[
  {
    "stage": 1,
    "steps": [
      { "stepDescription": "Search for articles on productivity in remote work", "toolName": "WebSearchTool" }, // Updated example
      { "stepDescription": "Search for articles on team collaboration in remote work", "toolName": "WebSearchTool" } // Updated example
    ]
  },
  {
    "stage": 2,
    "steps": [
      { "stepDescription": "Based on all search results, identify 3 key positive and 3 key negative impacts of remote work.", "toolName": "GeminiStepExecutor" }
    ]
  },
  {
    "stage": 3,
    "steps": [
      { "stepDescription": "Draft a concise summary of the identified impacts.", "toolName": "GeminiStepExecutor" }
    ]
  }
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

    const parsedPlanStages = JSON.parse(cleanedPlanResponseString);

    if (!Array.isArray(parsedPlanStages) || parsedPlanStages.length === 0) {
      console.error("Gemini generated an empty or non-array plan (expected array of stages):", cleanedPlanResponseString);
      return { success: false, message: "Generated plan is empty or not an array of stages.", details: "Gemini returned an empty or non-array plan.", rawResponse: cleanedPlanResponseString };
    }

    // Validate structure of each stage and its steps
    for (const stageObj of parsedPlanStages) {
      if (typeof stageObj !== 'object' || stageObj === null ||
          typeof stageObj.stage !== 'number' ||
          !Array.isArray(stageObj.steps) || stageObj.steps.length === 0) {
        console.error("Invalid stage structure in plan:", stageObj, "Full plan:", cleanedPlanResponseString);
        return { success: false, message: "Generated plan contains an invalid stage structure.", details: "Each stage must be an object with a numeric 'stage' and a non-empty 'steps' array.", rawResponse: cleanedPlanResponseString };
      }

      for (const step of stageObj.steps) {
        if (typeof step !== 'object' || step === null ||
            typeof step.stepDescription !== 'string' || !step.stepDescription.trim() ||
            typeof step.toolName !== 'string' || !step.toolName.trim()) {
          console.error("Invalid step structure within a stage:", step, "Stage:", stageObj.stage, "Full plan:", cleanedPlanResponseString);
          return { success: false, message: "Generated plan contains invalid step structures within a stage.", details: "Each step must be an object with non-empty 'stepDescription' and 'toolName' strings.", rawResponse: cleanedPlanResponseString };
        }
        if (!tools.find(t => t.name === step.toolName)) {
          console.warn("Plan contains a step with an unknown toolName:", step.toolName, "Step:", step);
        }
      }
    }

    return { success: true, plan: parsedPlanStages, rawResponse: null }; // Indicate success

  } catch (error) { // Catches errors from callGeminiFunc (which now throws on API/timeout error) or JSON.parse
    console.error("Error in generatePlanWithGemini (staged planning):", error.message);
    if (error.message.includes("Gemini API call timed out")) {
      return {
        success: false,
        message: "Failed to generate plan: Gemini API call timed out.",
        details: error.message,  // The specific timeout message from callGemini
        rawResponse: rawResponseFromGemini // This might be empty if timeout occurred before Gemini responded
      };
    }
    // Differentiate between parsing error (if Gemini responded but with bad JSON) vs. other API errors
    const isParsingError = error instanceof SyntaxError;
    const message = isParsingError ? "Failed to parse tool-aware plan from Gemini." : "Failed to generate tool-aware plan due to an API error.";
    // If it's not a parsing error, rawResponseFromGemini might not be set if callGeminiFunc failed before returning a response string.
    // error.message would be more relevant for details in that case.
    return {
      success: false,
      message: message,
      details: error.message,
      rawResponse: isParsingError ? rawResponseFromGemini : null // Only include rawResponse if it was a parsing issue
    };
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

// --- Helper Function: Execute Plan Loop (with staged parallel execution) ---
async function executePlanLoop(userTask, planStagesArray, callGeminiFunc) {
  const overallExecutionLog = [];
  let contextSummaryForNextStep = "No previous steps executed yet.\n\n";

  const geminiExecutor = new GeminiStepExecutorTool(callGeminiFunc);
  const webSearchTool = new WebSearchTool();
  const calculatorTool = new CalculatorTool(); // Instantiate CalculatorTool
  const availableTools = {
    "GeminiStepExecutor": geminiExecutor,
    "WebSearchTool": webSearchTool,
    "CalculatorTool": calculatorTool // Add CalculatorTool to available tools
  };

  // Outer loop for stages
  for (const stageObj of planStagesArray) {
    const currentStageNumber = stageObj.stage;
    const stepsInStage = stageObj.steps;
    let stageFailed = false;

    if (!Array.isArray(stepsInStage) || stepsInStage.length === 0) {
      console.warn(`Stage ${currentStageNumber} has no steps or invalid steps array. Skipping.`);
      // Optionally log this as a skipped/empty stage in overallExecutionLog if desired
      continue;
    }

    // 3. Parallel Execution of Steps within a Stage
    const stepPromises = stepsInStage.map(async (planStep) => {
      const stepDescription = planStep.stepDescription;
      const toolName = planStep.toolName;

      // Validate individual planStep structure
      if (typeof stepDescription !== 'string' || !stepDescription.trim() ||
          typeof toolName !== 'string' || !toolName.trim()) {
        console.warn("Skipping invalid plan step object in stage:", planStep);
        return {
          originalStep: { stepDescription: String(stepDescription || "Invalid step"), toolName: String(toolName || "N/A") },
          outcome: { error: "Invalid step object structure. Missing/empty stepDescription or toolName." },
          success: false
        };
      }

      const selectedTool = availableTools[toolName];
      if (!selectedTool) {
        console.error(`Unknown tool specified in plan: ${toolName} for step: "${stepDescription}"`);
        return {
          originalStep: planStep,
          outcome: { error: `Unknown tool specified: ${toolName}` },
          success: false
        };
      }

      let currentStepOutcome;
      try {
        if (toolName === "GeminiStepExecutor") {
          currentStepOutcome = await selectedTool.execute(userTask, stepDescription, contextSummaryForNextStep);
        } else if (toolName === "WebSearchTool") {
          currentStepOutcome = await selectedTool.execute({ query: stepDescription });
        } else if (toolName === "CalculatorTool") {
          currentStepOutcome = await selectedTool.execute({ expression: stepDescription }); // Pass expression for CalculatorTool
        } else {
          console.error(`Attempted to execute unhandled tool: ${toolName}`);
          currentStepOutcome = { result: null, error: `Unhandled tool: ${toolName}` };
        }
        return { originalStep: planStep, outcome: currentStepOutcome, success: !currentStepOutcome.error };
      } catch (toolError) {
        console.error(`Error during ${toolName}.execute() for step "${stepDescription}":`, toolError);
        return {
          originalStep: planStep,
          outcome: { error: toolError.message || "An unexpected error occurred during tool execution." },
          success: false
        };
      }
    });

    // Wait for all steps in the current stage to complete (or fail individually)
    const stageStepResults = await Promise.all(stepPromises);

    // 4. Handling Results and Context from Parallel Stage
    let stageContextAccumulator = ""; // Accumulate context from successful steps in this stage

    for (const stepResult of stageStepResults) {
      const { originalStep, outcome, success } = stepResult;
      const logEntry = {
        stage: currentStageNumber,
        step: originalStep.stepDescription,
        tool: originalStep.toolName,
        status: success ? "completed" : "failed",
        result: success ? outcome.result : null,
        error: success ? null : outcome.error,
      };
      overallExecutionLog.push(logEntry);

      if (success) {
        stageContextAccumulator += `Result from Stage ${currentStageNumber}, Step "${originalStep.stepDescription}" (using ${originalStep.toolName}): ${outcome.result}\n\n`;
      } else {
        stageFailed = true;
      }
    }

    // Append all context from this stage to the main context summary *after* all parallel steps are processed
    if (stageContextAccumulator) {
        contextSummaryForNextStep += stageContextAccumulator;
    }

    if (stageFailed) {
      console.log(`Stage ${currentStageNumber} failed. Terminating further plan execution.`);
      break; // Terminate outer loop for stages
    }
  }
  return overallExecutionLog;
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
