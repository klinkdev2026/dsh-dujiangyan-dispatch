import { type ApprovalQueue } from './approvals.ts';
import type { ResolvedConfig } from './config.ts';
import type { EventLog } from './events.ts';
import type { HostContext } from './host.ts';
import type { DispatchRegistry } from './registry.ts';
export interface GateDeps {
    readonly config: ResolvedConfig;
    readonly registry: DispatchRegistry;
    readonly approvals: ApprovalQueue;
    readonly events: EventLog;
    readonly audit: (record: Record<string, unknown>) => void;
    /** Resources (e.g. `bench`) held by the task currently running on a root session. */
    readonly heldResources: (rootSessionId: string) => readonly string[];
    /** The task currently running on a root session, for attribution. */
    readonly runningTask: (rootSessionId: string) => string | undefined;
}
export declare function installGate(ctx: HostContext, deps: GateDeps): void;
