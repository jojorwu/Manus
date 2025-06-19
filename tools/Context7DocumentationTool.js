// File: tools/Context7DocumentationTool.js
// const { t } = require('../utils/localization'); // For future localization of logs
// eslint-disable-next-line no-unused-vars -- Used in constructor for instanceof check and type validation
const Context7Client = require('../services/Context7Client'); // Adjust path if Context7Client is elsewhere

class Context7DocumentationTool {
    constructor(context7ClientInstance) {
        // Although Context7Client might not be directly used as a variable after this,
        // it's kept for potential instanceof checks or if direct static calls were ever needed.
        // The primary use is to ensure context7ClientInstance is of the expected type/interface.
        if (!context7ClientInstance || typeof context7ClientInstance.resolveLibraryId !== 'function' || typeof context7ClientInstance.getLibraryDocs !== 'function') {
            // console.error(t('C7TOOL_ERROR_INVALID_CLIENT')); // Or a more direct error for now
            throw new Error("Context7DocumentationTool: Invalid Context7Client instance provided.");
        }
        this.client = context7ClientInstance;
        // console.log(t('C7TOOL_INIT_DONE', { serviceName: 'Context7DocumentationTool' }));
    }

    /**
     * Fetches documentation for a given library name, optionally focused on a topic.
     * This method encapsulates the two-step process: resolving library ID and then getting docs.
     * @param {object} input - The input object.
     * @param {string} input.libraryName - The common name of the library (e.g., "React", "Next.js").
     * @param {string} [input.topic] - Optional topic to focus the documentation on (e.g., "hooks", "routing").
     * @param {number} [input.maxTokens=5000] - Optional max number of tokens for the documentation.
     * @returns {Promise<{result: string, error?: string}>} An object containing the documentation text or an error message.
     */
    async execute(input) {
        const { libraryName, topic = null, maxTokens = 5000 } = input;

        if (!libraryName || typeof libraryName !== 'string' || libraryName.trim() === '') {
            // console.warn(t('C7TOOL_WARN_INVALID_LIB_NAME'));
            return { result: null, error: "Invalid input: 'libraryName' must be a non-empty string." };
        }

        // console.log(t('C7TOOL_LOG_FETCHING_DOCS', { libraryName, topic }));
        try {
            // Step 1: Resolve Library ID
            // console.log(t('C7TOOL_LOG_RESOLVING_ID', { libraryName }));
            const libraryId = await this.client.resolveLibraryId(libraryName);

            if (!libraryId || libraryId.trim() === '') {
                // console.warn(t('C7TOOL_WARN_ID_NOT_RESOLVED', { libraryName }));
                return { result: null, error: `Could not resolve library ID for "${libraryName}". The library might not be supported by Context7.` };
            }
            // console.log(t('C7TOOL_LOG_ID_RESOLVED', { libraryName, libraryId }));

            // Step 2: Get Library Documentation
            // console.log(t('C7TOOL_LOG_GETTING_DOCS', { libraryId, topic }));
            const documentation = await this.client.getLibraryDocs(libraryId, topic, maxTokens);

            if (documentation === null || documentation.trim() === '') {
                // console.log(t('C7TOOL_LOG_DOCS_EMPTY', { libraryId, topic }));
                 return { result: `No specific documentation found for library ID "${libraryId}" (topic: ${topic || 'general'}).`, error: null };
            }

            // console.log(t('C7TOOL_LOG_DOCS_RECEIVED', { libraryId, topic, length: documentation.length }));
            return { result: documentation, error: null };

        } catch (error) {
            // console.error(t('C7TOOL_ERROR_FETCH_FAILED', { libraryName, errorMessage: error.message }), error);
            if (error.message && error.message.startsWith('Context7Client') || error.message.startsWith('Context7 RPC Error')) {
                 return { result: null, error: error.message };
            }
            return { result: null, error: `Failed to fetch documentation for "${libraryName}": ${error.message}` };
        }
    }
}

module.exports = Context7DocumentationTool;
