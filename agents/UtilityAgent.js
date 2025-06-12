const BaseAgent = require('./BaseAgent');
const CalculatorTool = require('../tools/CalculatorTool'); // Needed for instantiation
const logger = require('../core/logger');
// Potentially FileSystemTool if it's added to UtilityAgent's capabilities

/**
 * Agent specialized in utility tasks, such as calculations.
 * Extends BaseAgent to inherit common task processing and configuration logic.
 */
class UtilityAgent extends BaseAgent {
  /**
   * Constructs a UtilityAgent.
   * @param {object} subTaskQueue - The queue for receiving sub-tasks.
   * @param {object} resultsQueue - The queue for sending results of sub-tasks.
   * @param {object} agentApiKeysConfig - Configuration object containing API keys (though less likely needed for utility tools).
   */
  constructor(subTaskQueue, resultsQueue, agentApiKeysConfig) {
    // Create a toolsMap specific to UtilityAgent
    const toolsMap = new Map();
    toolsMap.set('CalculatorTool', new CalculatorTool());
    // Example: If FileSystemTool was part of UtilityAgent
    // const FileSystemTool = require('../tools/FileSystemTool');
    // toolsMap.set('FileSystemTool', new FileSystemTool());

    // Call super with the queues, this agent's toolsMap, its role, and API keys
    super(subTaskQueue, resultsQueue, toolsMap, 'UtilityAgent', agentApiKeysConfig);
    logger.info(`${this.agentRole} initialized with tools: ${Array.from(this.toolsMap.keys()).join(', ')}.`, { agentRole: this.agentRole });
    // Note: BaseAgent's constructor loads workerAgentConfig.json for timeouts.
  }

  // startListening() is inherited from BaseAgent.

  /**
   * Validates the input for a given tool specific to the UtilityAgent.
   * @param {string} tool_name - The name of the tool (e.g., "CalculatorTool").
   * @param {object} sub_task_input - The input object for the tool.
   * @returns {{isValid: boolean, error: string|null}} Validation result.
   * @override
   */
  validateToolInput(tool_name, sub_task_input) {
    if (tool_name === 'CalculatorTool') {
      if (!sub_task_input || typeof sub_task_input.expression !== 'string') {
        return { isValid: false, error: "Invalid input for CalculatorTool: 'expression' (string) is required." };
      }
    }
    // Example: If FileSystemTool was added
    /*
    else if (tool_name === 'FileSystemTool') {
      if (!sub_task_input || typeof sub_task_input.operation !== 'string') {
        return { isValid: false, error: "Invalid input for FileSystemTool: 'operation' (string) is required." };
      }
      // Add more specific validation for FileSystemTool operations and args
    }
    */
    return { isValid: true, error: null };
  }

  /**
   * Executes the specified tool with the given input.
   * This method is called by BaseAgent after input validation and timeout setup.
   * @param {object} toolInstance - The instance of the tool to execute.
   * @param {object} sub_task_input - The validated input for the tool.
   * @param {string} tool_name - The name of the tool being executed (for context).
   * @param {object} agentApiKeysConfig - API keys configuration.
   * @returns {Promise<any>} A promise that resolves with the result of the tool execution.
   * @async
   * @override
   */
  async executeTool(toolInstance, sub_task_input, tool_name, agentApiKeysConfig) {
    // The toolInstance is already correctly selected by BaseAgent.
    return toolInstance.execute(sub_task_input);
  }
}

module.exports = UtilityAgent;
