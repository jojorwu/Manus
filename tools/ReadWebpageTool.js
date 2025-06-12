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
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8' // Prefer HTML
                },
                // It's generally better to let axios handle response type based on Content-Type header
                // responseType: 'text'
            });

            const htmlContent = response.data;
            const contentType = response.headers['content-type'];

            if (typeof htmlContent === 'string' && (contentType && contentType.includes('html'))) {
                try {
                    const $ = cheerio.load(htmlContent);

                    // Remove unnecessary elements
                    $('script, style, noscript, iframe, header, footer, nav, aside, link, meta, head').remove();

                    let extractedText = $('body').text();

                    if (extractedText) {
                        // Replace sequences of whitespace characters with a single space
                        extractedText = extractedText.replace(/(\s|\u00A0)+/g, ' ');
                        extractedText = extractedText.trim();

                        if (extractedText.length === 0) {
                            return { result: "No meaningful text content found on the page after processing.", error: null };
                        }

                        const MAX_TEXT_LENGTH = 10000;
                        if (extractedText.length > MAX_TEXT_LENGTH) {
                            extractedText = extractedText.substring(0, MAX_TEXT_LENGTH) + "... (truncated)";
                        }
                        return { result: extractedText, error: null };
                    } else {
                        return { result: "No text content found in body after processing.", error: null };
                    }
                } catch (cheerioError) {
                    console.error(`ReadWebpageTool: Error processing HTML content with Cheerio for URL ${input.url}:`, cheerioError);
                    return { result: null, error: `Failed to process HTML content with Cheerio: ${cheerioError.message}` };
                }
            } else {
                // Fallback for non-string HTML or non-HTML content
                console.warn(`ReadWebpageTool: Content from URL ${input.url} is not a processable HTML string. ContentType: ${contentType}, typeof data: ${typeof htmlContent}`);
                if (contentType && !contentType.includes('html') && !contentType.includes('text/plain') && !contentType.includes('json')) { // if known non-textual type
                     return { result: null, error: `Failed to read webpage: Content type '${contentType}' is not processable as text.` };
                }
                // Fallback to old logic for non-HTML string data or stringified objects
                let partialContent;
                let originalLength = 0;
                let contentToProcess = typeof htmlContent === 'string' ? htmlContent : JSON.stringify(htmlContent);

                originalLength = contentToProcess.length;
                partialContent = contentToProcess.substring(0, 2000);

                return { result: `Fallback content (first 2000 chars): ${partialContent}${originalLength > 2000 ? "..." : ""}`, error: null };
            }

        } catch (error) {
            console.error(`ReadWebpageTool: Error reading webpage ${input.url}:`, error);
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
