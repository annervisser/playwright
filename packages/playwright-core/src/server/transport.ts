/**
 * Copyright 2018 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ws } from '../utilsBundle';
import type { WebSocket } from '../utilsBundle';
import type { ClientRequest, IncomingMessage } from 'http';
import type { Progress } from './progress';
import { makeWaitForNextTask } from '../utils';

export type ProtocolRequest = {
  id: number;
  method: string;
  params: any;
  sessionId?: string;
};

export type ProtocolResponse = {
  id?: number;
  method?: string;
  sessionId?: string;
  error?: { message: string; data: any; code?: number };
  params?: any;
  result?: any;
  pageProxyId?: string;
  browserContextId?: string;
};

export interface ConnectionTransport {
  send(s: ProtocolRequest): void;
  close(): void;  // Note: calling close is expected to issue onclose at some point.
  onmessage?: (message: ProtocolResponse) => void,
  onclose?: () => void,
}

export class WebSocketTransport implements ConnectionTransport {
  private _ws: WebSocket;
  private _progress: Progress;

  onmessage?: (message: ProtocolResponse) => void;
  onclose?: () => void;
  readonly wsEndpoint: string;

  static async connect(progress: Progress, url: string, headers?: { [key: string]: string; }, followRedirects?: boolean): Promise<WebSocketTransport> {
    progress.log(`<ws connecting> ${url}`);
    const transport = new WebSocketTransport(progress, url, headers, followRedirects);
    let success = false;
    progress.cleanupWhenAborted(async () => {
      if (!success)
        await transport.closeAndWait().catch(e => null);
    });
    await new Promise<WebSocketTransport>((fulfill, reject) => {
      transport._ws.on('open', async () => {
        progress.log(`<ws connected> ${url}`);
        fulfill(transport);
      });
      transport._ws.on('error', event => {
        progress.log(`<ws connect error> ${url} ${event.message}`);
        reject(new Error('WebSocket error: ' + event.message));
        transport._ws.close();
      });
      transport._ws.on('unexpected-response', (request: ClientRequest, response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        const errorPrefix = `${url} ${response.statusCode} ${response.statusMessage}`;
        response.on('data', chunk => chunks.push(chunk));
        response.on('close', () => {
          const error = chunks.length ? `${errorPrefix}\n${Buffer.concat(chunks)}` : errorPrefix;
          progress.log(`<ws unexpected response> ${error}`);
          reject(new Error('WebSocket error: ' + error));
          transport._ws.close();
        });
      });
    });
    success = true;
    return transport;
  }

  constructor(progress: Progress, url: string, headers?: { [key: string]: string; }, followRedirects?: boolean) {
    this.wsEndpoint = url;
    this._ws = new ws(url, [], {
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024, // 256Mb,
      // Prevent internal http client error when passing negative timeout.
      handshakeTimeout: Math.max(progress.timeUntilDeadline(), 1),
      headers,
      followRedirects,
    });
    this._progress = progress;
    // The 'ws' module in node sometimes sends us multiple messages in a single task.
    // In Web, all IO callbacks (e.g. WebSocket callbacks)
    // are dispatched into separate tasks, so there's no need
    // to do anything extra.
    const messageWrap: (cb: () => void) => void = makeWaitForNextTask();

    this._ws.addEventListener('message', event => {
      messageWrap(() => {
        try {
          if (this.onmessage)
            this.onmessage.call(null, JSON.parse(event.data as string));
        } catch (e) {
          this._ws.close();
        }
      });
    });

    this._ws.addEventListener('close', event => {
      this._progress && this._progress.log(`<ws disconnected> ${url} code=${event.code} reason=${event.reason}`);
      if (this.onclose)
        this.onclose.call(null);
    });
    // Prevent Error: read ECONNRESET.
    this._ws.addEventListener('error', error => this._progress && this._progress.log(`<ws error> ${error.type} ${error.message}`));
  }

  send(message: ProtocolRequest) {
    this._ws.send(JSON.stringify(message));
  }

  close() {
    this._progress && this._progress.log(`<ws disconnecting> ${this._ws.url}`);
    this._ws.close();
  }

  async closeAndWait() {
    if (this._ws.readyState === ws.CLOSED)
      return;
    const promise = new Promise(f => this._ws.once('close', f));
    this.close();
    await promise; // Make sure to await the actual disconnect.
  }
}
