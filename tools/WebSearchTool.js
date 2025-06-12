// tools/WebSearchTool.js
const axios = require('axios');

class WebSearchTool {
    constructor(apiKeyConfig) {
        this.apiKey = apiKeyConfig.apiKey;
        this.cseId = apiKeyConfig.cseId;
    }

    async execute(input) {
        if (!this.apiKey || !this.cseId) {
            return { result: null, error: { category: "CONFIGURATION_ERROR", message: "WebSearchTool is not configured with API key or CSE ID." } };
        }

        if (!input || typeof input.query !== 'string') {
            return { result: null, error: { category: "INVALID_INPUT", message: "Invalid input for WebSearchTool: 'query' string is required." } };
        }

        const apiUrl = "https://www.googleapis.com/customsearch/v1";
        const queryParams = {
            key: this.apiKey,
            cx: this.cseId,
            q: input.query,
        };

        try {
            const response = await axios.get(apiUrl, { params: queryParams });

            if (response.data && response.data.items && Array.isArray(response.data.items)) {
                if (response.data.items.length === 0) {
                    return { result: "No search results found.", error: null };
                }
                const formattedResults = response.data.items.map(item => ({
                    title: item.title || "",
                    link: item.link || "",
                    snippet: item.snippet || "",
                }));
                return { result: formattedResults, error: null };
            } else {
                // Handle cases where items might be missing or not in the expected format,
                // though the API usually returns an empty items array for no results.
                return { result: "No search results found.", error: null }; // No change here, as it's a valid "empty" result.
            }
        } catch (error) {
            console.error("Error during web search API call:", error);
            let errMsg = (error.response && error.response.data && error.response.data.error && error.response.data.error.message) ? error.response.data.error.message : error.message;
            return { result: null, error: { category: "API_ERROR", message: "API request failed: " + errMsg, details: { originalError: error.message, statusCode: error.response ? error.response.status : undefined } } };
        }
    }
}

module.exports = WebSearchTool;
