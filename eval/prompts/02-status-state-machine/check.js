'use strict';

const path = require('node:path');

module.exports = function checkStatusStateMachine(projectRoot) {
  delete require.cache[require.resolve(path.join(projectRoot, 'schema/versions/v1/task.js'))];
  const schema = require(path.join(projectRoot, 'schema/versions/v1/task.js'));

  const status = schema.fields.find((f) => f && f.name === 'status');
  if (!status) return { ok: false, message: 'task.status field is missing' };

  const sm = status.stateMachine;
  if (!sm || typeof sm !== 'object') {
    return { ok: false, message: 'task.status must have a stateMachine config' };
  }
  if (sm.initial !== 'todo') {
    return { ok: false, message: `expected stateMachine.initial='todo', got '${sm.initial}'` };
  }

  const wantStates = ['todo', 'in_progress', 'done'].sort();
  const gotStates = (sm.states || []).slice().sort();
  if (JSON.stringify(gotStates) !== JSON.stringify(wantStates)) {
    return { ok: false, message: `states mismatch: want ${wantStates}, got ${gotStates}` };
  }

  const t = sm.transitions || {};
  const must = {
    todo: ['in_progress', 'done'],
    in_progress: ['done', 'todo'],
    done: [],
  };
  for (const [from, allowed] of Object.entries(must)) {
    if (!Array.isArray(t[from])) {
      return { ok: false, message: `transitions['${from}'] must be an array` };
    }
    const haveSet = new Set(t[from]);
    for (const target of allowed) {
      if (!haveSet.has(target)) {
        return { ok: false, message: `transitions['${from}'] is missing '${target}'` };
      }
    }
    // Allow extra transitions if the agent added more, except for
    // `done` which is explicitly terminal in the spec.
    if (from === 'done' && t[from].length !== 0) {
      return { ok: false, message: `'done' must be terminal (no outgoing transitions)` };
    }
  }

  // Pre-existing fields preserved.
  for (const required of ['userId', 'title', 'done']) {
    if (!schema.fields.find((f) => f && f.name === required)) {
      return { ok: false, message: `existing field '${required}' was removed` };
    }
  }

  return { ok: true };
};
