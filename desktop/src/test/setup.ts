import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Mock Tauri IPC so component/adapter tests don't try to reach a real backend.
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
  emit: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
  message: vi.fn(async () => undefined),
  ask: vi.fn(async () => false),
  confirm: vi.fn(async () => false),
}));
