// tools/ReadWebpageTool.js
const axios = require('axios');
const cheerio = require('cheerio');

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

            if (typeof htmlContent === 'string') {
                const $ = cheerio.load(htmlContent);

                // Attempt to better preserve structure
                // Convert <br> tags to newlines
                $('br').replaceWith('\n');

                // Add a newline after common block elements.
                // This is a heuristic and might not perfectly mimic browser text rendering.
                const blockElements = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'article', 'section', 'header', 'footer', 'aside', 'pre'];
                blockElements.forEach(tag => {
                    $(tag).after('\n');
                });

                let textContent = $('body').text();

                // Basic text cleaning:
                // 1. Replace multiple spaces (including those resulting from newlines converted to spaces by .text()) with a single space.
                // 2. Consolidate multiple newlines into a single newline.
                // 3. Trim whitespace from the start and end.
                textContent = textContent.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();

                // Return the extracted text
                return { result: textContent, error: null };

            } else if (typeof htmlContent === 'object') {
                // If the response is an object (e.g. JSON), stringify it.
                // No need for cheerio here, just return the stringified JSON
                const jsonString = JSON.stringify(htmlContent);
                return { result: jsonString, error: null };

            } else {
                // For other unexpected data types
                console.warn(`ReadWebpageTool received unexpected data type: ${typeof htmlContent} for URL: ${input.url}`);
                return { result: null, error: "Failed to read webpage: unexpected content type." };
            }

        } catch (error) {
            console.error(`Error reading webpage ${input.url}:`, error);
            let errorMessage = "Failed to read webpage: " + error.message;
            if (error.response) {
                // Include status code if available
                errorMessage += ` (Status: ${error.response.status})`;
                // Log more detailed error if present
                if (error.response.data) {
                     console.error("Error response data:", typeof error.response.data === 'string' ? error.response.data.substring(0,500) : error.response.data);
                }
            } else if (error.request) {
                errorMessage = "Failed to read webpage: No response received from server.";
            }
            return { result: null, error: errorMessage };
        }
    }
}

module.exports = ReadWebpageTool;
