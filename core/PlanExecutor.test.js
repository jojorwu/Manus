const PlanExecutor = require('./PlanExecutor');
const ReadWebpageTool = require('../tools/ReadWebpageTool');
const AdvancedWebpageReaderTool = require('../tools/AdvancedWebpageReaderTool'); // Import for mocking
const { v4: uuidv4 } = require('uuid');

// Mocking external dependencies
const mockAdvancedWebpageReaderExecute = jest.fn();
jest.mock('../tools/AdvancedWebpageReaderTool', () => {
  return jest.fn().mockImplementation(() => {
    return { execute: mockAdvancedWebpageReaderExecute };
  });
});

const mockReadWebpageExecute = jest.fn();
jest.mock('../tools/ReadWebpageTool', () => {
  return jest.fn().mockImplementation(() => {
    return { execute: mockReadWebpageExecute };
  });
});

let mockLlmService;

const mockSubTaskQueue = {
  enqueueTask: jest.fn(),
};
const mockResultsQueue = {
  subscribeOnce: jest.fn(),
};

describe('PlanExecutor - _handleExploreSearchResults', () => {
  let planExecutor;
  let mockAdvancedWebpageReaderToolInstance;
  let mockReadWebpageToolInstance;

  beforeEach(() => {
    mockAdvancedWebpageReaderExecute.mockClear();
    mockReadWebpageExecute.mockClear();
    mockSubTaskQueue.enqueueTask.mockClear();
    mockResultsQueue.subscribeOnce.mockClear();
    mockResultsQueue.enqueueResult.mockClear(); // Added for safety from previous tasks

    mockLlmService = jest.fn();

    mockAdvancedWebpageReaderToolInstance = new AdvancedWebpageReaderTool();
    mockReadWebpageToolInstance = new ReadWebpageTool();

    // Default planExecutor for most tests, includes both tools
    planExecutor = new PlanExecutor(
      mockSubTaskQueue,
      mockResultsQueue,
      mockLlmService,
      {
        AdvancedWebpageReaderTool: mockAdvancedWebpageReaderToolInstance,
        ReadWebpageTool: mockReadWebpageToolInstance
      }
    );
  });

  // Test 1: Focus on summarization of a long WebSearchTool result (LLM should be called)
  test('should summarize WebSearchTool results when data is long', async () => {
    const parentTaskId = `parent-${uuidv4()}`;
    const userTaskString = "Research AI.";
    const mockPlan = [
      [ { narrative_step: "Perform a web search for AI research.", tool_name: "WebSearchTool", assigned_agent_role: "ResearchAgent", sub_task_input: { query: "AI research" } } ]
    ];

    planExecutor.llmService = jest.fn().mockResolvedValueOnce("Summarized AI research results.");

    let webSearchToolSubTaskId;
    mockSubTaskQueue.enqueueTask.mockImplementationOnce((taskMessage) => {
      if (taskMessage.tool_name === "WebSearchTool") webSearchToolSubTaskId = taskMessage.sub_task_id;
    });
    mockResultsQueue.subscribeOnce.mockImplementationOnce((ptId, callback, stId) => {
      if (stId && stId === webSearchToolSubTaskId) {
        callback(null, {
          sub_task_id: webSearchToolSubTaskId, parent_task_id: parentTaskId, worker_agent_role: "ResearchAgent", tool_name: "WebSearchTool", status: "COMPLETED",
          result_data: { result: [{ title: "AI Research Page 1", content: "a".repeat(1001) }] }, // Ensure data is long
        });
      }
    });

    const result = await planExecutor.executePlan(mockPlan, parentTaskId, userTaskString);

    expect(planExecutor.llmService).toHaveBeenCalledTimes(1);
    expect(planExecutor.llmService).toHaveBeenCalledWith(expect.stringContaining(mockPlan[0][0].narrative_step));
    const webSearchResult = result.executionContext.find(e => e.tool_name === "WebSearchTool");
    expect(webSearchResult.processed_result_data).toBe("Summarized AI research results.");
  });

  // Test 2: ExploreSearchResults uses AdvancedWebpageReaderTool by default
  test('ExploreSearchResults should use AdvancedWebpageReaderTool when available', async () => {
    const parentTaskId = `parent-${uuidv4()}-explore-adv`;
    const userTaskString = "Explore web findings (advanced).";
    const multiStagePlan = [
      [ { narrative_step: "Perform short web search.", tool_name: "WebSearchTool", assigned_agent_role: "ResearchAgent", sub_task_input: { query: "short search" } } ],
      [ { narrative_step: "Explore results with AdvancedReader.", tool_name: "ExploreSearchResults", assigned_agent_role: "Orchestrator", sub_task_input: { pagesToExplore: 1 } } ]
    ];

    planExecutor.llmService = jest.fn(); // LLM should NOT be called for summarization of short WebSearchTool data

    let webSearchSubTaskIdMulti;
    mockSubTaskQueue.enqueueTask.mockImplementationOnce((taskMessage) => {
      if (taskMessage.tool_name === "WebSearchTool") webSearchSubTaskIdMulti = taskMessage.sub_task_id;
    });
    mockResultsQueue.subscribeOnce.mockImplementationOnce((ptId, callback, stId) => {
      if (stId === webSearchSubTaskIdMulti) {
        callback(null, {
          sub_task_id: webSearchSubTaskIdMulti, parent_task_id: parentTaskId, worker_agent_role: "ResearchAgent", tool_name: "WebSearchTool", status: "COMPLETED",
          result_data: { result: [ { title: "Short Page 1", link: "http://example.com/short1-adv" } ] },
        });
      }
    });

    mockAdvancedWebpageReaderExecute.mockResolvedValueOnce({ success: true, text: "Advanced content from Short Page 1", images: [] });

    const resultMulti = await planExecutor.executePlan(multiStagePlan, parentTaskId, userTaskString);

    expect(planExecutor.llmService).toHaveBeenCalledTimes(0);
    expect(mockAdvancedWebpageReaderExecute).toHaveBeenCalledTimes(1);
    expect(mockAdvancedWebpageReaderExecute).toHaveBeenCalledWith({ url: "http://example.com/short1-adv" });
    expect(mockReadWebpageExecute).not.toHaveBeenCalled(); // Ensure basic reader wasn't called
    const exploreResultMulti = resultMulti.executionContext.find(e => e.tool_name === "ExploreSearchResults");
    expect(exploreResultMulti.processed_result_data).toContain("Advanced content from Short Page 1");
  });

  // Test 3: ExploreSearchResults handles errors from AdvancedWebpageReaderTool
  test('ExploreSearchResults should handle errors from AdvancedWebpageReaderTool', async () => {
    const parentTaskId = `parent-${uuidv4()}-err-adv`;
    const userTaskString = "Explore with advanced error.";
    const mockPlanErrorCase = [
      [ { narrative_step: "Search for adv error test.", tool_name: "WebSearchTool", assigned_agent_role: "ResearchAgent", sub_task_input: { query: "adv error test" }} ],
      [ { narrative_step: "Explore (expecting adv error).", tool_name: "ExploreSearchResults", assigned_agent_role: "Orchestrator", sub_task_input: { pagesToExplore: 1 } } ]
    ];
    planExecutor.llmService = jest.fn();
    let searchStepSubTaskIdError;
    mockSubTaskQueue.enqueueTask.mockImplementationOnce((taskMessage) => { searchStepSubTaskIdError = taskMessage.sub_task_id; });
    mockResultsQueue.subscribeOnce.mockImplementationOnce((ptId, callback, stId) => {
        if (stId === searchStepSubTaskIdError) {
            callback(null, {
                sub_task_id: searchStepSubTaskIdError, parent_task_id: parentTaskId, worker_agent_role: "ResearchAgent", tool_name: "WebSearchTool", status: "COMPLETED",
                result_data: { result: [{ title: "Adv Error Page 1", link: "http://example.com/adverrorpage" }] },
            });
        }
    });
    mockAdvancedWebpageReaderExecute.mockResolvedValueOnce({ success: false, error: "Advanced Tool Failed", details: "Advanced retrieve error" });

    const result = await planExecutor.executePlan(mockPlanErrorCase, parentTaskId, userTaskString);
    expect(planExecutor.llmService).toHaveBeenCalledTimes(0);
    expect(mockAdvancedWebpageReaderExecute).toHaveBeenCalledWith({ url: "http://example.com/adverrorpage" });
    expect(mockReadWebpageExecute).not.toHaveBeenCalled();
    const exploreStepResult = result.executionContext.find(e => e.tool_name === "ExploreSearchResults");
    expect(exploreStepResult.processed_result_data).toContain("Error reading http://example.com/adverrorpage: Advanced Tool Failed (Details: Advanced retrieve error)");
  });

  // Test 4: ExploreSearchResults defaults to 2 pages with AdvancedWebpageReaderTool
  test('ExploreSearchResults should default to 2 pages with AdvancedWebpageReaderTool', async () => {
    const parentTaskId = `parent-${uuidv4()}-default-adv`;
    const userTaskString = "Explore default pages (advanced).";
    const mockPlanDefaultPage = [
      [ { narrative_step: "Search for adv default test.", tool_name: "WebSearchTool", assigned_agent_role: "ResearchAgent", sub_task_input: { query: "adv default test" }} ],
      [ { narrative_step: "Explore (adv default pages).", tool_name: "ExploreSearchResults", assigned_agent_role: "Orchestrator", sub_task_input: {} } ] // No pagesToExplore
    ];
    planExecutor.llmService = jest.fn();
    let searchStepSubTaskIdDefault;
    mockSubTaskQueue.enqueueTask.mockImplementationOnce((taskMessage) => { searchStepSubTaskIdDefault = taskMessage.sub_task_id; });
    mockResultsQueue.subscribeOnce.mockImplementationOnce((ptId, callback, stId) => {
        if (stId === searchStepSubTaskIdDefault) {
            callback(null, {
                sub_task_id: searchStepSubTaskIdDefault, parent_task_id: parentTaskId, worker_agent_role: "ResearchAgent", tool_name: "WebSearchTool", status: "COMPLETED",
                result_data: { result: [ { title: "Adv Default Page 1", link: "http://example.com/advdefault1" }, { title: "Adv Default Page 2", link: "http://example.com/advdefault2" }, { title: "Adv Default Page 3", link: "http://example.com/advdefault3" } ]},
            });
        }
    });
    mockAdvancedWebpageReaderExecute
        .mockResolvedValueOnce({ success: true, text: "Adv Content Default P1", images: [] })
        .mockResolvedValueOnce({ success: true, text: "Adv Content Default P2", images: [] });

    const result = await planExecutor.executePlan(mockPlanDefaultPage, parentTaskId, userTaskString);
    expect(planExecutor.llmService).toHaveBeenCalledTimes(0);
    expect(mockAdvancedWebpageReaderExecute).toHaveBeenCalledTimes(2);
    expect(mockAdvancedWebpageReaderExecute).toHaveBeenCalledWith({ url: "http://example.com/advdefault1" });
    expect(mockAdvancedWebpageReaderExecute).toHaveBeenCalledWith({ url: "http://example.com/advdefault2" });
    expect(mockReadWebpageExecute).not.toHaveBeenCalled();
  });

  // Test 5: ExploreSearchResults falls back to ReadWebpageTool if AdvancedWebpageReaderTool is not available
  test('ExploreSearchResults should fallback to ReadWebpageTool if AdvancedWebpageReaderTool is not available', async () => {
    // Re-instantiate PlanExecutor for this test *without* AdvancedWebpageReaderTool in its tools map
    planExecutor = new PlanExecutor(
      mockSubTaskQueue,
      mockResultsQueue,
      mockLlmService,
      { ReadWebpageTool: mockReadWebpageToolInstance } // Only basic reader
    );

    const parentTaskId = `parent-${uuidv4()}-fallback`;
    const userTaskString = "Explore web findings (fallback).";
    const multiStagePlan = [
      [ { narrative_step: "Perform short web search (fallback).", tool_name: "WebSearchTool", assigned_agent_role: "ResearchAgent", sub_task_input: { query: "short search fallback" } } ],
      [ { narrative_step: "Explore results with ReadWebpageTool (fallback).", tool_name: "ExploreSearchResults", assigned_agent_role: "Orchestrator", sub_task_input: { pagesToExplore: 1 } } ]
    ];
    planExecutor.llmService = jest.fn();
    let webSearchSubTaskIdFallback;
    mockSubTaskQueue.enqueueTask.mockImplementationOnce((taskMessage) => { webSearchSubTaskIdFallback = taskMessage.sub_task_id; });
    mockResultsQueue.subscribeOnce.mockImplementationOnce((ptId, callback, stId) => {
      if (stId === webSearchSubTaskIdFallback) {
        callback(null, {
          sub_task_id: webSearchSubTaskIdFallback, parent_task_id: parentTaskId, worker_agent_role: "ResearchAgent", tool_name: "WebSearchTool", status: "COMPLETED",
          result_data: { result: [ { title: "Fallback Page 1", link: "http://example.com/fallback1" } ] },
        });
      }
    });
    mockReadWebpageExecute.mockResolvedValueOnce({ result: "Fallback content from Page 1", error: null }); // Note: ReadWebpageTool's structure

    const resultFallback = await planExecutor.executePlan(multiStagePlan, parentTaskId, userTaskString);
    expect(planExecutor.llmService).toHaveBeenCalledTimes(0);
    expect(mockReadWebpageExecute).toHaveBeenCalledTimes(1);
    expect(mockReadWebpageExecute).toHaveBeenCalledWith({ url: "http://example.com/fallback1" });
    expect(mockAdvancedWebpageReaderExecute).not.toHaveBeenCalled();
    const exploreResultFallback = resultFallback.executionContext.find(e => e.tool_name === "ExploreSearchResults");
    expect(exploreResultFallback.processed_result_data).toContain("Fallback content from Page 1");
  });
});
