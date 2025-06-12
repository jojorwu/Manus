// tools/WebSearchTool.js
const axios = require('axios');

class WebSearchTool {
    constructor(apiKeyConfig) {
        this.apiKey = apiKeyConfig.apiKey;
        this.cseId = apiKeyConfig.cseId;
    }

    async execute(input) {
        if (!this.apiKey || !this.cseId) {
            return { result: null, error: "WebSearchTool is not configured with API key or CSE ID." };
        }

        if (!input || typeof input.query !== 'string') {
            return { result: null, error: "Invalid input for WebSearchTool: 'query' string is required." };
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
                    title: item.title,
                    link: item.link,
                    snippet: item.snippet,
                }));
                return { result: formattedResults, error: null };
            } else {
                // Handle cases where items might be missing or not in the expected format,
                // though the API usually returns an empty items array for no results.
                return { result: "No search results found.", error: null };
            }
        } catch (error) {
            console.error("Error during web search API call:", error);
            let errorMessage = "API request failed: " + error.message;
            if (error.response && error.response.data && error.response.data.error && error.response.data.error.message) {
                errorMessage = "API request failed: " + error.response.data.error.message;
            }
            return { result: null, error: errorMessage };
        }
    }
}

module.exports = WebSearchTool;
