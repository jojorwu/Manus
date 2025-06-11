// tools/CalculatorTool.js
const math = require('mathjs');

class CalculatorTool {
    constructor() {
        // console.log("CalculatorTool initialized.");
    }

    async execute(input) {
        console.warn(`CalculatorTool (stub) called with:`, input);
        if (!input || typeof input.expression !== 'string') {
            return { result: null, error: "Invalid input for CalculatorTool: 'expression' string is required." };
        }
        try {
            const result = math.evaluate(input.expression);
            return { result: result, error: null };
        } catch (e) {
            return { result: null, error: e.message };
        }
    }
}

module.exports = CalculatorTool;
