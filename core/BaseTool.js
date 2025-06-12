// core/BaseTool.js
class BaseTool {
    constructor(toolName) {
        this.toolName = toolName || this.constructor.name;
    }

    _successResponse(data) {
        return { result: data, error: null };
    }

    _errorResponse(category, message, details = {}) {
        const errorObject = { category, message, details };
        console.error(`[${this.toolName}] Error: ${category} - ${message}`, details.originalError || '');
        if (details.httpStatusCode) {
            console.error(`[${this.toolName}] HTTP Status Code: ${details.httpStatusCode}`);
        }
        return { result: null, error: errorObject };
    }
}

module.exports = BaseTool;
