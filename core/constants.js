// core/constants.js
const ExecutionModes = {
    EXECUTE_FULL_PLAN: "EXECUTE_FULL_PLAN",
    PLAN_ONLY: "PLAN_ONLY",
    SYNTHESIZE_ONLY: "SYNTHESIZE_ONLY",
};

const TaskStatuses = {
    PLAN_GENERATED: "PLAN_GENERATED",
    COMPLETED: "COMPLETED",
    FAILED_PLANNING: "FAILED_PLANNING",
    FAILED_EXECUTION: "FAILED_EXECUTION",
    FAILED: "FAILED", // From sub-task results
    // Add any other statuses used if identified later
};

module.exports = {
    ExecutionModes,
    TaskStatuses,
};
