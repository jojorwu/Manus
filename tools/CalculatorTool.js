// tools/CalculatorTool.js
const math = require('mathjs');

class CalculatorTool {
    constructor() {
        // console.log("CalculatorTool initialized.");
    }

    async execute(input) {
        // console.log(`CalculatorTool: Received input for execute:`, input); // Debug log
        if (!input || typeof input.expression !== 'string' || input.expression.trim() === "") {
            // console.error("CalculatorTool: Invalid input. 'expression' string is required and cannot be empty."); // Debug log
            return { result: null, error: "Invalid input for CalculatorTool: 'expression' string is required and cannot be empty." };
        }

        try {
            // The math.evaluate function can throw errors for invalid expressions (e.g. syntax errors, division by zero)
            const calculationResult = math.evaluate(input.expression);

            // math.js can return functions or complex objects for some expressions,
            // ensure we are returning a serializable result, typically a number or string.
            if (typeof calculationResult === 'function' || (typeof calculationResult === 'object' && calculationResult !== null && !Array.isArray(calculationResult))) {
                // console.warn(`CalculatorTool: Expression "${input.expression}" resulted in a non-serializable type. Returning as string.`); // Debug log
                return { result: String(calculationResult), error: null };
            }

            // console.log(`CalculatorTool: Successfully evaluated expression "${input.expression}". Result: ${calculationResult}`); // Debug log
            return { result: calculationResult, error: null };
        } catch (e) {
            // Errors from math.evaluate (e.g., "Division by zero", "Invalid expression") are caught here.
            console.error(`CalculatorTool: Error evaluating expression "${input.expression}": ${e.message}`); // Log the actual error
            return { result: null, error: e.message }; // Return the error message from math.js
        }
    }
}

module.exports = CalculatorTool;
