/**
 * The orchestrator playbook returned by `djy_guide`. Every entry is a problem
 * met in a real run and the way to avoid it; LESSONS.md keeps the long form.
 */
/**
 * Sent as the MCP server instructions, which clients put in front of their model at connect time.
 * Without it orchestrators submitted a task and ended their turn: nobody decided the escalations
 * the AI judges split on, and the workers waited out the approval timeout (user report 2026-10-22).
 */
export declare const ORCHESTRATOR_ROLE: string;
export declare const ORCHESTRATOR_GUIDE: {
    readonly workflow: readonly ["djy_status → djy_models → djy_routes_probe (which listed models really work) → djy_preflight(cwd) → djy_session_create(role or route) → djy_task_submit → djy_events_watch(cursor) loop → djy_task_get.", "Keep the cursor and epoch from djy_events_watch and pass both back; react to approval/pending events with djy_approval_decide. reset:true means the plugin restarted: drop the old cursor and re-check djy_task_list.", "A task in status \"interrupted\" did not finish (desktop restart or an outside abort): inspect the workspace for partial work and resubmit what is left on the same session.", "A task in status \"needs_input\" ended because the worker asked the user something (djy_questions_list): nobody answers inside the worker session and nothing was chosen for it. Decide (or ask your user), then submit a follow-up task carrying the answer.", "A task in status \"needs_attention\" was paused by the deny circuit breaker (3 gate/AI denials in a row or 6 of the last 10 calls): the worker kept trying refused actions. Read its tool calls, then submit a corrected task. Denials a worker receives start with \"[dujiangyan-denied:<rule>]\".", "Give each worker its own write scope: create the session with cwd = its project subfolder (that becomes its writeScope) or pass writeScope explicitly. Two workers writing the same files corrupt each other's work (write-outside-scope denies the rest).", "To correct a running worker without waiting for its turn to end, use djy_session_steer; to say something along with an approval, pass note to djy_approval_decide (steered into the worker's next step).", "Personal rules live in local-rules.json in the plugin data dir (djy_rules_get shows the path and the effective rules; it reloads on save, djy_rules_reload forces it). Use \"hints\" for escalations you keep answering the same way: the call is denied with your advice instead of waiting for you. Hints never allow anything.", "Submit benchmark/measurement steps as tasks with resources [\"bench\"]: the machine is held only while a benchmark command runs, so the task can also build and write its report without blocking others. Use \"bench:task\" when the whole task must own the machine, \"bench:shared\" for a measurement that may share it (results flagged noisy). Everything else runs without bench.", "Sessions are long-lived workers: reuse them across tasks (check djy_session_list first). Do not close a session after each task — closing throws away its context and the user loses the session they were watching. Close only when asked, when that role's work is over, or to stay under maxSessions."];
    readonly approvals: readonly ["Verify the worker's claim yourself before allowing (e.g. inspect ACLs / files) — do not trust its diagnosis.", "Allow only the exact call; deny variants. Record the undo for anything you allow that changes state.", "Irreversible or outward-facing actions (push, uploads, installs outside the workspace, deleting data) go to the human, not to you.", "Deny with a reason the worker can act on (\"use the venv\", \"submit as a bench task\").", "AI approval (djy_ai_approval_get / djy_ai_approval_set): when on, workspace-confined escalations go to model judges first, asked in order (fastest first); only a unanimous answer decides and the panel stops at the first \"human\", error or disagreement. A pending item with ai.status \"split\" is yours: read the opinions, then decide. Network/outward calls, anything outside the roots, encoded commands, loader-environment changes and truncated calls never reach the judges; each session has an AI budget (maxPerSessionPer10Min). A degraded judge is replaced with djy_ai_approval_set { judges }, never by editing the profile (that reloads the desktop and interrupts every worker); pass sessionId or batch to change only your own sessions.", "Quiet mode: while a benchmark holds the machine, builds and tests from other sessions wait (events quiet/waiting, quiet/resumed) so measurements stay clean; after quietMode.maxWaitMs they escalate as quiet-timeout. djy_quiet_set switches quiet mode on or off for a while (audited, expires on its own)."];
    readonly pitfalls: readonly [{
        readonly symptom: "Worker writes fail with \"access denied\" in a workspace subdirectory on Windows";
        readonly cause: "The sandbox runs at Low integrity; directories that existed before Harness labeled the workspace root keep a Medium label.";
        readonly avoid: "Run djy_preflight before creating sessions; fix the listed directories (icacls \"<dir>\" /setintegritylevel (OI)(CI)L) with the user's approval. Workers are told never to touch ACLs.";
    }, {
        readonly symptom: "JSON arguments with Windows paths fail to parse (\"Bad escaped character\")";
        readonly cause: "Backslashes are escape characters in JSON and get mangled again by shells.";
        readonly avoid: "Use forward slashes in paths inside prompts and tool arguments (D:/work/x). Harness tools, pwsh and the gate all accept them.";
    }, {
        readonly symptom: "Task turn fails with \"format v4 message requires a producer-owned source kind\"";
        readonly cause: "Session format v4 refuses the retired { kind: \"plugin\" } message source.";
        readonly avoid: "Fixed in the plugin (source kind \"dujiangyan-dispatch\"). If a different plugin injects messages, it needs the same fix.";
    }, {
        readonly symptom: "A task reports done immediately with no tool calls";
        readonly cause: "agent.whenIdle() resolves before the agent picks up a freshly queued followup.";
        readonly avoid: "Fixed in the plugin (waits for agent/status running or agent/error first). Check task.result.errors when a result looks empty.";
    }, {
        readonly symptom: "A model listed by a provider fails on every request (e.g. 400 \"Unknown name anthropic_version\")";
        readonly cause: "The provider route is configured with an API dialect the model does not speak (gateway set to anthropic-messages, model is Gemini).";
        readonly avoid: "Run djy_routes_probe on the models you plan to use before building rosters; give every role a fallback route. Dispatched sessions bench such routes automatically and move down their chain.";
    }, {
        readonly symptom: "Rate limits (429) from a gateway key with several workers";
        readonly cause: "Gateway keys often allow only 3–5 concurrent requests.";
        readonly avoid: "Set limits.providers.<provider>.maxConcurrent to the key's real limit; give roles a fallback route on another provider.";
    }, {
        readonly symptom: "The first task after a desktop restart fails at once: prompt variable \"{{model}}\" has no value for this assembly";
        readonly cause: "The host had not finished assembling its prompt sections when the turn started; nothing ran.";
        readonly avoid: "The plugin retries such startup failures twice with a short backoff (task/retry events). If it still fails, resubmit the task.";
    }, {
        readonly symptom: "Benchmark numbers are noisy or inconsistent";
        readonly cause: "Other workers compile or run tests at the same time.";
        readonly avoid: "Only tasks holding \"bench\" may run benchmark commands (the gate enforces it); keep measurement tasks short and separate.";
    }];
};
