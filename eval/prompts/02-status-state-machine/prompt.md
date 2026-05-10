Add a `status` state-machine field to the `task` schema with these
states and transitions:

- States: `todo`, `in_progress`, `done`
- Initial state: `todo`
- Transitions:
  - `todo` → `in_progress`, `done`
  - `in_progress` → `done`, `todo`
  - `done` → (terminal — no outgoing transitions)

Don't change the existing fields on the schema; just add `status`
alongside them.
