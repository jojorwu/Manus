// tools/ReadWebpageTool.js
const axios = require('axios');

const MAX_CONTENT_LENGTH = 2000;

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
                partialHtmlContent = htmlContent.substring(0, MAX_CONTENT_LENGTH);
            } else if (typeof htmlContent === 'object' && htmlContent !== null) {
                // If the response is an object (e.g. JSON), stringify it.
                try {
                    const jsonString = JSON.stringify(htmlContent);
                    originalLength = jsonString.length;
                    partialHtmlContent = jsonString.substring(0, MAX_CONTENT_LENGTH);
                } catch (e) {
                    console.warn(`ReadWebpageTool: Could not stringify object from URL: ${input.url}`, e);
                    return { result: null, error: { category: "UNEXPECTED_CONTENT_TYPE", message: `ReadWebpageTool failed to JSON.stringify content of type object for URL: ${input.url}`, details: { originalError: e.message } } };
                }
            } else {
                // For other unexpected data types (null, boolean, number, undefined)
                console.warn(`ReadWebpageTool received unexpected data type: ${typeof htmlContent} for URL: ${input.url}`);
                return { result: null, error: { category: "UNEXPECTED_CONTENT_TYPE", message: `ReadWebpageTool received unexpected data type: ${typeof htmlContent} for URL: ${input.url}` } };
            }

            return { result: partialHtmlContent + (originalLength > MAX_CONTENT_LENGTH ? "..." : ""), error: null };

        } catch (error) {
            console.error(`Error reading webpage ${input.url}:`, error.message); // Log only message for brevity here
            if (error.response) {
                // Server responded with an error status code (4xx or 5xx)
                let responseDataLog = error.response.data;
                if (typeof responseDataLog === 'string') {
                    responseDataLog = responseDataLog.substring(0, 500) + (responseDataLog.length > 500 ? "..." : "");
                } else if (typeof responseDataLog === 'object' && responseDataLog !== null) {
                    try {
                        const jsonString = JSON.stringify(responseDataLog);
                        responseDataLog = jsonString.substring(0, 500) + (jsonString.length > 500 ? "..." : "");
                    } catch (e) {
                        responseDataLog = "[Could not stringify object]";
                    }
                } // Non-string/non-object types will be logged as is by console.error
                console.error("Error response data snippet:", responseDataLog);
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
