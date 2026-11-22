import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for an OpenAI-compatible endpoint, on a port of this machine. Used by the unit tests
 * of the adjudicator layer and by the browser tests of the CLI. No test calls a real model.
 */

export interface MockRequest {
  /** 0 for the first request the server received. */
  index: number;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** Parsed JSON body, or null when it was not JSON. */
  body: ChatBody | null;
  raw: string;
}

export interface ChatBody {
  model?: unknown;
  messages?: { role: string; content: string | ({ type: string; text?: string; image_url?: unknown })[] }[];
  [key: string]: unknown;
}

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  /** Sent as it is when a string, as JSON otherwise. */
  body?: unknown;
  /** Waits this long before answering. */
  delayMs?: number;
  /** Never answers; the socket stays open until the client gives up or the server closes. */
  hang?: boolean;
  /** Drops the connection without an answer. */
  drop?: boolean;
}

export type MockHandler = (request: MockRequest) => MockReply | Promise<MockReply>;

export interface MockModel {
  /** Base URL to configure: `http://127.0.0.1:<port>/v1`. */
  baseUrl: string;
  port: number;
  requests: MockRequest[];
  /** Highest number of requests that were being handled at one time. */
  maxInFlight: number;
  /** Replaces the handler. */
  respond(handler: MockHandler): void;
  close(): Promise<void>;
}

/** A chat completion that carries `content` as the answer of the model. */
export function completion(content: unknown, choice: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model: 'mock',
    choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop', ...choice }],
  };
}

/** A completion whose content is a well-formed verdict. */
export function verdict(value: 'yes' | 'no' | 'unsure', confidence: 'high' | 'low' = 'high', rationale = `mock says ${value}`): MockReply {
  return { body: completion(JSON.stringify({ verdict: value, confidence, rationale })) };
}

/** The text of the user message of a request, whether its content is a string or parts. */
export function userText(body: ChatBody | null): string {
  const content = body?.messages?.find((message) => message.role === 'user')?.content;
  if (typeof content === 'string') return content;
  return (content ?? []).map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
}

export function systemText(body: ChatBody | null): string {
  const content = body?.messages?.find((message) => message.role === 'system')?.content;
  return typeof content === 'string' ? content : '';
}

/** The image parts of the user message. */
export function imageParts(body: ChatBody | null): { type: string; image_url?: unknown }[] {
  const content = body?.messages?.find((message) => message.role === 'user')?.content;
  return typeof content === 'string' || !content ? [] : content.filter((part) => part.type === 'image_url');
}

/** The DATA document of a request: the context that was sent about the candidate. */
export function dataOf(body: ChatBody | null): Record<string, unknown> {
  const lines = userText(body).split('\n');
  const begin = lines.findIndex((line) => line.startsWith('BEGIN DATA '));
  const end = lines.findIndex((line, index) => index > begin && line.startsWith('END DATA '));
  if (begin < 0 || end !== begin + 2) throw new Error('The request does not hold exactly one line of DATA between its markers.');
  return JSON.parse(lines[begin + 1]!) as Record<string, unknown>;
}

export async function startMockModel(handler: MockHandler = () => verdict('yes')): Promise<MockModel> {
  let current = handler;
  let inFlight = 0;
  const hanging = new Set<{ destroy(): void }>();
  const mock: MockModel = {
    baseUrl: '',
    port: 0,
    requests: [],
    maxInFlight: 0,
    respond(next) {
      current = next;
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of hanging) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: ChatBody | null;
      try {
        body = JSON.parse(raw) as ChatBody;
      } catch {
        body = null;
      }
      const seen: MockRequest = { index: mock.requests.length, method: request.method ?? '', path: request.url ?? '', headers: request.headers, body, raw };
      mock.requests.push(seen);
      inFlight++;
      mock.maxInFlight = Math.max(mock.maxInFlight, inFlight);
      void (async () => {
        try {
          const reply = await current(seen);
          if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
          if (reply.hang) {
            hanging.add(response.socket!);
            return;
          }
          if (reply.drop) {
            response.socket?.destroy();
            return;
          }
          const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
          response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
          response.end(text);
        } finally {
          inFlight--;
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.port = (server.address() as AddressInfo).port;
  mock.baseUrl = `http://127.0.0.1:${mock.port}/v1`;
  return mock;
}
