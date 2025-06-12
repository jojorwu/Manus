// tools/ReadWebpageTool.js
const axios = require('axios');

class ReadWebpageTool {
    constructor() {
        // console.log("ReadWebpageTool initialized.");
    }

    async execute(input) {
        if (!input || typeof input.url !== 'string' || input.url.trim() === "") {
            return { result: null, error: { category: "INVALID_INPUT", message: "Invalid input for ReadWebpageTool: 'url' string is required and cannot be empty." } };
        }

        try {
            const response = await axios.get(input.url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            const htmlContent = response.data;

            let partialHtmlContent;
            let originalLength = 0;

            if (typeof htmlContent === 'string') {
                originalLength = htmlContent.length;
                partialHtmlContent = htmlContent.substring(0, 2000);
            } else if (typeof htmlContent === 'object') {
                // If the response is an object (e.g. JSON), stringify it.
                const jsonString = JSON.stringify(htmlContent);
                originalLength = jsonString.length;
                partialHtmlContent = jsonString.substring(0, 2000);
            } else {
                // For other unexpected data types
                console.warn(`ReadWebpageTool received unexpected data type: ${typeof htmlContent} for URL: ${input.url}`);
                return { result: null, error: { category: "UNEXPECTED_CONTENT_TYPE", message: `ReadWebpageTool received unexpected data type: ${typeof htmlContent} for URL: ${input.url}` } };
            }

            return { result: partialHtmlContent + (originalLength > 2000 ? "..." : ""), error: null };

        } catch (error) {
            console.error(`Error reading webpage ${input.url}:`, error.message); // Log only message for brevity here
            if (error.response) {
                // Server responded with an error status code (4xx or 5xx)
                console.error("Error response data:", typeof error.response.data === 'string' ? error.response.data.substring(0,200) : error.response.data);
                return { result: null, error: { category: "RESOURCE_ACCESS_ERROR", message: `Failed to read webpage: Server responded with status ${error.response.status}`, details: { httpStatusCode: error.response.status, originalError: error.message } } };
            } else if (error.request) {
                // No response was received from the server
                return { result: null, error: { category: "RESOURCE_ACCESS_ERROR", message: "Failed to read webpage: No response received from server.", details: { originalError: error.message } } };
            } else {
                // Other errors (e.g., setup issues, network problems before request was made)
                return { result: null, error: { category: "RESOURCE_ACCESS_ERROR", message: "Failed to read webpage: " + error.message, details: { originalError: error.message } } };
            }
        }
    }
}

module.exports = ReadWebpageTool;
