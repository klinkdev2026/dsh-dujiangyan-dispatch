/**
 * The orchestrator playbook returned by `djy_guide`. Every entry is a problem
 * met in a real run and the way to avoid it; LESSONS.md keeps the long form.
 */
export const ORCHESTRATOR_GUIDE = {
  workflow: [
    'djy_status → djy_models → djy_routes_probe (which listed models really work) → djy_preflight(cwd) → djy_session_create(role or route) → djy_task_submit → djy_events_watch(cursor) loop → djy_task_get.',
    'Keep the cursor from djy_events_watch and pass it back; react to approval/pending events with djy_approval_decide.',
    'Submit benchmark/measurement steps as separate tasks with resources ["bench"]; everything else runs without it.',
    'Sessions are long-lived workers: reuse them across tasks (check djy_session_list first). Do not close a session after each task — closing throws away its context and the user loses the session they were watching. Close only when asked, when that role\'s work is over, or to stay under maxSessions.',
  ],
  approvals: [
    'Verify the worker\'s claim yourself before allowing (e.g. inspect ACLs / files) — do not trust its diagnosis.',
    'Allow only the exact call; deny variants. Record the undo for anything you allow that changes state.',
    'Irreversible or outward-facing actions (push, uploads, installs outside the workspace, deleting data) go to the human, not to you.',
    'Deny with a reason the worker can act on ("use the venv", "submit as a bench task").',
  ],
  pitfalls: [
    {
      symptom: 'Worker writes fail with "access denied" in a workspace subdirectory on Windows',
      cause: 'The sandbox runs at Low integrity; directories that existed before Harness labeled the workspace root keep a Medium label.',
      avoid: 'Run djy_preflight before creating sessions; fix the listed directories (icacls "<dir>" /setintegritylevel (OI)(CI)L) with the user\'s approval. Workers are told never to touch ACLs.',
    },
    {
      symptom: 'JSON arguments with Windows paths fail to parse ("Bad escaped character")',
      cause: 'Backslashes are escape characters in JSON and get mangled again by shells.',
      avoid: 'Use forward slashes in paths inside prompts and tool arguments (D:/work/x). Harness tools, pwsh and the gate all accept them.',
    },
    {
      symptom: 'Task turn fails with "format v4 message requires a producer-owned source kind"',
      cause: 'Session format v4 refuses the retired { kind: "plugin" } message source.',
      avoid: 'Fixed in the plugin (source kind "dujiangyan-dispatch"). If a different plugin injects messages, it needs the same fix.',
    },
    {
      symptom: 'A task reports done immediately with no tool calls',
      cause: 'agent.whenIdle() resolves before the agent picks up a freshly queued followup.',
      avoid: 'Fixed in the plugin (waits for agent/status running or agent/error first). Check task.result.errors when a result looks empty.',
    },
    {
      symptom: 'A model listed by a provider fails on every request (e.g. 400 "Unknown name anthropic_version")',
      cause: 'The provider route is configured with an API dialect the model does not speak (gateway set to anthropic-messages, model is Gemini).',
      avoid: 'Run djy_routes_probe on the models you plan to use before building rosters; give every role a fallback route. Dispatched sessions bench such routes automatically and move down their chain.',
    },
    {
      symptom: 'Rate limits (429) from a gateway key with several workers',
      cause: 'Gateway keys often allow only 3–5 concurrent requests.',
      avoid: 'Set limits.providers.<provider>.maxConcurrent to the key\'s real limit; give roles a fallback route on another provider.',
    },
    {
      symptom: 'Benchmark numbers are noisy or inconsistent',
      cause: 'Other workers compile or run tests at the same time.',
      avoid: 'Only tasks holding "bench" may run benchmark commands (the gate enforces it); keep measurement tasks short and separate.',
    },
  ],
} as const
