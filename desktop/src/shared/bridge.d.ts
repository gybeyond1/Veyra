import type { ApiResult } from './types';

export interface VeyraBridge {
  call(method: string, ...args: unknown[]): Promise<ApiResult>;
  onEvent(handler: (event: { type: string; data: unknown }) => void): () => void;
  platform: string;
}

declare global {
  interface Window {
    veyra: VeyraBridge;
  }
}

export {};
