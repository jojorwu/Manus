const EventEmitter = require('events');

   class SubTaskQueue extends EventEmitter {
     constructor() {
       super();
       this.tasks = []; // Array to store task messages
       this.roleSubscribers = {}; // role: [callback, callback, ...]
     }

     enqueueTask(taskMessage) {
       console.log(`SubTaskQueue: Enqueuing task for role ${taskMessage.assigned_agent_role}, ID: ${taskMessage.sub_task_id}`);
       this.tasks.push(taskMessage);
       this.emit('newTask', taskMessage.assigned_agent_role, taskMessage); // General event for any new task

       // Emit specific event for role-based subscribers (if any)
       if (this.roleSubscribers[taskMessage.assigned_agent_role]) {
           this.emit(taskMessage.assigned_agent_role, taskMessage);
       }
     }

     // Simple dequeue for a specific role - a worker calls this when it's ready
     // More robust systems might have workers "take" or "ack" tasks
     dequeueTaskByRole(agentRole) {
       const taskIndex = this.tasks.findIndex(task => task.assigned_agent_role === agentRole);
       if (taskIndex !== -1) {
         const task = this.tasks.splice(taskIndex, 1)[0];
         console.log(`SubTaskQueue: Dequeuing task for role ${agentRole}, ID: ${task.sub_task_id}`);
         return task;
       }
       return null;
     }

     // Subscribe to tasks for a specific role. Worker agents will use this.
     // This is a simplified model; a real queue might have more robust listener patterns.
     subscribe(agentRole, callback) {
       console.log(`SubTaskQueue: Agent of role '${agentRole}' subscribed.`);
       if (!this.roleSubscribers[agentRole]) {
           this.roleSubscribers[agentRole] = [];
       }
       this.roleSubscribers[agentRole].push(callback); // Store callback

       // Check for any pending tasks for this role upon subscription
       const pendingTask = this.dequeueTaskByRole(agentRole);
       if (pendingTask) {
           console.log(`SubTaskQueue: Immediately dispatching pending task ID ${pendingTask.sub_task_id} to newly subscribed role ${agentRole}`);
           callback(pendingTask);
       }

       // Listen for new tasks for this role
       this.on(agentRole, (taskMessage) => {
           // This listener attempts to dequeue again, in case multiple workers of same role exist
           // or if the first attempt by a newly subscribed agent didn't get it.
           // A more robust system would ensure only one worker gets one message.
           const task = this.dequeueTaskByRole(agentRole);
           if (task && task.sub_task_id === taskMessage.sub_task_id) { // ensure it's the same task
               callback(task);
           } else if (task) { // dequeued a different task for the role, put it back
               this.tasks.unshift(task);
           }
       });
     }
   }

   module.exports = SubTaskQueue;
