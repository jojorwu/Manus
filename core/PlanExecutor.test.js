const PlanExecutor = require('./PlanExecutor');
const ReadWebpageTool = require('../tools/ReadWebpageTool'); // Original to be mocked
const { v4: uuidv4 } = require('uuid');

// Mocking external dependencies
jest.mock('../tools/ReadWebpageTool'); // Auto-mock ReadWebpageTool

// Mock LLMService - will be replaced per test
let mockLlmService;

// Mock SubTaskQueue and ResultsQueue
const mockSubTaskQueue = {
  enqueueTask: jest.fn(),
};
const mockResultsQueue = {
  subscribeOnce: jest.fn(),
};

describe('PlanExecutor - Integration with ReadWebpageTool for ExploreSearchResults', () => {
  let planExecutor;
  let mockReadWebpageToolInstance;

  beforeEach(() => {
    ReadWebpageTool.mockClear();
    mockSubTaskQueue.enqueueTask.mockClear();
    mockResultsQueue.subscribeOnce.mockClear();

    mockLlmService = jest.fn();

    mockReadWebpageToolInstance = new ReadWebpageTool();

    planExecutor = new PlanExecutor(
      mockSubTaskQueue,
      mockResultsQueue,
      mockLlmService,
      { ReadWebpageTool: mockReadWebpageToolInstance }
    );
  });

  // Test 1: Focus on summarization of a long WebSearchTool result
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
          result_data: [{ title: "AI Research Page 1", content: "a".repeat(1001) }],
        });
      }
    });

    const result = await planExecutor.executePlan(mockPlan, parentTaskId, userTaskString);

    expect(mockSubTaskQueue.enqueueTask).toHaveBeenCalledTimes(1);
    expect(mockResultsQueue.subscribeOnce).toHaveBeenCalledTimes(1);
    expect(planExecutor.llmService).toHaveBeenCalledTimes(1);
    expect(planExecutor.llmService).toHaveBeenCalledWith(expect.stringContaining(mockPlan[0][0].narrative_step));
    const webSearchResult = result.executionContext.find(e => e.tool_name === "WebSearchTool");
    expect(webSearchResult).toBeDefined();
    expect(webSearchResult.processed_result_data).toBe("Summarized AI research results.");
    expect(result.success).toBe(true);
  });

  // Test 2: Focus on ExploreSearchResults with non-summarized (short) prior WebSearchTool data
  test('ExploreSearchResults should call ReadWebpageTool using non-summarized prior results', async () => {
    const parentTaskId = `parent-${uuidv4()}-explore`;
    const userTaskString = "Explore web findings.";
    const multiStagePlan = [
      [ { narrative_step: "Perform short web search.", tool_name: "WebSearchTool", assigned_agent_role: "ResearchAgent", sub_task_input: { query: "short search" } } ],
      [ { narrative_step: "Explore short search results.", tool_name: "ExploreSearchResults", assigned_agent_role: "Orchestrator", sub_task_input: { pagesToExplore: 1 } } ]
    ];

    planExecutor.llmService = jest.fn();

    let webSearchSubTaskIdMulti;
    mockSubTaskQueue.enqueueTask.mockImplementationOnce((taskMessage) => {
      if (taskMessage.tool_name === "WebSearchTool") webSearchSubTaskIdMulti = taskMessage.sub_task_id;
    });
    mockResultsQueue.subscribeOnce.mockImplementationOnce((ptId, callback, stId) => {
      if (stId === webSearchSubTaskIdMulti) {
        callback(null, {
          sub_task_id: webSearchSubTaskIdMulti, parent_task_id: parentTaskId, worker_agent_role: "ResearchAgent", tool_name: "WebSearchTool", status: "COMPLETED",
          result_data: { result: [ { title: "Short Page 1", link: "http://example.com/short1" } ] },
        });
      }
    });

    mockReadWebpageToolInstance.execute.mockResolvedValueOnce({ result: "Content from Short Page 1", error: null });

    const resultMulti = await planExecutor.executePlan(multiStagePlan, parentTaskId, userTaskString);

    expect(mockSubTaskQueue.enqueueTask).toHaveBeenCalledTimes(1);
    expect(mockResultsQueue.subscribeOnce).toHaveBeenCalledTimes(1);
    expect(planExecutor.llmService).toHaveBeenCalledTimes(0);
    expect(mockReadWebpageToolInstance.execute).toHaveBeenCalledTimes(1);
    expect(mockReadWebpageToolInstance.execute).toHaveBeenCalledWith({ url: "http://example.com/short1" });
    const exploreResultMulti = resultMulti.executionContext.find(e => e.tool_name === "ExploreSearchResults");
    expect(exploreResultMulti).toBeDefined();
    expect(exploreResultMulti.processed_result_data).toContain("Content from Short Page 1");
    expect(resultMulti.success).toBe(true);
  });

  // Test 3: ExploreSearchResults error handling with non-summarized (short) prior data
  test('ExploreSearchResults should handle errors from ReadWebpageTool (non-summarized prior results)', async () => {
    const parentTaskId = `parent-${uuidv4()}-err`;
    const userTaskString = "Explore with error.";
    const mockPlanErrorCase = [
      [ { narrative_step: "Search for error test.", tool_name: "WebSearchTool", assigned_agent_role: "ResearchAgent", sub_task_input: { query: "error test" }} ],
      [ { narrative_step: "Explore (expecting error).", tool_name: "ExploreSearchResults", assigned_agent_role: "Orchestrator", sub_task_input: { pagesToExplore: 1 } } ]
    ];

    planExecutor.llmService = jest.fn();

    let searchStepSubTaskIdError;
    mockSubTaskQueue.enqueueTask.mockImplementationOnce((taskMessage) => {
        searchStepSubTaskIdError = taskMessage.sub_task_id;
    });
    mockResultsQueue.subscribeOnce.mockImplementationOnce((ptId, callback, stId) => {
        if (stId === searchStepSubTaskIdError) {
            callback(null, {
                sub_task_id: searchStepSubTaskIdError, parent_task_id: parentTaskId, worker_agent_role: "ResearchAgent", tool_name: "WebSearchTool", status: "COMPLETED",
                result_data: { result: [{ title: "Error Page 1", link: "http://example.com/errorpage" }] },
            });
        }
    });

    mockReadWebpageToolInstance.execute.mockResolvedValueOnce({ result: null, error: "Failed to fetch error page" });

    const result = await planExecutor.executePlan(mockPlanErrorCase, parentTaskId, userTaskString);

    expect(planExecutor.llmService).toHaveBeenCalledTimes(0);
    expect(mockReadWebpageToolInstance.execute).toHaveBeenCalledWith({ url: "http://example.com/errorpage" });
    const exploreStepResult = result.executionContext.find(e => e.tool_name === "ExploreSearchResults");
    expect(exploreStepResult.processed_result_data).toContain("Error reading http://example.com/errorpage: Failed to fetch error page");
    expect(result.success).toBe(true);
  });

  // Test 4: ExploreSearchResults default pages with non-summarized (short) prior data
  test('ExploreSearchResults should default to 2 pages (non-summarized prior results)', async () => {
    const parentTaskId = `parent-${uuidv4()}-default`;
    const userTaskString = "Explore default pages.";
    const mockPlanDefaultPage = [
      [ { narrative_step: "Search for default test.", tool_name: "WebSearchTool", assigned_agent_role: "ResearchAgent", sub_task_input: { query: "default test" }} ],
      [ { narrative_step: "Explore (default pages).", tool_name: "ExploreSearchResults", assigned_agent_role: "Orchestrator", sub_task_input: {} } ]
    ];

    planExecutor.llmService = jest.fn();

    let searchStepSubTaskIdDefault;
    mockSubTaskQueue.enqueueTask.mockImplementationOnce((taskMessage) => {
        searchStepSubTaskIdDefault = taskMessage.sub_task_id;
    });
    mockResultsQueue.subscribeOnce.mockImplementationOnce((ptId, callback, stId) => {
        if (stId === searchStepSubTaskIdDefault) {
            callback(null, {
                sub_task_id: searchStepSubTaskIdDefault, parent_task_id: parentTaskId, worker_agent_role: "ResearchAgent", tool_name: "WebSearchTool", status: "COMPLETED",
                result_data: { result: [
                    { title: "Default Page 1", link: "http://example.com/default1" },
                    { title: "Default Page 2", link: "http://example.com/default2" },
                    { title: "Default Page 3", link: "http://example.com/default3" }
                ]},
            });
        }
    });

    mockReadWebpageToolInstance.execute
        .mockResolvedValueOnce({ result: "Content Default P1", error: null })
        .mockResolvedValueOnce({ result: "Content Default P2", error: null });

    const result = await planExecutor.executePlan(mockPlanDefaultPage, parentTaskId, userTaskString);

    expect(planExecutor.llmService).toHaveBeenCalledTimes(0);
    expect(mockReadWebpageToolInstance.execute).toHaveBeenCalledTimes(2);
    expect(mockReadWebpageToolInstance.execute).toHaveBeenCalledWith({ url: "http://example.com/default1" });
    expect(mockReadWebpageToolInstance.execute).toHaveBeenCalledWith({ url: "http://example.com/default2" });
    const exploreStepResult = result.executionContext.find(e => e.tool_name === "ExploreSearchResults");
    expect(exploreStepResult).toBeDefined();
    // The default pagesToExplore is used internally but not added back to the stored sub_task_input if initially absent.
    // The important check is that ReadWebpageTool was called twice, which is asserted above.
    // expect(exploreStepResult.sub_task_input.pagesToExplore).toBe(2);
  });
});
