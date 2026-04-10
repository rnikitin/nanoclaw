/**
 * Canvas Runtime — renders agent-generated JSX in the browser.
 *
 * The agent sends JSX code as a string. We compile it with Sucrase
 * (lightweight JSX→JS transform), then render it as a React component.
 *
 * The component receives:
 *   - state: current canvas state (updated by agent)
 *   - send(event): function to send events back to agent via WebSocket
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { transform } from 'sucrase';
import { theme } from './canvas-theme';

// --- JSX Compiler ---

function compileJsx(code: string): Function | null {
  try {
    const compiled = transform(code, {
      transforms: ['jsx', 'typescript'],
      jsxRuntime: 'classic',
      jsxPragma: 'React.createElement',
      jsxFragmentPragma: 'React.Fragment',
    });
    // Wrap in a function that returns the App component
    // The code should define a function App({ state, send }) { ... }
    const fn = new Function(
      'React',
      'useState',
      'useEffect',
      'useRef',
      'useCallback',
      'theme',
      compiled.code + '\nreturn typeof App !== "undefined" ? App : null;',
    );
    return fn(React, useState, useEffect, useRef, useCallback, theme);
  } catch (err) {
    console.error('JSX compilation error:', err);
    return null;
  }
}

// --- WebSocket Client ---

interface CanvasConfig {
  canvasId: string;
  wsUrl: string;
  token: string;
}

class CanvasWsClient {
  private ws: WebSocket | null = null;
  private config: CanvasConfig;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 500;
  private onMessage: (msg: any) => void;
  private statusEl: HTMLElement | null;

  constructor(config: CanvasConfig, onMessage: (msg: any) => void) {
    this.config = config;
    this.onMessage = onMessage;
    this.statusEl = document.getElementById('status');
  }

  connect(): void {
    const params = new URLSearchParams({
      canvas_id: this.config.canvasId,
    });
    if (this.config.token) params.set('token', this.config.token);

    const url = `${this.config.wsUrl}?${params}`;
    this.setStatus('connecting', 'connecting...');

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.setStatus('connected', 'connected');
      this.reconnectDelay = 500;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'pong') return;
        this.onMessage(msg);
      } catch (err) {
        console.error('WS message parse error:', err);
      }
    };

    this.ws.onclose = () => {
      this.setStatus('disconnected', 'disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };

    // Ping keepalive
    const pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);

    this.ws.addEventListener('close', () => clearInterval(pingInterval));
  }

  send(event: string, data: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'event',
        canvas_id: this.config.canvasId,
        event,
        data,
      }),
    );
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 10000);
      this.connect();
    }, this.reconnectDelay);
  }

  private setStatus(cls: string, text: string): void {
    if (this.statusEl) {
      this.statusEl.className = cls;
      this.statusEl.textContent = text;
    }
  }
}

// --- Canvas App Wrapper ---

function CanvasApp({
  jsxCode,
  state,
  sendEvent,
}: {
  jsxCode: string;
  state: Record<string, unknown>;
  sendEvent: (event: string, data: unknown) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const componentRef = useRef<React.ComponentType<any> | null>(null);
  const prevJsxRef = useRef<string>('');

  // Recompile JSX only when it changes
  if (jsxCode !== prevJsxRef.current) {
    prevJsxRef.current = jsxCode;
    const compiled = compileJsx(jsxCode);
    if (compiled) {
      componentRef.current = compiled as React.ComponentType<any>;
      setError(null);
    } else {
      setError('Failed to compile JSX');
    }
  }

  const send = useCallback(
    (data: unknown, event = 'interaction') => {
      // Allow send({type: 'move', cell: 4}) or send('move', {cell: 4})
      if (typeof data === 'object' && data && 'type' in data) {
        sendEvent((data as any).type, data);
      } else {
        sendEvent(event, data);
      }
    },
    [sendEvent],
  );

  if (error) {
    return (
      <div style={{ color: '#e74c3c', padding: 20, fontFamily: 'monospace' }}>
        <h3>Canvas Error</h3>
        <pre>{error}</pre>
      </div>
    );
  }

  const Component = componentRef.current;
  if (!Component) {
    return (
      <div style={{ color: '#888', padding: 20 }}>
        Waiting for canvas...
      </div>
    );
  }

  // Render agent's component with error boundary
  try {
    return <Component state={state} send={send} theme={theme} />;
  } catch (err: any) {
    return (
      <div style={{ color: '#e74c3c', padding: 20, fontFamily: 'monospace' }}>
        <h3>Render Error</h3>
        <pre>{err?.message || String(err)}</pre>
      </div>
    );
  }
}

// --- Init ---

let root: Root | null = null;
let currentJsx = '';
let currentState: Record<string, unknown> = {};
let wsClient: CanvasWsClient | null = null;

function render(): void {
  if (!root) return;
  root.render(
    <CanvasApp
      jsxCode={currentJsx}
      state={currentState}
      sendEvent={(event, data) => wsClient?.send(event, data)}
    />,
  );
}

function init(config: CanvasConfig): void {
  const rootEl = document.getElementById('root');
  if (!rootEl) return;

  root = createRoot(rootEl);

  wsClient = new CanvasWsClient(config, (msg) => {
    if (msg.type === 'create') {
      currentJsx = msg.jsx || '';
      currentState = msg.state || {};
      if (msg.title) document.title = msg.title;
      render();
    } else if (msg.type === 'update') {
      if (msg.jsx) currentJsx = msg.jsx;
      if (msg.state) currentState = { ...currentState, ...msg.state };
      render();
    } else if (msg.type === 'close') {
      currentJsx = '';
      currentState = {};
      root?.render(
        <div style={{ color: '#888', padding: 20 }}>
          Canvas closed.
        </div>,
      );
    }
  });

  // Initial render (waiting state)
  render();

  // Connect WebSocket
  wsClient.connect();
}

// Export to window
(window as any).CanvasRuntime = { init };
