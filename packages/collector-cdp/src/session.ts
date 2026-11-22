/**
 * The slice of a CDP client the collector needs.
 * Playwright's CDPSession and a thin wrapper over chrome.debugger both satisfy it.
 */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): void;
  off(event: string, handler: (params: unknown) => void): void;
}
