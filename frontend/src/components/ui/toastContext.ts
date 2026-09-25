import { createContext } from 'react';
import type { Tone } from '../../lib/vocab';

export interface ToastInput {
  title: string;
  detail?: string;
  tone?: Tone;
  /** ms; 0 = sticky */
  duration?: number;
}

export interface ToastApi {
  toast: (input: ToastInput) => void;
  dismiss: (id: number) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);
