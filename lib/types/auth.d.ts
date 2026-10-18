import type { IncomingMessage } from 'node:http';
export declare function ensureToken(stateDir: string): string;
export declare function publishEndpoint(stateDir: string, url: string): void;
/**
 * A guide written next to the token at every start, addressed to whatever
 * agent the user runs (Claude Code, Codex, Kimi Code, Zhipu, pi, Cursor, …).
 * It states the facts that hold on this machine and the rules every MCP client
 * shares; the agent applies them to its own client's configuration format.
 */
export declare function connectGuide(url: string, tokenFile: string): string;
export type Rejection = {
    status: number;
    message: string;
} | undefined;
export declare function checkRequest(req: IncomingMessage, token: string): Rejection;
