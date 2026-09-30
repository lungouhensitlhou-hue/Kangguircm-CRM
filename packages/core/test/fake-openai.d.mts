export function respond(body: any): any;
export function startFakeOpenAI(port?: number): Promise<{ server: import("node:http").Server; requests: { auth?: string; body: any }[]; url: string; close: () => Promise<void> }>;
