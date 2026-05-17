/**
 * Email-Adapter Barrel.
 */
export type {
  EmailAdapter,
  EmailMessage,
  SendResult,
} from './interface.js';
export { EmailSendError } from './interface.js';
export { ConsoleEmailAdapter } from './console.js';
export type { ConsoleEmailAdapterOptions } from './console.js';
export { ResendEmailAdapter } from './resend.js';
export type { ResendEmailAdapterOptions } from './resend.js';
