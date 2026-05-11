'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = function applyStatusStateMachine(projectRoot) {
  const file = path.join(projectRoot, 'schema/versions/v1/task.js');
  fs.writeFileSync(
    file,
    `module.exports = {
  path: 'task',
  collection: 'task',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'title',  type: String, required: true },
    { name: 'done',   type: Boolean, default: false },
    {
      name: 'status',
      type: String,
      stateMachine: {
        initial: 'todo',
        states: ['todo', 'in_progress', 'done'],
        transitions: {
          todo:        ['in_progress', 'done'],
          in_progress: ['done', 'todo'],
          done:        [],
        },
      },
    },
  ],
};
`
  );
};
