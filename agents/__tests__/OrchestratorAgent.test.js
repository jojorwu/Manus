const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const OrchestratorAgent = require('../OrchestratorAgent');
const { ExecutionModes, TaskStatuses } = require('../../core/constants');

// --- Mock Dependencies ---
jest.mock('fs');
jest.mock('ajv'); // Mock Ajv for schema validation control

// Mock Queues
const mockSubTaskQueue = { enqueueTask: jest.fn() };
const mockResultsQueue = { subscribeOnce: jest.fn() };

// Mock LLM Service
const mockLlmService = jest.fn();

// Mock agentApiKeysConfig
const mockAgentApiKeysConfig = {};

// Mock Schemas (actual schema content isn't crucial, just that they are required)
const mockAgentCapabilitiesSchema = { type: "array", items: {} };
const mockPlanTemplateSchema = { type: "object", properties: {} };
const mockOrchestratorConfigSchema = { type: "object", properties: {} }; // If we were to validate it

// Store original console methods
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;


describe('OrchestratorAgent', () => {
  let mockAjvInstance;
  let mockValidateFunction;

  beforeEach(() => {
    // Reset all mocks
    fs.readFileSync.mockReset();
    fs.existsSync.mockReset();
    fs.readdirSync.mockReset(); // For plan templates
    mockLlmService.mockReset();
    mockSubTaskQueue.enqueueTask.mockReset();
    mockResultsQueue.subscribeOnce.mockReset();

    // Setup Ajv mock for each test
    mockValidateFunction = jest.fn();
    mockAjvInstance = {
      compile: jest.fn().mockReturnValue(mockValidateFunction),
      errorsText: jest.fn().mockReturnValue('mocked ajv validation error'),
    };
    Ajv.mockImplementation(() => mockAjvInstance);

    // Suppress console output during tests, can be enabled for debugging
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();

    // Mock that schema files can be required
    jest.mock('../../schemas/agentCapabilitiesSchema.json', () => mockAgentCapabilitiesSchema, { virtual: true });
    jest.mock('../../schemas/planTemplateSchema.json', () => mockPlanTemplateSchema, { virtual: true });
  });

  afterEach(() => {
    // Restore console output
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    jest.resetAllMocks(); // Ensure mocks are clean for the next test suite if any
  });

  describe('Constructor and Configuration Loading', () => {
    // --- Orchestrator Config Loading ---
    it('should load orchestratorConfig.json successfully', () => {
      const validOrchestratorConfig = { maxDataLengthForSummarization: 2000 };
      fs.existsSync.mockImplementation(filePath => filePath.endsWith('orchestratorConfig.json'));
      fs.readFileSync.mockImplementation(filePath => {
        if (filePath.endsWith('orchestratorConfig.json')) return JSON.stringify(validOrchestratorConfig);
        if (filePath.endsWith('agentCapabilities.json')) return '[]'; // Default for other files
        return '';
      });
      mockValidateFunction.mockReturnValue(true); // Assume capabilities schema validation passes

      const agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
      expect(agent.config.maxDataLengthForSummarization).toBe(2000);
    });

    it('should use default orchestrator config if file not found', () => {
      fs.existsSync.mockReturnValue(false); // All files appear not to exist
      mockValidateFunction.mockReturnValue(true);

      const agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
      expect(agent.config.maxDataLengthForSummarization).toBe(1000); // Default value
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to load orchestratorConfig.json'));
    });

    it('should use default orchestrator config for invalid JSON', () => {
      fs.existsSync.mockImplementation(filePath => filePath.endsWith('orchestratorConfig.json') || filePath.endsWith('agentCapabilities.json'));
      fs.readFileSync.mockImplementation(filePath => {
        if (filePath.endsWith('orchestratorConfig.json')) return '{"invalid":json';
        if (filePath.endsWith('agentCapabilities.json')) return '[]';
        return '';
      });
      mockValidateFunction.mockReturnValue(true);

      const agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
      expect(agent.config.maxDataLengthForSummarization).toBe(1000);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to load orchestratorConfig.json'));
    });

    // --- Agent Capabilities Loading ---
    it('loadCapabilities should load and validate capabilities successfully', () => {
      const validCapabilities = [{ role: 'TestRole', tools: [] }];
      fs.existsSync.mockImplementation(filePath => filePath.endsWith('agentCapabilities.json'));
      fs.readFileSync.mockReturnValue(JSON.stringify(validCapabilities));
      mockValidateFunction.mockReturnValue(true);

      const agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
      expect(agent.workerAgentCapabilities).toEqual(validCapabilities);
      expect(mockAjvInstance.compile).toHaveBeenCalledWith(mockAgentCapabilitiesSchema);
      expect(mockValidateFunction).toHaveBeenCalledWith(validCapabilities);
    });

    it('loadCapabilities should return empty array if capabilities file not found', () => {
      fs.existsSync.mockReturnValue(false); // No capabilities file
      const agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
      expect(agent.workerAgentCapabilities).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to load worker capabilities'));
    });

    it('loadCapabilities should return empty array for invalid JSON in capabilities file', () => {
      fs.existsSync.mockImplementation(filePath => filePath.endsWith('agentCapabilities.json'));
      fs.readFileSync.mockReturnValue('{"invalid":json');
      const agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
      expect(agent.workerAgentCapabilities).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to load worker capabilities'));
    });

    it('loadCapabilities should return empty array if schema validation fails', () => {
      const invalidCapabilities = [{ role: 'TestRole' }]; // Missing 'tools'
      fs.existsSync.mockImplementation(filePath => filePath.endsWith('agentCapabilities.json'));
      fs.readFileSync.mockReturnValue(JSON.stringify(invalidCapabilities));
      mockValidateFunction.mockReturnValue(false); // Schema validation fails

      const agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
      expect(agent.workerAgentCapabilities).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error validating agent capabilities'));
      expect(mockAjvInstance.errorsText).toHaveBeenCalled();
    });

    // --- Plan Templates Loading ---
    it('loadPlanTemplates should load and validate templates successfully', () => {
      const templateFiles = ['template1.json'];
      const validTemplate = { name: 'T1', description: 'Valid Template', steps: [] };
      fs.existsSync.mockImplementation(filePath => {
        if (filePath.endsWith('plan_templates')) return true; // Directory exists
        if (filePath.includes('template1.json')) return true; // Template file exists
        if (filePath.endsWith('agentCapabilities.json')) return true; // For constructor
        return false;
      });
      fs.readdirSync.mockReturnValue(templateFiles);
      fs.readFileSync.mockImplementation(filePath => {
        if (filePath.includes('template1.json')) return JSON.stringify(validTemplate);
        if (filePath.endsWith('agentCapabilities.json')) return '[]'; // Default for capabilities
        return '';
      });
      mockValidateFunction.mockReturnValue(true); // Schema validation passes for templates

      const agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);

      // templateDefinitions is hardcoded in OrchestratorAgent, so we check if it tried to load based on that
      // This test needs to align with how templateDefinitions is structured in OrchestratorAgent or make it configurable.
      // For now, assuming it tries to load template1.json if it were in templateDefinitions.
      // A better approach would be to mock templateDefinitions or make it part of the test setup.
      // Given the current OrchestratorAgent structure, we'll assume templateDefinitions might not match 'template1.json' exactly.
      // Let's test based on the hardcoded ones: "weather_query_template.json" and "calculator_template.json"

      // Resetting mocks for a more focused template test
      fs.readdirSync.mockReturnValue(['weather_query_template.json', 'calculator_template.json']);
      fs.readFileSync.mockReset(); // Clear previous general mocks
      fs.existsSync.mockImplementation(filePath => true); // Assume all relevant files exist for this test

      const weatherTemplate = { name: "weather_query", description: "Weather", steps: [{id:"s1", action:"a", agent:"b", inputs:{}}]};
      const calculatorTemplate = { name: "calculator", description: "Calc", steps: [{id:"s1", action:"a", agent:"b", inputs:{}}]};

      fs.readFileSync.mockImplementation(filePath => {
        if (filePath.endsWith('weather_query_template.json')) return JSON.stringify(weatherTemplate);
        if (filePath.endsWith('calculator_template.json')) return JSON.stringify(calculatorTemplate);
        if (filePath.endsWith('agentCapabilities.json')) return '[]';
        if (filePath.endsWith('orchestratorConfig.json')) return '{}';
        return '';
      });
      mockValidateFunction.mockReturnValue(true); // All templates valid

      const agentWithTemplates = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
      expect(agentWithTemplates.planTemplates.has('weather_query')).toBe(true);
      expect(agentWithTemplates.planTemplates.get('weather_query').template).toEqual(weatherTemplate);
      expect(agentWithTemplates.planTemplates.has('calculator')).toBe(true);
      expect(mockAjvInstance.compile).toHaveBeenCalledWith(mockPlanTemplateSchema); // Called for each template
      expect(mockValidateFunction).toHaveBeenCalledTimes(2 + 1); // +1 for capabilities
    });

    it('loadPlanTemplates should skip template if schema validation fails', () => {
        fs.existsSync.mockImplementation(_ => true); // All files exist
        fs.readdirSync.mockReturnValue(['invalid_template.json']);
        fs.readFileSync.mockImplementation(filePath => {
            if (filePath.includes('invalid_template.json')) return JSON.stringify({ name: 'Invalid', description: 'No steps' });
            if (filePath.endsWith('agentCapabilities.json')) return '[]';
             if (filePath.endsWith('orchestratorConfig.json')) return '{}';
            return '';
        });
        // First call to validate (capabilities) is true, second (template) is false
        mockValidateFunction.mockReturnValueOnce(true).mockReturnValueOnce(false);

        const agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
        // Assuming templateDefinitions in OrchestratorAgent is updated to try and load 'invalid_template.json'
        // This part of the test is brittle if templateDefinitions is hardcoded and not matching.
        // To make it robust, OrchestratorAgent.templateDefinitions would need to be dynamic or mocked.
        // For this test, let's assume templateDefinitions is `[{name: "invalid", fileName: "invalid_template.json", ...}]`
        // The current OrchestratorAgent loads predefined templates. This test needs to reflect that.

        // Let's test with one valid and one invalid from the predefined list
        fs.readdirSync.mockReturnValue(['weather_query_template.json', 'calculator_template.json']);
        const weatherTemplate = { name: "weather_query", description: "Weather", steps: [{id:"s1", action:"a", agent:"b", inputs:{}}]};
        // Calculator template will be made invalid by mockValidateFunction
        fs.readFileSync.mockImplementation(filePath => {
            if (filePath.endsWith('weather_query_template.json')) return JSON.stringify(weatherTemplate);
            if (filePath.endsWith('calculator_template.json')) return JSON.stringify({name: "calculator", description:"Calc", steps:[]}); // valid structure for parsing
            if (filePath.endsWith('agentCapabilities.json')) return '[]';
            if (filePath.endsWith('orchestratorConfig.json')) return '{}';
            return '';
        });

        // Capabilities valid, weather_query valid, calculator invalid
        mockValidateFunction.mockReset(); // Clear previous call counts
        mockValidateFunction.mockReturnValueOnce(true) // capabilities
                           .mockReturnValueOnce(true) // weather_query
                           .mockReturnValueOnce(false); // calculator

        const agentWithMixedTemplates = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
        expect(agentWithMixedTemplates.planTemplates.has('weather_query')).toBe(true);
        expect(agentWithMixedTemplates.planTemplates.has('calculator')).toBe(false); // Should be skipped
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('failed validation'));
        expect(mockAjvInstance.errorsText).toHaveBeenCalled();
    });

    it('loadPlanTemplates should handle templates directory not found', () => {
        fs.existsSync.mockImplementation(filePath => {
            if (filePath.endsWith('plan_templates')) return false; // Dir does not exist
            return true; // Other config files exist
        });
        fs.readFileSync.mockImplementation(filePath => { // Ensure other files can be "read"
            if (filePath.endsWith('agentCapabilities.json')) return '[]';
            if (filePath.endsWith('orchestratorConfig.json')) return '{}';
            return '';
        });
        mockValidateFunction.mockReturnValue(true);


        const agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
        expect(agent.planTemplates.size).toBe(0);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Plan templates directory not found'));
    });

  });

  describe('tryGetPlanFromTemplate', () => {
    let agent;
    const mockWeatherTemplate = {
        name: "weather_query",
        regex: /weather in (.*)/i, // Simplified regex for testing
        paramMapping: { CITY_NAME: 1 },
        template: {
            name: "weather_query",
            description: "Get weather for {{CITY_NAME}}",
            steps: [{ id: "s1", action: "get_weather", agent: "ResearchAgent", inputs: { city: "{{CITY_NAME}}" } }]
        }
    };

    beforeEach(() => {
      // Setup agent with a known template
      fs.existsSync.mockReturnValue(true); // Assume all config files exist
      fs.readFileSync.mockImplementation(filePath => {
        if (filePath.endsWith('agentCapabilities.json')) return '[]';
        if (filePath.endsWith('orchestratorConfig.json')) return '{}';
        if (filePath.endsWith('weather_query_template.json')) return JSON.stringify(mockWeatherTemplate.template);
        return '';
      });
      fs.readdirSync.mockReturnValue(['weather_query_template.json']);
      mockValidateFunction.mockReturnValue(true); // All schemas are valid

      // Mock the templateDefinitions directly in the agent instance for predictable testing
      // This is a common strategy if the internal structure is hard to mock via fs alone.
      // However, OrchestratorAgent loads this internally. We rely on the fs mocks.
      agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
      // Manually set the template for testing if internal loading is too complex to fully mock here
      // This ensures tryGetPlanFromTemplate has something to work with.
      // The constructor test already verifies loadPlanTemplates.
      agent.planTemplates.set(mockWeatherTemplate.name, mockWeatherTemplate);
    });

    it('should return populated plan for matching task', async () => {
      const plan = await agent.tryGetPlanFromTemplate('what is the weather in London');
      expect(plan).not.toBeNull();
      expect(plan[0].inputs.city).toBe('London');
      expect(plan[0].agent).toBe('ResearchAgent');
    });

    it('should return null for non-matching task', async () => {
      const plan = await agent.tryGetPlanFromTemplate('calculate 2+2');
      expect(plan).toBeNull();
    });

    it('should return null if template regex does not match', async () => {
      const plan = await agent.tryGetPlanFromTemplate('show weather for Paris'); // "for" instead of "in"
      expect(plan).toBeNull();
    });
     it('should correctly populate template placeholders', async () => {
      const plan = await agent.tryGetPlanFromTemplate('weather in New York');
      expect(plan).toBeDefined();
      expect(plan).not.toBeNull();
      expect(plan[0].inputs.city).toBe('New York');
      // Check if the description in the original template was also populated (it should be part of the stringified template)
      // This depends on whether the full template object or just steps are returned.
      // Based on OrchestratorAgent code, it returns `populatedPlan.steps`.
    });
  });

  describe('summarizeDataWithLLM', () => {
    let agent;
    const userTaskString = "Test task";
    const narrativeStep = "Generated data";

    beforeEach(() => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(filePath => {
        if (filePath.endsWith('orchestratorConfig.json')) return JSON.stringify({ maxDataLengthForSummarization: 50 });
        if (filePath.endsWith('agentCapabilities.json')) return '[]';
        return '';
      });
      mockValidateFunction.mockReturnValue(true);
      agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
    });

    it('should return original data if not exceeding maxDataLength', async () => {
      const data = "Short data";
      const result = await agent.summarizeDataWithLLM(data, userTaskString, narrativeStep);
      expect(result).toBe(data);
      expect(mockLlmService).not.toHaveBeenCalled();
    });

    it('should call LLM and return summary if data exceeds maxDataLength', async () => {
      const longData = "This is a very long string of data that definitely exceeds the fifty character limit.";
      const summary = "Long data summary";
      mockLlmService.mockResolvedValue(summary);

      const result = await agent.summarizeDataWithLLM(longData, userTaskString, narrativeStep);
      expect(result).toBe(summary);
      expect(mockLlmService).toHaveBeenCalledWith(expect.stringContaining(longData.substring(0, 50)));
    });

    it('should return truncated data if LLM summarization fails', async () => {
      const longData = "Another long string that will exceed the configured maximum data length for summarization.";
      mockLlmService.mockRejectedValue(new Error("LLM error"));

      const result = await agent.summarizeDataWithLLM(longData, userTaskString, narrativeStep);
      expect(result).toBe(longData.substring(0, 50) + "... (original data was too long and summarization failed)");
      expect(mockLlmService).toHaveBeenCalled();
    });

    it('should return truncated data if LLM summary is empty or non-string', async () => {
      const longData = "Yet another long data string that is designed to be over the fifty character limit.";
      mockLlmService.mockResolvedValue(''); // Empty summary

      let result = await agent.summarizeDataWithLLM(longData, userTaskString, narrativeStep);
      expect(result).toBe(longData.substring(0, 50) + "... (original data was too long and summarization failed)");

      mockLlmService.mockResolvedValue(null); // Null summary
      result = await agent.summarizeDataWithLLM(longData, userTaskString, narrativeStep);
      expect(result).toBe(longData.substring(0, 50) + "... (original data was too long and summarization failed)");
    });
     it('should handle non-string data correctly for summarization', async () => {
      const dataObject = { key: "a very long value that will exceed the limit".repeat(3) };
      const dataString = JSON.stringify(dataObject);
      const summary = "Object summary";
      mockLlmService.mockResolvedValue(summary);

      const result = await agent.summarizeDataWithLLM(dataObject, userTaskString, narrativeStep);
      expect(result).toBe(summary);
      expect(mockLlmService).toHaveBeenCalledWith(expect.stringContaining(dataString.substring(0, 50)));
    });
  });

  // Tests for parseSubTaskPlanResponse (the standalone function)
  // This function is exported for testing if needed, or tested via handleUserTask's LLM planning.
  // Assuming it's imported for direct testing:
  // const { parseSubTaskPlanResponse } = require('../OrchestratorAgent'); // If it were exported
  // For now, let's assume it's not directly exported and will be tested via handleUserTask.
  // If direct testing is preferred, OrchestratorAgent.js would need to export it.

  // More test suites for handleUserTask will follow
  describe('handleUserTask - PLAN_ONLY mode', () => {
    let agent;
    const userTaskString = "plan a trip to Paris";
    const parentTaskId = "task789";
    // Mock required utility functions that are imported by OrchestratorAgent
    jest.mock('../../utils/taskStateUtil', () => ({
        saveTaskState: jest.fn().mockResolvedValue({ success: true }),
        loadTaskState: jest.fn(), // Will be mocked per test if needed for SYNTHESIZE_ONLY
    }));
    jest.mock('../../utils/fileUtils', () => ({
        getTaskStateFilePath: jest.fn().mockReturnValue('mock/file/path.json'),
    }));


    beforeEach(() => {
      fs.existsSync.mockReturnValue(true); // Assume all config files exist
      fs.readFileSync.mockImplementation(filePath => { // Provide default empty configs
        if (filePath.endsWith('agentCapabilities.json')) return JSON.stringify([{role: "TestRole", description: "TestDesc", tools: [{name: "TestTool", description: "TestToolDesc"}]}]); // Valid capabilities
        if (filePath.endsWith('orchestratorConfig.json')) return JSON.stringify({ maxDataLengthForSummarization: 1000 });
        return ''; // No templates by default for these specific tests unless specified
      });
      fs.readdirSync.mockReturnValue([]); // No templates by default
      mockValidateFunction.mockReturnValue(true); // All schemas are valid by default

      agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
       // Clear mocks from taskStateUtil and fileUtils for clean test state
      require('../../utils/taskStateUtil').saveTaskState.mockClear();
      require('../../utils/fileUtils').getTaskStateFilePath.mockClear();
    });

    it('should generate and save a plan in PLAN_ONLY mode', async () => {
      const mockPlanStages = [[{ assigned_agent_role: 'TestRole', tool_name: 'TestTool', sub_task_input: {}, narrative_step: 'Step 1' }]];
      const llmResponsePlan = JSON.stringify(mockPlanStages);
      mockLlmService.mockResolvedValue(llmResponsePlan);

      // Mock that workerAgentCapabilities is loaded correctly
      agent.workerAgentCapabilities = [{role: "TestRole", tools: [{name: "TestTool", description: "TestToolDesc"}]}];


      const result = await agent.handleUserTask(userTaskString, parentTaskId, null, ExecutionModes.PLAN_ONLY);

      expect(mockLlmService).toHaveBeenCalled();
      expect(require('../../utils/fileUtils').getTaskStateFilePath).toHaveBeenCalledWith(parentTaskId, expect.any(String));
      expect(require('../../utils/taskStateUtil').saveTaskState).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: parentTaskId,
          userTaskString,
          status: TaskStatuses.PLAN_GENERATED,
          plan: mockPlanStages,
        }),
        'mock/file/path.json'
      );
      expect(result.success).toBe(true);
      expect(result.plan).toEqual(mockPlanStages);
    });

    it('should save FAILED_PLANNING status if LLM service fails', async () => {
      mockLlmService.mockRejectedValue(new Error("LLM connection error"));
      agent.workerAgentCapabilities = [{role: "TestRole", tools: [{name: "TestTool", description: "TestToolDesc"}]}];


      const result = await agent.handleUserTask(userTaskString, parentTaskId, null, ExecutionModes.PLAN_ONLY);

      expect(mockLlmService).toHaveBeenCalled();
      expect(require('../../utils/taskStateUtil').saveTaskState).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: parentTaskId,
          status: TaskStatuses.FAILED_PLANNING,
          errorSummary: { reason: expect.stringContaining('LLM service error: LLM connection error') },
        }),
        'mock/file/path.json'
      );
      expect(result.success).toBe(false);
    });

    it('should save FAILED_PLANNING status if LLM returns invalid plan structure', async () => {
      const llmResponsePlan = JSON.stringify({ not_an_array_of_stages: true }); // Invalid structure
      mockLlmService.mockResolvedValue(llmResponsePlan);
      agent.workerAgentCapabilities = [{role: "TestRole", tools: [{name: "TestTool", description: "TestToolDesc"}]}];


      const result = await agent.handleUserTask(userTaskString, parentTaskId, null, ExecutionModes.PLAN_ONLY);

      expect(mockLlmService).toHaveBeenCalled();
      expect(require('../../utils/taskStateUtil').saveTaskState).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: parentTaskId,
          status: TaskStatuses.FAILED_PLANNING,
          errorSummary: { reason: expect.stringContaining('LLM plan is not a JSON array of stages') },
        }),
        'mock/file/path.json'
      );
      expect(result.success).toBe(false);
    });
  });

  describe('handleUserTask - SYNTHESIZE_ONLY mode', () => {
    let agent;
    const userTaskString = "synthesize this"; // Not used by synthesize_only directly, but good for context
    const taskIdToLoad = "loadedTask123";
    const { loadTaskState, saveTaskState } = require('../../utils/taskStateUtil');
    const { getTaskStateFilePath } = require('../../utils/fileUtils');


    beforeEach(() => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(filePath => {
         if (filePath.endsWith('agentCapabilities.json')) return JSON.stringify([{role: "TestRole", description: "TestDesc", tools: [{name: "TestTool", description: "TestToolDesc"}]}]);
        if (filePath.endsWith('orchestratorConfig.json')) return JSON.stringify({ maxDataLengthForSummarization: 1000 });
        return '';
      });
      fs.readdirSync.mockReturnValue([]);
      mockValidateFunction.mockReturnValue(true);

      agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
      loadTaskState.mockReset();
      mockLlmService.mockReset();
      // We don't expect saveTaskState to be called in SYNTHESIZE_ONLY mode
      saveTaskState.mockClear();
      getTaskStateFilePath.mockClear(); // Not used by SYNTHESIZE_ONLY path finding

      // Mock fs.promises for the directory reading part in SYNTHESIZE_ONLY
      fs.promises = {
        access: jest.fn().mockResolvedValue(undefined), // Assume base directory exists
        readdir: jest.fn().mockResolvedValue([]), // Default to no date_dirs found
      };
    });

    afterEach(() => {
        delete fs.promises; // Clean up the mock
    });

    it('should synthesize answer from loaded state successfully', async () => {
      const mockLoadedState = {
        userTaskString: "Original task description",
        executionContext: [{ narrative_step: "Step 1", tool_name: "TestTool", sub_task_input: {}, status: TaskStatuses.COMPLETED, processed_result_data: "Data from step 1" }],
        plan: [], // Plan details might not be crucial for synthesis itself
      };
      loadTaskState.mockResolvedValue({ success: true, taskState: mockLoadedState });
      const synthesizedAnswer = "This is the final synthesized answer.";
      mockLlmService.mockResolvedValue(synthesizedAnswer);

      // Mock fs.promises.readdir to find a relevant task state file
      const dateDirDirent = { name: 'tasks_01012023', isDirectory: () => true };
      fs.promises.readdir.mockResolvedValueOnce([dateDirDirent]); // For savedTasksBaseDir
      // Mock fs.promises.access to "find" the file in the first dateDir
      fs.promises.access.mockImplementation((p) => {
          if (p.includes(`task_state_${taskIdToLoad}.json`)) return Promise.resolve(undefined);
          return Promise.reject(new Error('file not found'));
      });


      const result = await agent.handleUserTask(userTaskString, "synthParentId", taskIdToLoad, ExecutionModes.SYNTHESIZE_ONLY);

      expect(loadTaskState).toHaveBeenCalledWith(expect.stringContaining(taskIdToLoad));
      expect(mockLlmService).toHaveBeenCalledWith(expect.stringContaining("Data from step 1"));
      expect(result.success).toBe(true);
      expect(result.finalAnswer).toBe(synthesizedAnswer);
      expect(result.originalTask).toBe(mockLoadedState.userTaskString);
    });

    it('should return error if taskIdToLoad is not provided', async () => {
      const result = await agent.handleUserTask(userTaskString, "synthParentId", null, ExecutionModes.SYNTHESIZE_ONLY);
      expect(result.success).toBe(false);
      expect(result.message).toContain("requires a taskIdToLoad");
    });

    it('should return error if loadTaskState fails', async () => {
      loadTaskState.mockResolvedValue({ success: false, message: "Failed to read file" });
       fs.promises.readdir.mockResolvedValueOnce([{ name: 'tasks_01012023', isDirectory: () => true }]);
       fs.promises.access.mockImplementation((p) => p.includes(`task_state_${taskIdToLoad}.json`) ? Promise.resolve() : Promise.reject());


      const result = await agent.handleUserTask(userTaskString, "synthParentId", taskIdToLoad, ExecutionModes.SYNTHESIZE_ONLY);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to load task state");
    });

    it('should return error if no execution context found in loaded state', async () => {
      const mockLoadedState = { userTaskString: "Original task", executionContext: [] }; // Empty context
      loadTaskState.mockResolvedValue({ success: true, taskState: mockLoadedState });
      fs.promises.readdir.mockResolvedValueOnce([{ name: 'tasks_01012023', isDirectory: () => true }]);
      fs.promises.access.mockImplementation((p) => p.includes(`task_state_${taskIdToLoad}.json`) ? Promise.resolve() : Promise.reject());

      const result = await agent.handleUserTask(userTaskString, "synthParentId", taskIdToLoad, ExecutionModes.SYNTHESIZE_ONLY);
      expect(result.success).toBe(false);
      expect(result.message).toContain("No execution context found");
    });

    it('should handle LLM error during synthesis', async () => {
      const mockLoadedState = {
        userTaskString: "Original task",
        executionContext: [{ narrative_step: "Step 1", status: TaskStatuses.COMPLETED, processed_result_data: "Data" }],
      };
      loadTaskState.mockResolvedValue({ success: true, taskState: mockLoadedState });
      mockLlmService.mockRejectedValue(new Error("LLM synthesis failed"));
      fs.promises.readdir.mockResolvedValueOnce([{ name: 'tasks_01012023', isDirectory: () => true }]);
      fs.promises.access.mockImplementation((p) => p.includes(`task_state_${taskIdToLoad}.json`) ? Promise.resolve() : Promise.reject());


      const result = await agent.handleUserTask(userTaskString, "synthParentId", taskIdToLoad, ExecutionModes.SYNTHESIZE_ONLY);
      expect(result.success).toBe(true); // Still true, but finalAnswer reflects error
      expect(result.finalAnswer).toContain("Error during final answer synthesis");
    });
     it('should handle case where no task state file is found across date directories', async () => {
      fs.promises.readdir.mockResolvedValue([ // Simulate multiple date dirs
        { name: 'tasks_01012023', isDirectory: () => true },
        { name: 'tasks_01022023', isDirectory: () => true }
      ]);
      // fs.promises.access will always reject, simulating file not found in any dir
      fs.promises.access.mockRejectedValue(new Error('File not found'));

      const result = await agent.handleUserTask(userTaskString, "synthParentId", taskIdToLoad, ExecutionModes.SYNTHESIZE_ONLY);

      expect(loadTaskState).not.toHaveBeenCalled(); // loadTaskState shouldn't be called if no file path is found
      expect(result.success).toBe(false);
      expect(result.message).toContain(`State file for task ID '${taskIdToLoad}' not found`);
    });
  });

  describe('handleUserTask - EXECUTE_FULL_PLAN mode', () => {
    let agent;
    const userTaskString = "execute this complex plan";
    const parentTaskId = "execTask123";
    const { saveTaskState } = require('../../utils/taskStateUtil');
    const { getTaskStateFilePath } = require('../../utils/fileUtils');

    const mockPlan = [
      [{ assigned_agent_role: 'TestRole', tool_name: 'TestTool1', sub_task_input: { data: 'input1' }, narrative_step: 'Step 1.1' }],
      [{ assigned_agent_role: 'TestRole', tool_name: 'TestTool2', sub_task_input: { data: 'input2' }, narrative_step: 'Step 2.1' }]
    ];

    beforeEach(() => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(filePath => {
         if (filePath.endsWith('agentCapabilities.json')) return JSON.stringify([{role: "TestRole", description: "TestDesc", tools: [{name: "TestTool1", description:"T1"}, {name:"TestTool2", description:"T2"}]}]);
        if (filePath.endsWith('orchestratorConfig.json')) return JSON.stringify({ maxDataLengthForSummarization: 1000 });
        return '';
      });
      fs.readdirSync.mockReturnValue([]);
      mockValidateFunction.mockReturnValue(true);

      agent = new OrchestratorAgent(mockSubTaskQueue, mockResultsQueue, mockLlmService, mockAgentApiKeysConfig);
      // Mock workerAgentCapabilities for LLM planning fallback (if template fails or not used)
      agent.workerAgentCapabilities = [{role: "TestRole", description:"Test Agent", tools: [{name: "TestTool1", description:"T1"}, {name:"TestTool2", description:"T2"}]}];


      saveTaskState.mockClear();
      getTaskStateFilePath.mockClear();
      mockLlmService.mockClear(); // Clear LLM mock for synthesis part
      mockSubTaskQueue.enqueueTask.mockClear();
      mockResultsQueue.subscribeOnce.mockClear();
    });

    it('should execute a plan, synthesize answer, and save state on full success', async () => {
      // Mock tryGetPlanFromTemplate to return null, forcing LLM planning
      agent.tryGetPlanFromTemplate = jest.fn().mockResolvedValue(null);
      mockLlmService
        .mockResolvedValueOnce(JSON.stringify(mockPlan)) // For LLM-based planning
        .mockResolvedValueOnce("Final synthesized answer from LLM."); // For final synthesis

      // Simulate successful sub-task executions
      mockResultsQueue.subscribeOnce
        .mockImplementationOnce((pTaskId, callback, sTaskId) => { // Stage 1, Sub-task 1
          // Ensure sub_task_id matches if your subscribeOnce uses it for filtering
          // For simplicity, directly calling callback
          callback(null, { sub_task_id: sTaskId, status: TaskStatuses.COMPLETED, result_data: { output: "result from TestTool1" } });
        })
        .mockImplementationOnce((pTaskId, callback, sTaskId) => { // Stage 2, Sub-task 1
          callback(null, { sub_task_id: sTaskId, status: TaskStatuses.COMPLETED, result_data: { output: "result from TestTool2" } });
        });

      const result = await agent.handleUserTask(userTaskString, parentTaskId, null, ExecutionModes.EXECUTE_FULL_PLAN);

      expect(agent.tryGetPlanFromTemplate).toHaveBeenCalledWith(userTaskString);
      expect(mockLlmService).toHaveBeenCalledTimes(2); // Once for planning, once for synthesis
      expect(mockSubTaskQueue.enqueueTask).toHaveBeenCalledTimes(mockPlan.length); // Each stage has one task

      expect(getTaskStateFilePath).toHaveBeenCalledWith(parentTaskId, expect.any(String));
      expect(saveTaskState).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: parentTaskId,
          userTaskString,
          status: TaskStatuses.COMPLETED,
          finalAnswer: "Final synthesized answer from LLM.",
          plan: expect.any(Array), // Executed steps info
          executionContext: expect.arrayContaining([
            expect.objectContaining({ tool_name: 'TestTool1', status: TaskStatuses.COMPLETED, processed_result_data: { output: "result from TestTool1" } }),
            expect.objectContaining({ tool_name: 'TestTool2', status: TaskStatuses.COMPLETED, processed_result_data: { output: "result from TestTool2" } })
          ])
        }),
        'mock/file/path.json'
      );
      expect(result.success).toBe(true);
      expect(result.finalAnswer).toBe("Final synthesized answer from LLM.");
    });

    it('should halt execution and save state if a sub-task fails', async () => {
      agent.tryGetPlanFromTemplate = jest.fn().mockResolvedValue(null); // Force LLM planning
      mockLlmService
        .mockResolvedValueOnce(JSON.stringify(mockPlan)); // LLM returns a plan

      // Simulate first sub-task failing
      mockResultsQueue.subscribeOnce.mockImplementationOnce((pTaskId, callback, sTaskId) => {
        callback(null, { sub_task_id: sTaskId, status: TaskStatuses.FAILED, error_details: { message: "Tool1 exploded" } });
      });

      const result = await agent.handleUserTask(userTaskString, parentTaskId, null, ExecutionModes.EXECUTE_FULL_PLAN);

      expect(mockLlmService).toHaveBeenCalledTimes(1); // Only for planning
      expect(mockSubTaskQueue.enqueueTask).toHaveBeenCalledTimes(1); // Only the first task of the first stage

      expect(saveTaskState).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: parentTaskId,
          status: TaskStatuses.FAILED_EXECUTION,
          finalAnswer: null, // No synthesis on failure
          errorSummary: {
            failedAtStage: null, // This could be enhanced to include stage index
            reason: expect.stringContaining("Last failed step: Step 1.1. Error: Tool1 exploded"),
          },
          executionContext: expect.arrayContaining([
            expect.objectContaining({ tool_name: 'TestTool1', status: TaskStatuses.FAILED, error_details: { message: "Tool1 exploded" } }),
          ])
        }),
        'mock/file/path.json'
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain("One or more sub-tasks failed");
    });
  });
});
