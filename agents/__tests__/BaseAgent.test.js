const fs = require('fs');
const path = require('path');
const BaseAgent = require('../BaseAgent'); // Adjust path as necessary
const { TaskStatuses } = require('../../core/constants'); // Adjust path

// Mock dependencies
jest.mock('fs');

// Mock queues (simple mocks for now)
const mockSubTaskQueue = {
  subscribeToRole: jest.fn(),
};
const mockResultsQueue = {
  enqueueResult: jest.fn(),
};

describe('BaseAgent', () => {
  const agentRole = 'TestAgent';
  const mockAgentApiKeysConfig = {};
  let toolsMap;

  beforeEach(() => {
    // Reset mocks before each test
    fs.readFileSync.mockReset();
    fs.existsSync.mockReset();
    mockSubTaskQueue.subscribeToRole.mockClear();
    mockResultsQueue.enqueueResult.mockClear();
    toolsMap = new Map(); // Fresh map for each test
  });

  describe('Constructor and Config Loading', () => {
    it('should initialize properties correctly', () => {
      fs.existsSync.mockReturnValue(false); // No config file
      const agent = new BaseAgent(mockSubTaskQueue, mockResultsQueue, toolsMap, agentRole, mockAgentApiKeysConfig);
      expect(agent.subTaskQueue).toBe(mockSubTaskQueue);
      expect(agent.resultsQueue).toBe(mockResultsQueue);
      expect(agent.toolsMap).toBe(toolsMap);
      expect(agent.agentRole).toBe(agentRole);
      expect(agent.agentApiKeysConfig).toBe(mockAgentApiKeysConfig);
      expect(agent.config).toBeDefined();
    });

    it('loadWorkerConfig should load valid config from file', () => {
      const validConfig = {
        defaultToolTimeoutMs: 50000,
        toolTimeouts: { SpecificTool: 60000 },
      };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(validConfig));

      const agent = new BaseAgent(mockSubTaskQueue, mockResultsQueue, toolsMap, agentRole, mockAgentApiKeysConfig);
      expect(fs.readFileSync).toHaveBeenCalledWith(path.join(__dirname, '..', '..', 'config', 'workerAgentConfig.json'), 'utf8');
      expect(agent.config.defaultToolTimeoutMs).toBe(50000);
      expect(agent.config.toolTimeouts.SpecificTool).toBe(60000);
    });

    it('loadWorkerConfig should use default config if file not found', () => {
      fs.existsSync.mockReturnValue(false);
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); // Suppress console.warn

      const agent = new BaseAgent(mockSubTaskQueue, mockResultsQueue, toolsMap, agentRole, mockAgentApiKeysConfig);

      expect(agent.config.defaultToolTimeoutMs).toBe(30000); // Default value
      expect(agent.config.toolTimeouts).toEqual({});
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('workerAgentConfig.json not found'));
      consoleWarnSpy.mockRestore();
    });

    it('loadWorkerConfig should use default config for invalid JSON', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{"invalidJson":,');
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); // Suppress console.error

      const agent = new BaseAgent(mockSubTaskQueue, mockResultsQueue, toolsMap, agentRole, mockAgentApiKeysConfig);

      expect(agent.config.defaultToolTimeoutMs).toBe(30000);
      expect(agent.config.toolTimeouts).toEqual({});
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error loading workerAgentConfig.json'));
      consoleErrorSpy.mockRestore();
    });

    it('loadWorkerConfig should use default config if readFileSync throws an error', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockImplementation(() => {
          throw new Error('FS Read Error');
        });
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const agent = new BaseAgent(mockSubTaskQueue, mockResultsQueue, toolsMap, agentRole, mockAgentApiKeysConfig);

        expect(agent.config.defaultToolTimeoutMs).toBe(30000);
        expect(agent.config.toolTimeouts).toEqual({});
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error loading workerAgentConfig.json'));
        consoleErrorSpy.mockRestore();
      });
  });

  describe('getToolTimeout', () => {
    it('should return specific timeout if defined', () => {
      const config = {
        defaultToolTimeoutMs: 20000,
        toolTimeouts: { MyTool: 25000 },
      };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(config));
      const agent = new BaseAgent(mockSubTaskQueue, mockResultsQueue, toolsMap, agentRole, mockAgentApiKeysConfig);
      expect(agent.getToolTimeout('MyTool')).toBe(25000);
    });

    it('should return default timeout if specific not defined', () => {
      const config = {
        defaultToolTimeoutMs: 20000,
        toolTimeouts: { MyTool: 25000 },
      };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(config));
      const agent = new BaseAgent(mockSubTaskQueue, mockResultsQueue, toolsMap, agentRole, mockAgentApiKeysConfig);
      expect(agent.getToolTimeout('OtherTool')).toBe(20000);
    });

     it('should return default timeout if toolTimeouts is not in config', () => {
      const config = { defaultToolTimeoutMs: 22000 }; // toolTimeouts field missing
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(config));
      const agent = new BaseAgent(mockSubTaskQueue, mockResultsQueue, toolsMap, agentRole, mockAgentApiKeysConfig);
      expect(agent.getToolTimeout('AnyTool')).toBe(22000);
    });
  });

  // More tests for processTaskMessage will follow here
  describe('processTaskMessage', () => {
    let agent;
    const mockTaskMessage = {
      sub_task_id: 'sub123',
      parent_task_id: 'parent456',
      tool_name: 'MockTool',
      sub_task_input: { data: 'input' },
    };
    let mockToolInstance;

    beforeEach(() => {
      // Standard agent setup for these tests
      fs.existsSync.mockReturnValue(false); // Use default config for simplicity unless overridden
      agent = new BaseAgent(mockSubTaskQueue, mockResultsQueue, toolsMap, agentRole, mockAgentApiKeysConfig);

      // Mock the abstract methods for each test, or setup common mocks here
      agent.validateToolInput = jest.fn();
      agent.executeTool = jest.fn();

      mockToolInstance = { execute: jest.fn() };
      toolsMap.set('MockTool', mockToolInstance); // Add a mock tool
    });

    afterEach(() => {
        jest.restoreAllMocks(); // Restores original implementations, good for spies
        jest.clearAllMocks(); // Clears mock call counts etc.
    });

    it('should process a valid task successfully', async () => {
      agent.validateToolInput.mockReturnValue({ isValid: true, error: null });
      const toolResult = { successData: 'tool output' };
      agent.executeTool.mockResolvedValue(toolResult);

      await agent.processTaskMessage(mockTaskMessage);

      expect(agent.validateToolInput).toHaveBeenCalledWith('MockTool', mockTaskMessage.sub_task_input);
      expect(agent.executeTool).toHaveBeenCalledWith(mockToolInstance, mockTaskMessage.sub_task_input, 'MockTool', mockAgentApiKeysConfig);
      expect(mockResultsQueue.enqueueResult).toHaveBeenCalledWith(
        mockTaskMessage.parent_task_id,
        expect.objectContaining({
          sub_task_id: mockTaskMessage.sub_task_id,
          worker_role: agentRole,
          status: TaskStatuses.COMPLETED,
          result_data: toolResult,
          error_details: null,
        })
      );
    });

    it('should handle tool not found', async () => {
      const unknownToolTaskMessage = { ...mockTaskMessage, tool_name: 'UnknownTool' };
      await agent.processTaskMessage(unknownToolTaskMessage);

      expect(mockResultsQueue.enqueueResult).toHaveBeenCalledWith(
        unknownToolTaskMessage.parent_task_id,
        expect.objectContaining({
          sub_task_id: unknownToolTaskMessage.sub_task_id,
          status: TaskStatuses.FAILED,
          result_data: null,
          error_details: { message: `Unknown tool 'UnknownTool' for ${agentRole}.` },
        })
      );
    });

    it('should handle invalid tool input', async () => {
      const validationError = 'Input is missing required fields.';
      agent.validateToolInput.mockReturnValue({ isValid: false, error: validationError });

      await agent.processTaskMessage(mockTaskMessage);

      expect(mockResultsQueue.enqueueResult).toHaveBeenCalledWith(
        mockTaskMessage.parent_task_id,
        expect.objectContaining({
          sub_task_id: mockTaskMessage.sub_task_id,
          status: TaskStatuses.FAILED,
          error_details: { message: `Invalid input for tool '${mockTaskMessage.tool_name}': ${validationError}` },
        })
      );
    });

    it('should handle tool execution error', async () => {
      agent.validateToolInput.mockReturnValue({ isValid: true, error: null });
      const executionError = new Error('Tool failed spectacularly');
      agent.executeTool.mockRejectedValue(executionError);

      await agent.processTaskMessage(mockTaskMessage);

      expect(mockResultsQueue.enqueueResult).toHaveBeenCalledWith(
        mockTaskMessage.parent_task_id,
        expect.objectContaining({
          sub_task_id: mockTaskMessage.sub_task_id,
          status: TaskStatuses.FAILED,
          error_details: { message: executionError.message, stack: expect.any(String) },
        })
      );
    });

    it('should handle tool execution timeout', async () => {
      jest.useFakeTimers();
      agent.validateToolInput.mockReturnValue({ isValid: true, error: null });

      // Make executeTool return a promise that never resolves on its own
      agent.executeTool.mockReturnValue(new Promise(() => {}));

      const processPromise = agent.processTaskMessage(mockTaskMessage);

      // Advance timers past the default timeout (assuming default config is used)
      // Default timeout is 30000ms. Get it from agent.config for robustness if needed.
      const timeoutDuration = agent.getToolTimeout(mockTaskMessage.tool_name);
      jest.advanceTimersByTime(timeoutDuration);

      await processPromise; // Let the processTaskMessage complete

      expect(mockResultsQueue.enqueueResult).toHaveBeenCalledWith(
        mockTaskMessage.parent_task_id,
        expect.objectContaining({
          sub_task_id: mockTaskMessage.sub_task_id,
          status: TaskStatuses.FAILED,
          error_details: { message: `Tool execution timed out after ${timeoutDuration}ms`, stack: expect.any(String) },
        })
      );
      jest.useRealTimers();
    });
  });
});
