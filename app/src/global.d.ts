import type { SkriveIpc } from '@skrive/shared';

declare global {
  interface Window {
    skrive: SkriveIpc;
  }
}
