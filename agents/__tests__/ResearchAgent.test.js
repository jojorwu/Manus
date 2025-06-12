const ResearchAgent = require('../ResearchAgent');
const BaseAgent = require('../BaseAgent'); // To check instanceof
const WebSearchTool = require('../../tools/WebSearchTool');
const ReadWebpageTool = require('../../tools/ReadWebpageTool');

// Mock dependencies
jest.mock('../../tools/WebSearchTool');
jest.mock('../../tools/ReadWebpageTool');

const mockSubTaskQueue = { subscribeToRole: jest.fn() };
const mockResultsQueue = { enqueueResult: jest.fn() };
const mockAgentApiKeysConfig = { serpapi_api_key: 'test_serp_api_key' };

describe('ResearchAgent', () => {
  let agent;

  beforeEach(() => {
    // Reset mocks for tools constructor calls if they are stateful or you want to count calls
    WebSearchTool.mockClear();
    ReadWebpageTool.mockClear();
    agent = new ResearchAgent(mockSubTaskQueue, mockResultsQueue, mockAgentApiKeysConfig);
  });

  it('should be an instance of BaseAgent', () => {
    expect(agent instanceof BaseAgent).toBe(true);
  });

  it('constructor should initialize toolsMap correctly', () => {
    expect(agent.toolsMap.has('WebSearchTool')).toBe(true);
    expect(agent.toolsMap.get('WebSearchTool') instanceof WebSearchTool).toBe(true);
    expect(WebSearchTool).toHaveBeenCalledWith(mockAgentApiKeysConfig.serpapi_api_key);

    expect(agent.toolsMap.has('ReadWebpageTool')).toBe(true);
    expect(agent.toolsMap.get('ReadWebpageTool') instanceof ReadWebpageTool).toBe(true);
    expect(ReadWebpageTool).toHaveBeenCalled(); // No args for ReadWebpageTool constructor

    expect(agent.agentRole).toBe('ResearchAgent');
  });

  describe('validateToolInput', () => {
    it('WebSearchTool should be valid with correct input', () => {
      const result = agent.validateToolInput('WebSearchTool', { query: 'test query' });
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });

    it('WebSearchTool should be invalid without query', () => {
      const result = agent.validateToolInput('WebSearchTool', {});
      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Invalid input for WebSearchTool: 'query' (string) is required.");
    });

    it('WebSearchTool should be invalid with non-string query', () => {
      const result = agent.validateToolInput('WebSearchTool', { query: 123 });
      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Invalid input for WebSearchTool: 'query' (string) is required.");
    });

    it('ReadWebpageTool should be valid with correct input', () => {
      const result = agent.validateToolInput('ReadWebpageTool', { url: 'http://example.com' });
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });

    it('ReadWebpageTool should be invalid without URL', () => {
      const result = agent.validateToolInput('ReadWebpageTool', {});
      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Invalid input for ReadWebpageTool: 'url' (string, valid HTTP/HTTPS URL) is required.");
    });

    it('ReadWebpageTool should be invalid with non-string URL', () => {
      const result = agent.validateToolInput('ReadWebpageTool', { url: 123 });
      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Invalid input for ReadWebpageTool: 'url' (string, valid HTTP/HTTPS URL) is required.");
    });

    it('ReadWebpageTool should be invalid with non-http(s) URL', () => {
      const result = agent.validateToolInput('ReadWebpageTool', { url: 'ftp://example.com' });
      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Invalid input for ReadWebpageTool: 'url' (string, valid HTTP/HTTPS URL) is required.");
    });

    it('should return valid for an unknown tool (as per current BaseAgent design, validation is tool-specific)', () => {
        // BaseAgent calls validateToolInput. If the tool isn't one of the specific ones,
        // the current ResearchAgent implementation falls through and returns {isValid: true, error: null}.
        // This might be desired or might indicate a need for more strict validation (e.g., unknown tool = invalid).
        // For now, testing current behavior.
      const result = agent.validateToolInput('UnknownTool', { data: 'any' });
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });
  });

  describe('executeTool', () => {
    it('should call execute on the provided toolInstance', async () => {
      const mockToolInstance = { execute: jest.fn().mockResolvedValue('tool result') };
      const subTaskInput = { query: 'test' };

      const result = await agent.executeTool(mockToolInstance, subTaskInput, 'AnyToolForThisTest', {});

      expect(mockToolInstance.execute).toHaveBeenCalledWith(subTaskInput);
      expect(result).toBe('tool result');
    });
  });
});
