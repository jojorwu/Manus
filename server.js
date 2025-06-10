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
  const planningPrompt = `User task: '${userTask}'. Break this down into a JSON array of short, actionable, and logically sequenced steps to achieve the task. The steps should be granular enough to be executed one by one. The output should be only the JSON array. For example, for 'Research the history of the internet', steps might be: ["Define scope of research", "Identify key milestones", "Find primary sources for early development", "Summarize findings into a timeline"].`;
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

    const planArray = JSON.parse(cleanedPlanResponseString);

    if (!Array.isArray(planArray) || planArray.length === 0) {
      console.error("Gemini generated an empty or invalid plan array:", cleanedPlanResponseString);
      return { success: false, message: "Generated plan is empty or invalid.", details: "Gemini returned an empty or invalid plan array.", rawResponse: cleanedPlanResponseString };
    }
    return { success: true, plan: planArray, rawResponse: null }; // Indicate success

  } catch (error) { // Catches errors from callGeminiFunc or JSON.parse
    console.error("Error in generatePlanWithGemini:", error);
    // Determine if the error is from parsing or from the API call itself
    const isParsingError = error instanceof SyntaxError;
    const message = isParsingError ? "Failed to parse plan from Gemini." : "Failed to generate plan due to an API error.";
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

// --- Helper Function: Execute Plan Loop (now uses the tool) ---
async function executePlanLoop(userTask, planArray, callGeminiFunc) {
  const executionLog = [];
  let contextSummaryForNextStep = "No previous steps executed yet.\n\n";
  const stepExecutor = new GeminiStepExecutorTool(callGeminiFunc); // Instantiate the tool

  for (const stepDescription of planArray) {
    if (typeof stepDescription !== 'string' || !stepDescription.trim()) {
      console.warn("Skipping invalid step in plan:", stepDescription);
      executionLog.push({ step: String(stepDescription), error: "Invalid step description in plan.", status: "skipped" });
      continue;
    }

    // Call the tool's execute method
    const stepOutcome = await stepExecutor.execute(userTask, stepDescription, contextSummaryForNextStep);

    if (stepOutcome.error) {
      executionLog.push({ step: stepDescription, error: stepOutcome.error, status: "failed" });
      break;
    } else {
      executionLog.push({ step: stepDescription, result: stepOutcome.result, status: "completed" });
      contextSummaryForNextStep += `Summary of step "${stepDescription}": ${stepOutcome.result}\n\n`;
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
