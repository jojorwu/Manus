const EventEmitter = require('events');
const logger = require('../core/logger'); // Import the logger

class ResultsQueue extends EventEmitter {
  constructor() {
    super();
    this.pendingResults = new Map(); // Stores results: parentTaskId -> { subTaskId: resultMessage }
    this.subscribers = new Map();    // Stores subscribers: compositeKey -> { callback, timer, sub_task_id }
    this.DEFAULT_TIMEOUT_MS = 30000; // Default timeout for subscribers
  }

  _getCompositeKey(parentTaskId, subTaskId) {
    if (!parentTaskId || !subTaskId) {
        logger.error("ResultsQueue:_getCompositeKey: parentTaskId and subTaskId must be provided.", { parentTaskId, subTaskId});
        // Or throw an error, depending on how strict we want to be.
        // For now, returning a key that's unlikely to match might be safer than throwing.
        return `INVALID_KEY__${parentTaskId}__${subTaskId}`;
    }
    return `${parentTaskId}__${subTaskId}`;
  }

  enqueueResult(parentTaskId, resultMessage) {
    if (!resultMessage || !parentTaskId || !resultMessage.sub_task_id) {
        logger.error("ResultsQueue:enqueueResult: Invalid result message or missing IDs.", { parentTaskId, resultMessage });
        return;
    }
    const { sub_task_id } = resultMessage;
    const resultKey = this._getCompositeKey(parentTaskId, sub_task_id);

    logger.info(`ResultsQueue: Enqueuing result.`, { parentTaskId, subTaskId: sub_task_id, resultKey });
    logger.debug(`ResultsQueue: Full result message for enqueue:`, { resultMessage });


    const subscriberDetails = this.subscribers.get(resultKey);
    if (subscriberDetails) {
      logger.info(`ResultsQueue: Found subscriber for resultKey '${resultKey}'. Delivering result.`, { parentTaskId, subTaskId: sub_task_id });
      clearTimeout(subscriberDetails.timer); // Clear the timeout timer
      subscriberDetails.callback(null, resultMessage);
      this.subscribers.delete(resultKey); // Remove subscriber after delivering result
      // Result is passed directly, not added to pendingResults if subscriber is found immediately.
    } else {
      logger.info(`ResultsQueue: No immediate subscriber for resultKey '${resultKey}'. Storing result.`, { parentTaskId, subTaskId: sub_task_id });
      if (!this.pendingResults.has(parentTaskId)) {
        this.pendingResults.set(parentTaskId, {});
      }
      this.pendingResults.get(parentTaskId)[sub_task_id] = resultMessage;
    }
    this.emit('newResult', resultMessage); // General event for any new result
  }

  // This method might need adjustment based on how pendingResults is structured now.
  // Or it might be deprecated if subscribeOnce is the only way results are consumed by orchestrator.
  dequeueResultsByParentTaskId(parentTaskId) {
    logger.info(`ResultsQueue: Dequeuing all results for parent_task_id ${parentTaskId}`, { parentTaskId });
    const parentResults = this.pendingResults.get(parentTaskId);
    if (parentResults) {
        const allResults = Object.values(parentResults);
        this.pendingResults.delete(parentTaskId);
        return allResults;
    }
    return [];
  }

  subscribeOnce(parentTaskId, callback, sub_task_id, timeout = this.DEFAULT_TIMEOUT_MS) {
    if (!sub_task_id) {
        const errorMsg = "ResultsQueue:subscribeOnce: sub_task_id is required for subscription.";
        logger.error(errorMsg, { parentTaskId });
        callback(new Error(errorMsg), null);
        return;
    }
    const resultKey = this._getCompositeKey(parentTaskId, sub_task_id);
    logger.info(`ResultsQueue: New subscription for resultKey '${resultKey}'.`, { parentTaskId, subTaskId: sub_task_id, timeout });

    // Check if the result is already in the pendingResults
    const parentPendingResults = this.pendingResults.get(parentTaskId);
    if (parentPendingResults && parentPendingResults[sub_task_id]) {
      const existingResult = parentPendingResults[sub_task_id];
      logger.info(`ResultsQueue: Immediately providing existing result for resultKey '${resultKey}'.`, { parentTaskId, subTaskId: sub_task_id });
      delete parentPendingResults[sub_task_id]; // Consume it
      if (Object.keys(parentPendingResults).length === 0) {
          this.pendingResults.delete(parentTaskId);
      }
      callback(null, existingResult);
      return;
    }

    // If result not found immediately, set up subscriber with timeout
    const timer = setTimeout(() => {
      // This callback is only invoked by the timeout itself
      if (this.subscribers.has(resultKey)) { // Check if subscriber still exists (wasn't cleared by a result)
        const timeoutError = new Error(`Timeout waiting for result for sub_task_id ${sub_task_id} (parent: ${parentTaskId})`);
        logger.warn(`ResultsQueue: Subscription timed out for resultKey '${resultKey}'.`, { parentTaskId, subTaskId: sub_task_id });

        const subscriberDetails = this.subscribers.get(resultKey);
        if(subscriberDetails){ // Should always be true if this.subscribers.has(resultKey)
             subscriberDetails.callback(timeoutError, null);
        }
        this.subscribers.delete(resultKey); // Remove subscriber on timeout
      }
    }, timeout);

    this.subscribers.set(resultKey, {
      callback: (err, resultMessage) => {
        // This is the wrapper callback. The actual user callback is `callback`.
        // This wrapper is called by enqueueResult when a result arrives.
        clearTimeout(timer); // Important: clear the timeout
        // The subscriber is deleted in enqueueResult after this callback is invoked.
        callback(err, resultMessage);
      },
      timer, // Store timer to clear it if result arrives
      sub_task_id // Store for reference, though resultKey is now specific
    });
  }
}

module.exports = ResultsQueue;
