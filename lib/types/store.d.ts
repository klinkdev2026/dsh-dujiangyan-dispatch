export declare function ensureDir(dir: string): string;
export declare function writeJsonAtomic(file: string, value: unknown): void;
export declare function readJson<T>(file: string, fallback: T): T;
export declare function appendJsonl(file: string, value: unknown): void;
/** Read a JSON Lines file, skipping a torn last line. */
export declare function readJsonl<T>(file: string): T[];
