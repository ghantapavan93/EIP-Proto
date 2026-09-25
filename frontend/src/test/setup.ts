import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// vitest runs without globals, so testing-library's auto-cleanup is not wired; do it here.
afterEach(() => {
  cleanup();
});
