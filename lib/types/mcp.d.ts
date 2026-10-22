import { type AiApproval } from './ai-approval.ts';
import type { ApprovalQueue } from './approvals.ts';
import type { ResolvedConfig } from './config.ts';
import type { EventLog } from './events.ts';
import type { HostContext } from './host.ts';
import type { AdmissionController } from './limiter.ts';
import { type RouteHealth, type UsageMeter } from './llm-hooks.ts';
import type { LocalRules } from './local-rules.ts';
import type { LeaseManager } from './locks.ts';
import type { DispatchRegistry } from './registry.ts';
import { type SessionManager } from './sessions.ts';
import type { TaskManager } from './tasks.ts';
import { type QuietSwitch } from './quiet.ts';
import type { Watchdog } from './watchdog.ts';
export declare const VERSION = "0.2.0";
export interface McpDeps {
    readonly ctx: HostContext;
    readonly config: ResolvedConfig;
    readonly token: string;
    readonly registry: DispatchRegistry;
    readonly sessions: SessionManager;
    readonly tasks: TaskManager;
    readonly approvals: ApprovalQueue;
    readonly events: EventLog;
    readonly leases: LeaseManager;
    readonly limiter: AdmissionController;
    readonly usage: UsageMeter;
    readonly health: RouteHealth;
    readonly audit: (record: Record<string, unknown>) => void;
    readonly localRules: LocalRules;
    readonly aiApproval: AiApproval;
    /** Liveness alarms (approval aging, AI judge health, stalled tasks, orchestrator presence). */
    readonly watchdog?: Watchdog;
    /** Last authenticated MCP request, so the watchdog can tell when no orchestrator is watching. */
    /** `lastSeenAt`: any MCP request (orchestrator presence). `approverAt`: it listed or decided approvals. */
    readonly presence?: {
        lastSeenAt: number | undefined;
        approverAt?: number;
    };
    /** The orchestrator's quiet-mode switch. */
    readonly quiet?: QuietSwitch;
}
export declare function startMcpServer(deps: McpDeps): {
    url: string;
    close(): Promise<void>;
};
