// tools/WebSearchTool.js
const axios = require('axios');
const BaseTool = require('../core/BaseTool');

class WebSearchTool extends BaseTool {
    constructor(apiKeyConfig) {
        super("WebSearchTool");
        this.apiKey = apiKeyConfig.apiKey;
        this.cseId = apiKeyConfig.cseId;
    }

    async execute(input) {
        if (!this.apiKey || !this.cseId) {
            return this._errorResponse("CONFIGURATION_ERROR", "WebSearchTool is not configured with API key or CSE ID.");
        }

        if (!input || typeof input.query !== 'string') {
            return this._errorResponse("INVALID_INPUT", "Invalid input for WebSearchTool: 'query' string is required.");
        }

        const apiUrl = "https://www.googleapis.com/customsearch/v1";
        const queryParams = {
            key: this.apiKey,
            cx: this.cseId,
            q: input.query,
        };

        if (input.numResults !== undefined) {
            if (typeof input.numResults !== 'number' || !Number.isInteger(input.numResults) || input.numResults < 1 || input.numResults > 10) {
                return this._errorResponse(
                    "INVALID_INPUT",
                    "Optional parameter 'numResults' must be an integer between 1 and 10.",
                    { valueProvided: input.numResults }
                );
            }
            queryParams.num = input.numResults;
        }

        if (input.siteToSearch !== undefined) {
            if (typeof input.siteToSearch !== 'string') {
                return this._errorResponse(
                    "INVALID_INPUT",
                    "Optional parameter 'siteToSearch' must be a string.",
                    { valueProvided: input.siteToSearch }
                );
            }
            const trimmedSiteToSearch = input.siteToSearch.trim();
            if (trimmedSiteToSearch === "") {
                return this._errorResponse(
                    "INVALID_INPUT",
                    "Optional parameter 'siteToSearch' cannot be an empty string when provided.",
                    { valueProvided: input.siteToSearch }
                );
            }
            queryParams.siteSearch = trimmedSiteToSearch;
        }

        try {
            const response = await axios.get(apiUrl, { params: queryParams });

            if (response.data && response.data.items && Array.isArray(response.data.items)) {
                if (response.data.items.length === 0) {
                    return this._successResponse("No search results found.");
                }
                const formattedResults = response.data.items.map(item => ({
                    title: item.title || "",
                    link: item.link || "",
                    snippet: item.snippet || "",
                }));
                return this._successResponse(formattedResults);
            } else {
                // Handle cases where items might be missing or not in the expected format,
                // though the API usually returns an empty items array for no results.
                return this._successResponse("No search results found.");
            }
        } catch (error) {
            let errMsg = (error.response && error.response.data && error.response.data.error && error.response.data.error.message) ? error.response.data.error.message : error.message;
            return this._errorResponse("API_ERROR", "API request failed: " + errMsg, { originalError: error.message, statusCode: error.response ? error.response.status : undefined });
        }
    }
}

module.exports = WebSearchTool;
