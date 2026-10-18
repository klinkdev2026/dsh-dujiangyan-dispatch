import { type Config } from './config.ts';
import type { HostContext } from './host.ts';
export type { Config } from './config.ts';
export declare const name = "dujiangyan-dispatch";
/** Required host services; optional ones (permissionPresets, agentPresets, approval, workspaceRegistry, sessionTitle) are read lazily. */
export declare const inject: string[];
export declare function apply(ctx: HostContext, raw?: Config): void;
