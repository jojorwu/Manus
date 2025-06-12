const BaseAgent = require('./BaseAgent');
const WebSearchTool = require('../tools/WebSearchTool'); // Needed for instantiation
const ReadWebpageTool = require('../tools/ReadWebpageTool'); // Needed for instantiation
const logger = require('../core/logger');

/**
 * Agent specialized in research tasks, utilizing tools like web search and webpage reading.
 * Extends BaseAgent to inherit common task processing and configuration logic.
 */
class ResearchAgent extends BaseAgent {
  /**
   * Constructs a ResearchAgent.
   * @param {object} subTaskQueue - The queue for receiving sub-tasks.
   * @param {object} resultsQueue - The queue for sending results of sub-tasks.
   * @param {object} agentApiKeysConfig - Configuration object containing API keys (e.g., for SerpAPI).
   */
  constructor(subTaskQueue, resultsQueue, agentApiKeysConfig) {
    // Create a toolsMap specific to ResearchAgent
    const toolsMap = new Map();
    toolsMap.set('WebSearchTool', new WebSearchTool(agentApiKeysConfig?.serpapi_api_key));
    toolsMap.set('ReadWebpageTool', new ReadWebpageTool());

    // Call super with the queues, this agent's toolsMap, its role, and API keys
    super(subTaskQueue, resultsQueue, toolsMap, 'ResearchAgent', agentApiKeysConfig);
    logger.info(`${this.agentRole} initialized with tools: ${Array.from(this.toolsMap.keys()).join(', ')}.`, { agentRole: this.agentRole });
    // Note: BaseAgent's constructor now loads workerAgentConfig.json for timeouts.
  }

  // startListening() is inherited from BaseAgent, no need to redefine if behavior is identical.
  // BaseAgent's startListening uses this.subTaskQueue.subscribeToRole,
  // if ResearchAgent needs this.subTaskQueue.subscribe, then startListening would need to be overridden.
  // For now, assuming subscribeToRole is the intended method for BaseAgent.

  /**
   * Validates the input for a given tool specific to the ResearchAgent.
   * @param {string} tool_name - The name of the tool (e.g., "WebSearchTool", "ReadWebpageTool").
   * @param {object} sub_task_input - The input object for the tool.
   * @returns {{isValid: boolean, error: string|null}} Validation result.
   * @override
   */
  validateToolInput(tool_name, sub_task_input) {
    if (tool_name === 'WebSearchTool') {
      if (!sub_task_input || typeof sub_task_input.query !== 'string') {
        return { isValid: false, error: "Invalid input for WebSearchTool: 'query' (string) is required." };
      }
    } else if (tool_name === 'ReadWebpageTool') {
      if (!sub_task_input || typeof sub_task_input.url !== 'string') {
        return { isValid: false, error: "Invalid input for ReadWebpageTool: 'url' (string) is required." };
      }
      try {
        const url = new URL(sub_task_input.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return { isValid: false, error: "Invalid URL protocol. Only HTTP/HTTPS are allowed." };
        }
      } catch (e) {
        return { isValid: false, error: "Invalid URL format." };
      }
    }
    // Add more validation for other tools as needed
    return { isValid: true, error: null };
  }

  /**
   * Executes the specified tool with the given input.
   * This method is called by BaseAgent after input validation and timeout setup.
   * @param {object} toolInstance - The instance of the tool to execute.
   * @param {object} sub_task_input - The validated input for the tool.
   * @param {string} tool_name - The name of the tool being executed (for context).
   * @param {object} agentApiKeysConfig - API keys configuration (rarely needed here as tools are pre-configured).
   * @returns {Promise<any>} A promise that resolves with the result of the tool execution.
   * @async
   * @override
   */
  async executeTool(toolInstance, sub_task_input, tool_name, agentApiKeysConfig) {
    // The toolInstance is already correctly selected by BaseAgent.
    // agentApiKeysConfig is available if needed by a specific tool's execute method, though typically
    // keys are passed during tool instantiation (as done in the constructor for WebSearchTool).
    return toolInstance.execute(sub_task_input);
  }
}

module.exports = ResearchAgent;
