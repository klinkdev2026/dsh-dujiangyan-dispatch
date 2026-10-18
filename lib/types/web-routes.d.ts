import type { HostContext } from './host.ts';
import type { McpDeps } from './mcp.ts';
export declare const ROUTE_PREFIX = "/plugins/dsh-dujiangyan-dispatch";
/** Everything the panel shows, in one snapshot (plus events after `cursor`). */
export declare function panelSnapshot(d: McpDeps, cursor: number): Record<string, unknown>;
export declare function installWebRoutes(ctx: HostContext, d: McpDeps): void;
