/**
 * WebPush-Subscription-Helper.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7 (Notification-Surface) + Burst 7 (PWA).
 *
 * Verantwortung:
 *   - Beim Login-Done aufgerufen → checked Browser-Support, fragt Permission an,
 *     subscribed mit dem VAPID-Public-Key vom Server, registriert die
 *     Subscription via API.
 *   - Idempotent: wenn schon eine Subscription existiert, wird sie wiederverwendet.
 *
 * Best-Effort: jeder Fail (Browser nicht support, Permission denied, Server
 * 503) wird in den Debug-Log gepustet — nicht throwen, nicht den Login-Flow
 * blockieren.
 */
import type { ApiPushClient } from './api-push.js';
import { debug } from './debug-log.js';

/**
 * Subscribe to push notifications if not already subscribed.
 *
 * Safe to call multiple times — checks existing subscription via
 * `pushManager.getSubscription()` and skips the network round-trip.
 */
export async function subscribePush(api: ApiPushClient): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    debug('push: serviceWorker unsupported');
    return;
  }
  if (typeof window === 'undefined' || !('PushManager' in window)) {
    debug('push: PushManager unsupported');
    return;
  }
  if (typeof Notification === 'undefined') {
    debug('push: Notification API unsupported');
    return;
  }

  try {
    const swReg = await navigator.serviceWorker.ready;

    const existing = await swReg.pushManager.getSubscription();
    if (existing) {
      debug('push: already subscribed', existing.endpoint.slice(0, 40));
      return;
    }

    // Permission gate — only after we know we COULD subscribe.
    if (Notification.permission === 'denied') {
      debug('push: permission denied (user blocked notifications)');
      return;
    }
    if (Notification.permission === 'default') {
      const granted = await Notification.requestPermission();
      if (granted !== 'granted') {
        debug('push: permission not granted', granted);
        return;
      }
    }

    let vapid: { publicKey: string };
    try {
      vapid = await api.getVapidPublicKey();
    } catch (err) {
      debug('push: vapid endpoint failed', errMsg(err));
      return;
    }
    if (!vapid.publicKey) {
      debug('push: vapid publicKey empty');
      return;
    }

    const appServerKey = urlBase64ToUint8Array(vapid.publicKey);
    const sub = await swReg.pushManager.subscribe({
      userVisibleOnly: true,
      // Pass the underlying ArrayBuffer slice — older TS lib.dom types choke
      // on `Uint8Array<ArrayBufferLike>` here (SharedArrayBuffer-narrowing).
      applicationServerKey: appServerKey.buffer.slice(
        appServerKey.byteOffset,
        appServerKey.byteOffset + appServerKey.byteLength,
      ) as ArrayBuffer,
    });

    const p256dhKey = sub.getKey('p256dh');
    const authKey = sub.getKey('auth');
    if (!p256dhKey || !authKey) {
      debug('push: subscription missing keys');
      return;
    }

    const subscribeArgs: Parameters<ApiPushClient['subscribePush']>[0] = {
      endpoint: sub.endpoint,
      p256dh: bytesToBase64(new Uint8Array(p256dhKey)),
      auth: bytesToBase64(new Uint8Array(authKey)),
      userAgent: navigator.userAgent,
    };
    try {
      const { id } = await api.subscribePush(subscribeArgs);
      debug('push: subscribed', id);
    } catch (err) {
      debug('push: server-side subscribe failed', errMsg(err));
      // Rollback — keep the browser subscription if we couldn't persist it
      // (next login attempt will retry the upload).
    }
  } catch (err) {
    debug('push: unexpected error', errMsg(err));
  }
}

/**
 * Best-effort unsubscribe — used by logout-flow / debug-tab.
 *
 * Note: `api` is accepted (and ignored for the browser-side path) so the
 * symmetry with `subscribePush(api)` survives if we later add a server-side
 * subscription-id lookup before unsubscribe.
 */
export async function unsubscribePush(_api: ApiPushClient): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const swReg = await navigator.serviceWorker.ready;
    const sub = await swReg.pushManager.getSubscription();
    if (!sub) return;
    await sub.unsubscribe();
    debug('push: unsubscribed (browser)');
    // Server-side: we don't know the subscriptionId here, so we rely on the
    // /v1/push/subscriptions list + an explicit Debug-Tab action. The 410-handling
    // in PushService removes orphaned rows.
  } catch (err) {
    debug('push: unsubscribe failed', errMsg(err));
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'unknown';
  }
}

/**
 * Convert a base64url-encoded VAPID public key into a Uint8Array buffer that
 * `PushManager.subscribe` accepts as `applicationServerKey`.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Encode a byte buffer as base64 (no URL-safe variant — matches server zod-schema). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}
