// tools/WebSearchTool.js
const axios = require('axios');

class WebSearchTool {
    constructor(apiKeyConfig) {
        // apiKeyConfig is expected to be an object like { apiKey: "YOUR_API_KEY", cseId: "YOUR_CSE_ID" }
        // It's passed from index.js: agentApiKeysConfig.googleSearch
        if (apiKeyConfig) {
            this.apiKey = apiKeyConfig.apiKey;
            this.cseId = apiKeyConfig.cseId;
        } else {
            // Fallback or warning if apiKeyConfig is not provided, though index.js should provide it.
            console.warn("WebSearchTool: apiKeyConfig not provided during initialization. API calls will fail.");
            this.apiKey = null;
            this.cseId = null;
        }
    }

    async execute(input) {
        if (!this.apiKey || !this.cseId) {
            return { result: null, error: "WebSearchTool is not configured with API key or CSE ID. Please check server configuration." };
        }

        if (!input || typeof input.query !== 'string' || input.query.trim() === "") {
            return { result: null, error: "Invalid input for WebSearchTool: 'query' string is required and cannot be empty." };
        }

        const apiUrl = "https://www.googleapis.com/customsearch/v1";
        const queryParams = {
            key: this.apiKey,
            cx: this.cseId,
            q: input.query,
        };

        try {
            // console.log(`WebSearchTool: Performing search for query "${input.query}" with CSE ID "${this.cseId ? this.cseId.substring(0,5) + '...' : 'N/A'}"`); // Debug log
            const response = await axios.get(apiUrl, { params: queryParams });

            if (response.data && response.data.items && Array.isArray(response.data.items)) {
                if (response.data.items.length === 0) {
                    // console.log(`WebSearchTool: No search results found for query "${input.query}".`); // Debug log
                    return { result: "No search results found.", error: null };
                }
                const formattedResults = response.data.items.map(item => ({
                    title: item.title,
                    link: item.link,
                    snippet: item.snippet,
                }));
                // console.log(`WebSearchTool: Successfully fetched ${formattedResults.length} results for query "${input.query}".`); // Debug log
                return { result: formattedResults, error: null };
            } else {
                // Handle cases where items might be missing or not in the expected format,
                // though the API usually returns an empty items array for no results.
                console.warn(`WebSearchTool: Unexpected response structure for query "${input.query}". Response data keys:`, response.data ? Object.keys(response.data) : 'null/undefined');
                return { result: "Search results in unexpected format or no results found.", error: null };
            }
        } catch (error) {
            console.error(`Error during web search API call for query "${input.query}":`, error.message);
            let errorMessage = "API request failed: " + error.message;
            if (error.response && error.response.data && error.response.data.error && error.response.data.error.message) {
                errorMessage = "API request failed: " + error.response.data.error.message;
                 // console.error("Detailed API error for query '" + input.query + "':", JSON.stringify(error.response.data.error, null, 2)); // More detailed server log
            } else if (error.response) {
                // console.error(`API error response status for query '${input.query}': ${error.response.status}`);
                // console.error(`API error response data for query '${input.query}':`, typeof error.response.data === 'string' ? error.response.data.substring(0,500) : error.response.data);
                errorMessage += ` (Status: ${error.response.status})`;
            }
            return { result: null, error: errorMessage };
        }
    }
}

module.exports = WebSearchTool;
