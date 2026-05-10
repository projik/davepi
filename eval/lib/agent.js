/**
 * Thin agent loop on top of the Anthropic Messages API. Exposes
 * three tools — read_file, write_file, list_directory — scoped to a
 * single project directory.
 *
 * Two modes:
 *
 *   real    Calls the Anthropic API. Requires ANTHROPIC_API_KEY.
 *           This is what runs in nightly CI.
 *
 *   stub    Replays a fixed sequence of tool calls + a final text
 *           response from a fixture file. Lets us exercise the
 *           harness wiring (prompt loading, file substitution,
 *           result reporting) without spending API tokens or
 *           depending on the network. Used in test/* and selectable
 *           via EVAL_AGENT=stub.
 *
 * Tool surface intentionally small:
 *   - read_file({ path })          → file content or ''
 *   - write_file({ path, content }) → 'written'
 *   - list_directory({ path })      → '\n'-joined relative paths
 *
 * Path arguments are resolved against the project root and rejected
 * if they escape it (../../something). This is the only sandboxing —
 * the agent runs whatever it likes within the project tree.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the project. Returns the file contents as a string.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from the project root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the project. Parent directories are created as needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from the project root.' },
        content: { type: 'string', description: 'Full file contents.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories under a path, recursively. Returns one relative path per line.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from the project root. Defaults to ".".' },
      },
    },
  },
];

function safeJoin(root, rel) {
  // Refuse any path that, after resolution, escapes the project root.
  // The agent is trusted to do the right thing inside the sandbox, but
  // not trusted to e.g. write to /etc.
  const resolved = path.resolve(root, rel || '.');
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`refused to access ${rel}: outside project root`);
  }
  return resolved;
}

function makeToolExecutors(projectRoot) {
  return {
    read_file: ({ path: rel }) => {
      const abs = safeJoin(projectRoot, rel);
      if (!fs.existsSync(abs)) return `(file does not exist: ${rel})`;
      return fs.readFileSync(abs, 'utf8');
    },
    write_file: ({ path: rel, content }) => {
      const abs = safeJoin(projectRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return 'written';
    },
    list_directory: ({ path: rel }) => {
      const abs = safeJoin(projectRoot, rel || '.');
      if (!fs.existsSync(abs)) return '';
      const out = [];
      const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
          const childRel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            out.push(childRel + '/');
            walk(path.join(dir, entry.name), childRel);
          } else {
            out.push(childRel);
          }
        }
      };
      walk(abs, rel && rel !== '.' ? rel : '');
      return out.join('\n');
    },
  };
}

/**
 * The system prompt is the agent's standing brief. Pulled from the
 * baseline project's agent.md so it tracks the same conventions as
 * what scaffolded projects ship — i.e. the eval tests the experience
 * a real user would have.
 */
function loadSystemPrompt(projectRoot) {
  const agentMd = path.join(projectRoot, 'agent.md');
  const conventions = fs.existsSync(agentMd) ? fs.readFileSync(agentMd, 'utf8') : '';
  return [
    'You are a coding agent extending a dAvePi project.',
    'Use the provided tools to read existing files for context and write',
    'the changes the user asks for. Make the smallest change that',
    "satisfies the request — don't refactor unrelated code.",
    '',
    'When you have completed the change, respond with a short summary',
    'and STOP — do not keep calling tools after the work is done.',
    '',
    '== Project conventions ==',
    '',
    conventions,
  ].join('\n');
}

/**
 * Run the agent loop. Returns the final text response from Claude.
 *
 * `agentMode` selects 'real' (Anthropic API) or 'stub' (fixture).
 * `projectRoot` is the scratch project the agent edits.
 * `prompt` is the natural-language task.
 */
async function runAgent({ agentMode, projectRoot, prompt, model = 'claude-sonnet-4-6', maxTurns = 25 }) {
  if (agentMode === 'stub') {
    return runStubAgent({ projectRoot, prompt });
  }
  return runRealAgent({ projectRoot, prompt, model, maxTurns });
}

async function runRealAgent({ projectRoot, prompt, model, maxTurns }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for real-agent mode (set EVAL_AGENT=stub to skip).');
  }
  // Lazy require so the package only loads when actually used —
  // saves install time when the harness is running in stub mode.
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const executors = makeToolExecutors(projectRoot);
  const systemPrompt = loadSystemPrompt(projectRoot);
  const messages = [{ role: 'user', content: prompt }];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const toolUses = response.content.filter((b) => b.type === 'tool_use');

    if (toolUses.length === 0) {
      // Done — Claude finished without invoking another tool.
      return textBlocks.map((b) => b.text).join('\n');
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const use of toolUses) {
      let result;
      try {
        const fn = executors[use.name];
        if (!fn) {
          result = { is_error: true, content: `unknown tool: ${use.name}` };
        } else {
          const out = fn(use.input || {});
          result = { is_error: false, content: out };
        }
      } catch (err) {
        result = { is_error: true, content: err.message };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: result.content,
        is_error: result.is_error,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  throw new Error(`agent did not finish within ${maxTurns} turns`);
}

/**
 * Stub agent: reads `<projectRoot>/.eval-stub.json` (a fixture
 * planted by the harness for the current prompt) and replays its
 * tool calls in order. Each entry is either `{ tool: 'write_file',
 * input: { ... } }` or `{ text: 'final response' }`. Used by tests
 * to exercise the loop without an API key.
 */
function runStubAgent({ projectRoot, prompt }) {
  const fixturePath = path.join(projectRoot, '.eval-stub.json');
  if (!fs.existsSync(fixturePath)) {
    throw new Error(
      `stub agent requires a fixture at ${fixturePath}. ` +
      `Plant one before invoking the harness, or run with EVAL_AGENT=real.`
    );
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const executors = makeToolExecutors(projectRoot);
  let summary = '';
  for (const step of fixture) {
    if (step.text) {
      summary = step.text;
      continue;
    }
    if (!executors[step.tool]) {
      throw new Error(`stub: unknown tool ${step.tool}`);
    }
    executors[step.tool](step.input || {});
  }
  return summary;
}

module.exports = { runAgent, TOOLS, makeToolExecutors, loadSystemPrompt };
