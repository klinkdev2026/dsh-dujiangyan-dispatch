import type { ApprovalQueue } from './approvals.ts';
import type { ResolvedConfig } from './config.ts';
import type { EventLog } from './events.ts';
import type { HostContext } from './host.ts';
import type { AdmissionController } from './limiter.ts';
import { type RouteHealth, type UsageMeter } from './llm-hooks.ts';
import type { LeaseManager } from './locks.ts';
import type { DispatchRegistry } from './registry.ts';
import { type SessionManager } from './sessions.ts';
import type { TaskManager } from './tasks.ts';
export declare const VERSION = "0.1.0-alpha.1";
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
}
export declare function startMcpServer(deps: McpDeps): {
    url: string;
    close(): Promise<void>;
};
