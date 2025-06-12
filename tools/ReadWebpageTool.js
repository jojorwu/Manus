// tools/ReadWebpageTool.js
const axios = require('axios');

class ReadWebpageTool {
    constructor() {
        // console.log("ReadWebpageTool initialized.");
    }

    async execute(input) {
        if (!input || typeof input.url !== 'string' || input.url.trim() === "") {
            return { result: null, error: "Invalid input for ReadWebpageTool: 'url' string is required." };
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
                return { result: null, error: "Failed to read webpage: unexpected content type." };
            }

            return { result: partialHtmlContent + (originalLength > 2000 ? "..." : ""), error: null };

        } catch (error) {
            console.error(`Error reading webpage ${input.url}:`, error.message); // Log only message for brevity in general logs
            let errorMessage = "Failed to read webpage: " + error.message;
            if (error.response) {
                // Include status code if available
                errorMessage += ` (Status: ${error.response.status})`;
                // Log more detailed error if present (e.g. to a debug log or tracing system)
                // console.error("Error response data:", typeof error.response.data === 'string' ? error.response.data.substring(0,500) : error.response.data);
            } else if (error.request) {
                errorMessage = "Failed to read webpage: No response received from server.";
            }
            // For security, avoid logging the full error object directly to the user/client-facing error message.
            // The console.error above is for server-side logging.
            return { result: null, error: errorMessage };
        }
    }
}

module.exports = ReadWebpageTool;
