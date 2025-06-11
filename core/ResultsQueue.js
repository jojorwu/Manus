const EventEmitter = require('events');

   class ResultsQueue extends EventEmitter {
     constructor() {
       super();
       this.results = []; // Array to store result messages
       this.subscribers = {}; // parent_task_id: callback (for one-time subscription)
     }

     enqueueResult(resultMessage) {
       console.log(`ResultsQueue: Enqueuing result for parent_task_id ${resultMessage.parent_task_id}, sub_task_id: ${resultMessage.sub_task_id}`);
       this.results.push(resultMessage);
       this.emit('newResult', resultMessage); // General event for any new result

       // Check for one-time subscriber interested in this parent_task_id
       // A more robust implementation might look for sub_task_id or a composite key
       if (this.subscribers[resultMessage.parent_task_id]) {
         const callbackDetails = this.subscribers[resultMessage.parent_task_id];
         // If specific sub_task_id is expected by subscriber, check it here
         if (!callbackDetails.sub_task_id || callbackDetails.sub_task_id === resultMessage.sub_task_id) {
            delete this.subscribers[resultMessage.parent_task_id]; // Remove after firing
            callbackDetails.callback(null, resultMessage);
         }
       }
     }

     // Simple dequeue - primarily for Orchestrator to pull all results for a parent task
     // Not typically used if subscribeOnce is the main mechanism for orchestrator.
     dequeueResultsByParentTaskId(parentTaskId) {
       const relevantResults = this.results.filter(res => res.parent_task_id === parentTaskId);
       this.results = this.results.filter(res => res.parent_task_id !== parentTaskId); // Remove them
       return relevantResults;
     }

     // Orchestrator uses this to wait for a specific task's result.
     // For simplicity, this waits for *any* result matching parentTaskId if no sub_task_id is given,
     // or a specific sub_task_id if provided.
     subscribeOnce(parentTaskId, callback, sub_task_id = null, timeout = 30000) {
       console.log(`ResultsQueue: Orchestrator subscribed for results of parent_task_id ${parentTaskId}` + (sub_task_id ? ` specific sub_task_id ${sub_task_id}` : ''));

       const resultKey = parentTaskId; // Using parentTaskId as the primary key for subscription

       // Check if the result is already in the queue
       const existingResultIndex = this.results.findIndex(res =>
           res.parent_task_id === parentTaskId &&
           (!sub_task_id || res.sub_task_id === sub_task_id)
       );

       if (existingResultIndex !== -1) {
           const existingResult = this.results.splice(existingResultIndex, 1)[0]; // Consume it
           console.log(`ResultsQueue: Immediately providing existing result for parent_task_id ${parentTaskId}` + (sub_task_id ? ` sub_task_id ${sub_task_id}` : ''));
           callback(null, existingResult);
           return;
       }

       const timer = setTimeout(() => {
         if (this.subscribers[resultKey] && (!sub_task_id || this.subscribers[resultKey].sub_task_id === sub_task_id)) {
            delete this.subscribers[resultKey];
            const timeoutError = new Error(`Timeout waiting for result of parent_task_id ${parentTaskId}` + (sub_task_id ? ` sub_task_id ${sub_task_id}` : ''));
            console.error(timeoutError.message);
            callback(timeoutError, null);
         }
       }, timeout);

       this.subscribers[resultKey] = {
           callback: (err, resultMessage) => {
               clearTimeout(timer);
               // No need to delete this.subscribers[resultKey] here, already done by enqueue or timeout
               callback(err, resultMessage);
           },
           sub_task_id: sub_task_id // Store expected sub_task_id if any
       };
     }
   }

   module.exports = ResultsQueue;
