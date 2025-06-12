const UtilityAgent = require('../UtilityAgent');
const BaseAgent = require('../BaseAgent'); // To check instanceof
const CalculatorTool = require('../../tools/CalculatorTool');

// Mock dependencies
jest.mock('../../tools/CalculatorTool');

const mockSubTaskQueue = { subscribeToRole: jest.fn() };
const mockResultsQueue = { enqueueResult: jest.fn() };
const mockAgentApiKeysConfig = {}; // Utility tools might not need API keys

describe('UtilityAgent', () => {
  let agent;

  beforeEach(() => {
    CalculatorTool.mockClear();
    agent = new UtilityAgent(mockSubTaskQueue, mockResultsQueue, mockAgentApiKeysConfig);
  });

  it('should be an instance of BaseAgent', () => {
    expect(agent instanceof BaseAgent).toBe(true);
  });

  it('constructor should initialize toolsMap correctly', () => {
    expect(agent.toolsMap.has('CalculatorTool')).toBe(true);
    expect(agent.toolsMap.get('CalculatorTool') instanceof CalculatorTool).toBe(true);
    expect(CalculatorTool).toHaveBeenCalled(); // No args for CalculatorTool constructor

    expect(agent.agentRole).toBe('UtilityAgent');
  });

  describe('validateToolInput', () => {
    it('CalculatorTool should be valid with correct input', () => {
      const result = agent.validateToolInput('CalculatorTool', { expression: '2 + 2' });
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });

    it('CalculatorTool should be invalid without expression', () => {
      const result = agent.validateToolInput('CalculatorTool', {});
      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Invalid input for CalculatorTool: 'expression' (string) is required.");
    });

    it('CalculatorTool should be invalid with non-string expression', () => {
      const result = agent.validateToolInput('CalculatorTool', { expression: 123 });
      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Invalid input for CalculatorTool: 'expression' (string) is required.");
    });

    it('should return valid for an unknown tool (as per current BaseAgent design)', () => {
      // Similar to ResearchAgent, testing current fall-through behavior.
      const result = agent.validateToolInput('UnknownTool', { data: 'any' });
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });
  });

  describe('executeTool', () => {
    it('should call execute on the provided toolInstance', async () => {
      const mockToolInstance = { execute: jest.fn().mockResolvedValue(4) }; // CalculatorTool returns a number
      const subTaskInput = { expression: '2 * 2' };

      const result = await agent.executeTool(mockToolInstance, subTaskInput, 'CalculatorTool', {});

      expect(mockToolInstance.execute).toHaveBeenCalledWith(subTaskInput);
      expect(result).toBe(4);
    });
  });
});
