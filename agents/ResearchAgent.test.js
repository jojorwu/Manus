const ResearchAgent = require('./ResearchAgent');
const SubTaskQueue = require('../core/SubTaskQueue');
const ResultsQueue = require('../core/ResultsQueue');
const AdvancedWebpageReaderTool = require('../tools/AdvancedWebpageReaderTool'); // Used for jest.mock

// Mock the tools that ResearchAgent might use
jest.mock('../tools/WebSearchTool', () => {
  return jest.fn().mockImplementation(() => {
    return { execute: jest.fn().mockResolvedValue({ success: true, results: [] }) };
  });
});
jest.mock('../tools/ReadWebpageTool', () => {
  return jest.fn().mockImplementation(() => {
    return { execute: jest.fn().mockResolvedValue({ success: true, text: "" }) };
  });
});

// Mock AdvancedWebpageReaderTool specifically for testing its invocation
const mockAdvancedWebpageReaderExecute = jest.fn();
jest.mock('../tools/AdvancedWebpageReaderTool', () => {
  return jest.fn().mockImplementation(() => {
    return { execute: mockAdvancedWebpageReaderExecute };
  });
});

// Mock Queues
jest.mock('../core/SubTaskQueue', () => {
  return jest.fn().mockImplementation(() => {
    return { getTask: jest.fn(), processTask: jest.fn() }; // Added processTask for completeness if needed
  });
});
jest.mock('../core/ResultsQueue', () => {
  return jest.fn().mockImplementation(() => {
    return { enqueueResult: jest.fn() };
  });
});


describe('ResearchAgent', () => {
  let researchAgent;
  let mockSubTaskQueue;
  let mockResultsQueue;
  let mockWebSearchToolInstance;
  let mockReadWebpageToolInstance;
  let mockAdvancedWebpageReaderToolInstance; // This will be the instance created by the mocked constructor

  beforeEach(() => {
    // Clear all mocks before each test
    mockAdvancedWebpageReaderExecute.mockClear();

    // Create new instances of mocked tools before each test if ResearchAgent instantiates them internally,
    // or ensure the global mocks are clean. Here, tools are passed via constructor.
    // The jest.mock() above already provides fresh mocks for each test run due to Jest's module system.
    mockWebSearchToolInstance = new (require('../tools/WebSearchTool'))();
    mockReadWebpageToolInstance = new (require('../tools/ReadWebpageTool'))();
    mockAdvancedWebpageReaderToolInstance = new AdvancedWebpageReaderTool(); // Gets the mocked version

    mockSubTaskQueue = new SubTaskQueue();
    mockResultsQueue = new ResultsQueue();

    const tools = {
      "WebSearchTool": mockWebSearchToolInstance,
      "ReadWebpageTool": mockReadWebpageToolInstance,
      "AdvancedWebpageReaderTool": mockAdvancedWebpageReaderToolInstance,
    };
    const agentApiKeysConfig = {}; // Assuming no API keys needed for AdvancedWebpageReaderTool itself

    researchAgent = new ResearchAgent(mockSubTaskQueue, mockResultsQueue, tools, agentApiKeysConfig);
  });

  test('should call AdvancedWebpageReaderTool.execute when task specifies it', async () => {
    const taskMessage = {
      sub_task_id: 'subtask-adv-read-123',
      parent_task_id: 'parent-task-456',
      assigned_agent_role: 'ResearchAgent',
      tool_name: 'AdvancedWebpageReaderTool',
      sub_task_input: { url: 'http://example.com/dynamic' },
      narrative_step: 'Read advanced content from example.com/dynamic',
    };

    const mockToolResult = {
      success: true,
      text: "Dynamic content text",
      images: [{ src: "http://example.com/img.png", alt: "Test" }],
      url: 'http://example.com/dynamic'
    };
    mockAdvancedWebpageReaderExecute.mockResolvedValueOnce(mockToolResult);

    await researchAgent.processTaskMessage(taskMessage);

    expect(mockAdvancedWebpageReaderExecute).toHaveBeenCalledTimes(1);
    expect(mockAdvancedWebpageReaderExecute).toHaveBeenCalledWith({ url: 'http://example.com/dynamic' });

    expect(mockResultsQueue.enqueueResult).toHaveBeenCalledTimes(1);
    expect(mockResultsQueue.enqueueResult).toHaveBeenCalledWith({
      sub_task_id: taskMessage.sub_task_id,
      parent_task_id: taskMessage.parent_task_id,
      worker_agent_role: researchAgent.role,
      tool_name: taskMessage.tool_name,
      status: "COMPLETED",
      result_data: mockToolResult,
      error_details: null
    });
  });

  test('should handle failure from AdvancedWebpageReaderTool.execute', async () => {
    const taskMessage = {
      sub_task_id: 'subtask-adv-read-fail-123',
      parent_task_id: 'parent-task-fail-456',
      assigned_agent_role: 'ResearchAgent',
      tool_name: 'AdvancedWebpageReaderTool',
      sub_task_input: { url: 'http://example.com/willfail' },
      narrative_step: 'Read content from a URL that will fail',
    };

    const mockToolErrorResult = {
      success: false,
      error: "Tool Failed",
      details: "Could not retrieve content"
    };
    mockAdvancedWebpageReaderExecute.mockResolvedValueOnce(mockToolErrorResult);

    await researchAgent.processTaskMessage(taskMessage);

    expect(mockAdvancedWebpageReaderExecute).toHaveBeenCalledTimes(1);
    expect(mockAdvancedWebpageReaderExecute).toHaveBeenCalledWith({ url: 'http://example.com/willfail' });

    expect(mockResultsQueue.enqueueResult).toHaveBeenCalledTimes(1);
    expect(mockResultsQueue.enqueueResult).toHaveBeenCalledWith({
      sub_task_id: taskMessage.sub_task_id,
      parent_task_id: taskMessage.parent_task_id,
      worker_agent_role: researchAgent.role,
      tool_name: taskMessage.tool_name,
      status: "FAILED",
      result_data: null, // or specific error structure if that's how agent handles it
      error_details: { message: "Tool Failed", details: "Could not retrieve content" }
    });
  });

  test('should return error if unknown tool is specified', async () => {
    const taskMessage = {
      sub_task_id: 'subtask-unknown-tool-123',
      parent_task_id: 'parent-task-unknown-456',
      assigned_agent_role: 'ResearchAgent',
      tool_name: 'UnknownTool',
      sub_task_input: { data: 'input' },
      narrative_step: 'Use an unknown tool',
    };

    await researchAgent.processTaskMessage(taskMessage);

    expect(mockResultsQueue.enqueueResult).toHaveBeenCalledTimes(1);
    expect(mockResultsQueue.enqueueResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "FAILED",
      error_details: { message: "Unknown tool: UnknownTool for agent ResearchAgent" }
    }));
  });

});
