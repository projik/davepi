'use strict';

/**
 * Embeddable widget — STUB.
 *
 * The "widget" is really just a small browser-side client that
 * talks to the existing HTTP /chat endpoint via SSE. The agent
 * server doesn't need a new channel; what's missing here is the
 * browser bundle.
 *
 * Recommended shape:
 *   - One <script src="https://your-agent/widget.js"></script>
 *     tag that injects a chat bubble + drawer into the host page.
 *   - The script reads a `data-davepi-agent` attribute on the
 *     script tag containing the agent URL + an optional anonymous
 *     visitor id (uuid stored in localStorage).
 *   - Use the service auth mode on the agent server, paired with
 *     a davepi apiClient whose role has read-only scope filters
 *     declared on each schema you want exposed.
 *   - Render events from the SSE stream become DOM:
 *        type: 'table' → <table>
 *        type: 'chart' → vega-embed of the Vega-Lite spec
 *
 * No server-side stub is needed — the bundle lives next to the
 * agent's HTTP channel and is served as a static asset. See
 * demo/widget.html for the minimal pattern.
 */

module.exports = {};
