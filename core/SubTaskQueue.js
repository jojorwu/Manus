const EventEmitter = require('events');

   class SubTaskQueue extends EventEmitter {
     constructor() {
       super();
       this.tasks = []; // Array to store task messages
       this.roleSubscribers = {}; // role: [callback, callback, ...]
     }

     enqueueTask(taskMessage) {
      console.log(`INFO: SubTaskQueue: Enqueuing task for role ${taskMessage.assigned_agent_role}, ID: ${taskMessage.sub_task_id}`);
      const role = taskMessage.assigned_agent_role;
      // Check if there are active subscribers for this role.
      if (this.roleSubscribers[role] && this.roleSubscribers[role].length > 0) {
        // If subscribers exist, emit the task directly to them.
        // It's assumed that the subscribing agent will handle the task appropriately (e.g., based on its availability).
        console.log(`INFO: SubTaskQueue: Emitting task ID ${taskMessage.sub_task_id} directly to subscribed role ${role}`);
        this.emit(role, taskMessage);
      } else {
        // If no subscribers, add the task to a pending queue for later processing when an agent for this role subscribes.
        console.log(`INFO: SubTaskQueue: No subscribers for role ${role}, adding task ID ${taskMessage.sub_task_id} to pending queue.`);
        this.tasks.push(taskMessage);
      }
      this.emit('newTask', role, taskMessage); // General event for informational purposes, if needed.
    }

     // Subscribe to tasks for a specific role. Worker agents will use this.
     subscribe(agentRole, callback) {
      console.log(`INFO: SubTaskQueue: Agent of role '${agentRole}' attempting to subscribe.`);
      if (!this.roleSubscribers[agentRole]) {
          this.roleSubscribers[agentRole] = [];
      }

      // Check if this specific callback is already subscribed to avoid duplicates.
      if (this.roleSubscribers[agentRole].includes(callback)) {
          console.log(`INFO: SubTaskQueue: Agent with this callback already subscribed to role '${agentRole}'.`);
          return; // Avoid duplicate subscriptions of the same callback instance.
      }

      this.roleSubscribers[agentRole].push(callback);
      console.log(`INFO: SubTaskQueue: Agent subscribed to role '${agentRole}'. Total subscribers for role: ${this.roleSubscribers[agentRole].length}`);

      // Set up an event listener for this specific subscriber.
      // Each subscriber will have its own event listener.
      const eventListener = (taskMessage) => {
          // The logic within the agent (callback) should determine if it can handle the task
          // (e.g., the agent might have an internal 'isBusy' flag).
          console.log(`INFO: SubTaskQueue: Notifying subscriber for role ${agentRole} about task ID ${taskMessage.sub_task_id}`);
          callback(taskMessage);
      };
      this.on(agentRole, eventListener);

      // Store a reference to the listener for potential future unsubscription.
      // This is a basic unsubscription mechanism; could be enhanced if specific callback unsubscription is needed.
      if (!this.subscriberListeners) this.subscriberListeners = new Map();
      if (!this.subscriberListeners.has(callback)) this.subscriberListeners.set(callback, []);
      this.subscriberListeners.get(callback).push({role: agentRole, listener: eventListener });


      // Check for any "pending" tasks in `this.tasks` for this role
      // and dispatch ONE if available. This ensures newly subscribed agents can pick up queued work.
      const pendingTaskIndex = this.tasks.findIndex(task => task.assigned_agent_role === agentRole);
      if (pendingTaskIndex !== -1) {
        const pendingTask = this.tasks.splice(pendingTaskIndex, 1)[0];
        console.log(`INFO: SubTaskQueue: Immediately dispatching pending task ID ${pendingTask.sub_task_id} to newly subscribed role ${agentRole}`);
        // Wrap in process.nextTick to ensure the callback is not invoked in the same tick
        // as the subscription, which can sometimes lead to unexpected behavior.
        process.nextTick(() => {
            callback(pendingTask);
        });
      }
    }

    /**
     * Checks if there are any active subscribers (agents) for a given role.
     * This method is used by PlanExecutor to determine if a task can be dispatched
     * or if it should be marked as failed due to no available agents.
     * @param {string} agentRole - The role to check for subscribers (e.g., "ResearchAgent").
     * @returns {boolean} True if there are active subscribers for the role, false otherwise.
     */
    hasSubscribers(agentRole) {
      // Check if the role exists as a key in roleSubscribers and if the array of subscribers is not empty.
      if (this.roleSubscribers[agentRole] && this.roleSubscribers[agentRole].length > 0) {
        return true; // Subscribers are present for this role.
      }
      return false; // No subscribers for this role.
    }
   }

   module.exports = SubTaskQueue;
