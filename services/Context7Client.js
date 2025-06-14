// File: services/Context7Client.js
const axios = require('axios');
const { v4: uuidv4 } = require('uuid'); // For generating unique request IDs

class Context7Client {
    constructor(serverUrl = 'http://localhost:8080/mcp') {
        this.serverUrl = serverUrl;
        this.httpClient = axios.create({
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream'
            }
        });
        // console.log(`Context7Client: Initialized for server URL: ${this.serverUrl}`); // Use t() later
    }

    async _sendRpcRequest(methodName, toolName, toolArgs) {
        const requestId = uuidv4();
        const payload = {
            jsonrpc: '2.0',
            id: requestId,
            method: methodName, // Should be 'tools/call'
            params: {
                tool: {
                    name: toolName,
                    args: toolArgs
                }
            }
        };

        // console.log(`Context7Client: Sending RPC request (ID: ${requestId}) to ${this.serverUrl}, Method: ${methodName}, Tool: ${toolName}, Args:`, toolArgs); // Use t()

        try {
            const response = await this.httpClient.post(this.serverUrl, payload);

            // console.log(`Context7Client: Received RPC response (ID: ${requestId}), Status: ${response.status}`); // Use t()

            if (response.data.jsonrpc !== '2.0' || response.data.id !== requestId) {
                throw new Error('Invalid JSON-RPC response: ID mismatch or version incorrect.');
            }

            if (response.data.error) {
                // console.error(`Context7Client: RPC Error (ID: ${requestId}):`, response.data.error); // Use t()
                throw new Error(`Context7 RPC Error (Tool: ${toolName}): ${response.data.error.message} (Code: ${response.data.error.code})`);
            }

            if (response.data.result && response.data.result.tool && response.data.result.tool.name === toolName) {
                // The actual result of the tool call is nested
                return response.data.result.tool.result;
            } else {
                 // This case might indicate an unexpected structure even in a successful RPC call
                // console.warn(`Context7Client: RPC Response (ID: ${requestId}) structure unexpected or tool name mismatch. Full result:`, response.data.result); // Use t()
                if (response.data.result && response.data.result.tool && response.data.result.tool.name !== toolName) {
                    throw new Error(`Context7 RPC Response: Tool name mismatch. Expected ${toolName}, got ${response.data.result.tool.name}.`);
                }
                if (response.data.result && !response.data.result.tool) {
                     throw new Error(`Context7 RPC Response: Missing 'tool' object in result.`);
                }
                return response.data.result && response.data.result.tool ? response.data.result.tool.result : undefined;
            }

        } catch (error) {
            let errorMessage = `Context7Client: Failed to call tool '${toolName}'. `;
            if (error.response) {
                // console.error(`Context7Client: HTTP Error calling ${this.serverUrl} (ID: ${requestId}): ${error.response.status}`, error.response.data); // Use t()
                errorMessage += `HTTP Status ${error.response.status}. Response: ${JSON.stringify(error.response.data)}`;
            } else if (error.request) {
                // console.error(`Context7Client: No response received from ${this.serverUrl} (ID: ${requestId}):`, error.request); // Use t()
                errorMessage += `No response from server.`;
            } else if (error.message.startsWith('Context7 RPC Error')) {
                errorMessage = error.message;
            }
            else {
                // console.error(`Context7Client: Error during RPC call (ID: ${requestId}):`, error.message); // Use t()
                errorMessage += error.message;
            }
            throw new Error(errorMessage);
        }
    }

    async resolveLibraryId(libraryName) {
        if (!libraryName || typeof libraryName !== 'string' || libraryName.trim() === '') {
            throw new Error("Context7Client.resolveLibraryId: libraryName must be a non-empty string.");
        }
        // console.log(`Context7Client: Resolving library ID for "${libraryName}"...`); // Use t()
        const result = await this._sendRpcRequest('tools/call', 'resolve-library-id', { libraryName });
        if (typeof result !== 'string') {
            // console.warn(`Context7Client.resolveLibraryId: Expected a string ID for "${libraryName}", but received:`, result); // Use t()
            throw new Error(`Context7Client.resolveLibraryId: Unexpected result type for library ID of "${libraryName}". Expected string, got ${typeof result}.`);
        }
        return result;
    }

    async getLibraryDocs(libraryId, topic = null, maxTokens = 10000) {
        if (!libraryId || typeof libraryId !== 'string' || libraryId.trim() === '') {
            throw new Error("Context7Client.getLibraryDocs: libraryId must be a non-empty string.");
        }
        // console.log(`Context7Client: Getting library docs for ID "${libraryId}", Topic: ${topic}, MaxTokens: ${maxTokens}...`); // Use t()

        const args = {
            context7CompatibleLibraryID: libraryId,
            tokens: maxTokens
        };
        if (topic && typeof topic === 'string' && topic.trim() !== '') {
            args.topic = topic;
        }

        const result = await this._sendRpcRequest('tools/call', 'get-library-docs', args);
         if (typeof result !== 'string') {
            // console.warn(`Context7Client.getLibraryDocs: Expected a string documentation for ID "${libraryId}", but received:`, result); // Use t()
            throw new Error(`Context7Client.getLibraryDocs: Unexpected result type for documentation of ID "${libraryId}". Expected string, got ${typeof result}.`);
        }
        return result;
    }
}

module.exports = Context7Client;
