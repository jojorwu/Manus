const EventEmitter = require('events');

   class SubTaskQueue extends EventEmitter {
     constructor() {
       super();
       this.tasks = []; // Array to store task messages
       this.roleSubscribers = {}; // role: [callback, callback, ...]
     }

     enqueueTask(taskMessage) {
      console.log(`SubTaskQueue: Enqueuing task for role ${taskMessage.assigned_agent_role}, ID: ${taskMessage.sub_task_id}`);
      const role = taskMessage.assigned_agent_role;
      // Проверяем, есть ли активные подписчики для этой роли
      if (this.roleSubscribers[role] && this.roleSubscribers[role].length > 0) {
        // Если есть, отправляем задачу напрямую через событие
        // Предполагается, что агент-подписчик сам решит, может ли он обработать задачу
        console.log(`SubTaskQueue: Emitting task ID ${taskMessage.sub_task_id} directly to subscribed role ${role}`);
        this.emit(role, taskMessage);
      } else {
        // Если подписчиков нет, добавляем задачу в очередь ожидания
        console.log(`SubTaskQueue: No subscribers for role ${role}, adding task ID ${taskMessage.sub_task_id} to pending queue.`);
        this.tasks.push(taskMessage);
      }
      this.emit('newTask', role, taskMessage); // Общее событие для информации, если нужно
    }

     // Subscribe to tasks for a specific role. Worker agents will use this.
     subscribe(agentRole, callback) {
      console.log(`SubTaskQueue: Agent of role '${agentRole}' attempting to subscribe.`);
      if (!this.roleSubscribers[agentRole]) {
          this.roleSubscribers[agentRole] = [];
      }

      // Проверяем, нет ли уже такого колбэка (простая проверка по ссылке)
      if (this.roleSubscribers[agentRole].includes(callback)) {
          console.log(`SubTaskQueue: Agent with this callback already subscribed to role '${agentRole}'.`);
          return; // Избегаем дублирования подписки одного и того же экземпляра коллбэка
      }

      this.roleSubscribers[agentRole].push(callback);
      console.log(`SubTaskQueue: Agent subscribed to role '${agentRole}'. Total subscribers for role: ${this.roleSubscribers[agentRole].length}`);

      // Устанавливаем обработчик событий для этого конкретного подписчика
      // Теперь каждый подписчик имеет свой собственный обработчик this.on()
      const eventListener = (taskMessage) => {
          // Логика внутри агента (в коллбэке) должна определять, может ли он обработать задачу
          // Например, агент может иметь флаг this.isBusy
          console.log(`SubTaskQueue: Notifying subscriber for role ${agentRole} about task ID ${taskMessage.sub_task_id}`);
          callback(taskMessage);
      };
      this.on(agentRole, eventListener);

      // Сохраняем ссылку на слушателя, чтобы можно было отписаться (если потребуется)
      // Это базовая реализация отписки, можно улучшить, если нужно отписывать конкретный коллбэк
      if (!this.subscriberListeners) this.subscriberListeners = new Map();
      if (!this.subscriberListeners.has(callback)) this.subscriberListeners.set(callback, []);
      this.subscriberListeners.get(callback).push({role: agentRole, listener: eventListener });


      // Проверяем наличие "ожидающих" задач в this.tasks для этой роли
      // и отправляем ОДНУ, если есть.
      const pendingTaskIndex = this.tasks.findIndex(task => task.assigned_agent_role === agentRole);
      if (pendingTaskIndex !== -1) {
        const pendingTask = this.tasks.splice(pendingTaskIndex, 1)[0];
        console.log(`SubTaskQueue: Immediately dispatching pending task ID ${pendingTask.sub_task_id} to newly subscribed role ${agentRole}`);
        // Оборачиваем в process.nextTick, чтобы вызов коллбэка не происходил
        // в том же тике, что и подписка, что может быть неожиданным.
        process.nextTick(() => {
            callback(pendingTask);
        });
      }
    }
   }

   module.exports = SubTaskQueue;
