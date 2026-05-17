/**
 * PWA-Entry mit Hash-Routing.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 (Roll-Out-Phasen) — Phase 4 PWA-MVP.
 *
 * Routes:
 *   #/login              — anonyme Login-Page (Google-OAuth-Redirect)
 *   #/approvals          — Pending-Approval-Liste (auth required)
 *   #/approvals/:id      — Approval-Detail-View (Sections + Decision)
 *   #/credentials        — Credential-Management (auth required)
 *   #/defaults           — Tool-Defaults-Browser + Edit-Form (auth required)
 *   #/apps               — Apps-Liste (auth required)
 *   #/apps/:id           — Single-App Detail-View mit Block-Rendering
 *   #/enroll-passkey     — Bootstrap nach erstem Google-Login (auth required)
 *
 * Session-Detection: `loadSession()` probet `/auth/refresh` und cached den
 * Output bis zum naechsten `clearSessionCache()`. Bei 401 → Login-Redirect.
 */
import { createApiClient } from './api.js';
import type { ApiClient, Session } from './api.js';
import { createApiStorageClient } from './api-storage.js';
import type { ApiStorageClient } from './api-storage.js';
import { createApiAppsClient } from './api-apps.js';
import type { ApiAppsClient } from './api-apps.js';
import { createApiPrefsClient } from './api-prefs.js';
import type { ApiPrefsClient } from './api-prefs.js';
import { createApiPushClient } from './api-push.js';
import type { ApiPushClient } from './api-push.js';
import {
  loadSession,
  renderLogin,
  renderEnrollPasskey,
  renderSessionExpired,
} from './auth.js';
import { renderApproval, stopApprovalPolling } from './approval.js';
import { renderApprovalDetail } from './approval-detail.js';
import { renderStorageTab } from './storage-tab.js';
import { renderStorageDetail } from './storage-detail.js';
import { renderAppsTab } from './apps-tab.js';
import { renderAppDetail } from './apps-detail.js';
import { renderDefaultsTab } from './defaults-tab.js';
import { renderWritemodeTab } from './writemode-tab.js';
import { renderSettings } from './settings-tab.js';
import { renderToolsTab } from './tools-tab.js';
import { renderServerConfig, renderServerOAuthCallback } from './server-config.js';
import { renderAdminTab } from './admin-tab.js';
import { subscribePush } from './push.js';
import { renderDebugLog, debug } from './debug-log.js';

const api: ApiClient = createApiClient();
const apiStorage: ApiStorageClient = createApiStorageClient();
const apiApps: ApiAppsClient = createApiAppsClient();
const apiPrefs: ApiPrefsClient = createApiPrefsClient();
const apiPush: ApiPushClient = createApiPushClient();

// Best-effort push-subscribe — fired at most once per page-load, after we
// confirm a session exists. The helper itself is idempotent against the
// browser-side `PushManager.getSubscription()` cache.
let pushSubscribeAttempted = false;
async function ensurePushSubscribed(): Promise<void> {
  if (pushSubscribeAttempted) return;
  pushSubscribeAttempted = true;
  try {
    await subscribePush(apiPush);
  } catch (err) {
    debug('main: subscribePush threw', err);
  }
}

type Route =
  | 'login'
  | 'approvals'
  | 'approval-detail'
  | 'settings'
  | 'defaults'
  | 'enroll-passkey'
  | 'storage'
  | 'storage-detail'
  | 'apps'
  | 'apps-detail'
  | 'tools'
  | 'tools-server-config'
  | 'tools-server-oauth-callback'
  | 'writemode'
  | 'admin'
  | 'debug';

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('login')) return 'login';
  // Legacy redirects: Credentials sind seit 2026-05-17 unter
  // #/tools/credentials (semantisch zur MCP-Server-Anbindung gehoerend,
  // nicht zu App-Settings). Beide alten Pfade umleiten.
  if (hash === 'credentials' || hash.startsWith('credentials?') || hash.startsWith('credentials/')) {
    window.location.replace('#/tools/credentials');
    return 'tools';
  }
  if (hash === 'settings/credentials' || hash.startsWith('settings/credentials?')) {
    window.location.replace('#/tools/credentials');
    return 'tools';
  }
  if (hash.startsWith('admin')) return 'admin';
  if (hash.startsWith('settings')) return 'settings';
  // #/tools/servers/<name>/oauth/callback?state=...&code=... (Phase 3)
  if (/^tools\/servers\/[^/?]+\/oauth\/callback/.test(hash)) {
    return 'tools-server-oauth-callback';
  }
  // #/tools/servers/<name>/config — Per-Server-Config-Drawer (Phase 2)
  if (/^tools\/servers\/[^/?]+\/config/.test(hash)) return 'tools-server-config';
  if (hash.startsWith('tools')) return 'tools';
  if (hash.startsWith('defaults')) return 'defaults';
  if (hash.startsWith('writemode') || hash.startsWith('write-mode')) return 'writemode';
  if (hash.startsWith('enroll-passkey')) return 'enroll-passkey';
  if (hash.startsWith('storage/')) return 'storage-detail';
  if (hash === 'storage' || hash.startsWith('storage?')) return 'storage';
  if (hash.startsWith('apps/')) return 'apps-detail';
  if (hash === 'apps' || hash.startsWith('apps?')) return 'apps';
  if (hash.startsWith('approvals/')) return 'approval-detail';
  if (hash === 'debug' || hash.startsWith('debug?')) return 'debug';
  return 'approvals';
}

function parseApprovalDetailId(): string | null {
  // hash form: '#/approvals/<id>' (id is encodeURIComponent'd)
  const hash = window.location.hash;
  const m = hash.match(/^#\/approvals\/([^?]+)/);
  if (!m || !m[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function parseAppsDetailId(): string | null {
  // hash form: '#/apps/<id>' (id is encodeURIComponent'd)
  const hash = window.location.hash;
  const m = hash.match(/^#\/apps\/([^?]+)/);
  if (!m || !m[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function parseStorageDetailId(): string | null {
  // hash form: '#/storage/<id>' (id is encodeURIComponent'd)
  const hash = window.location.hash;
  const m = hash.match(/^#\/storage\/([^?]+)/);
  if (!m || !m[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function parseServerConfigName(): string | null {
  // hash form: '#/tools/servers/<name>/config' or '#/tools/servers/<name>/oauth/callback'
  const hash = window.location.hash;
  const m = hash.match(/^#\/tools\/servers\/([^/?]+)\/(?:config|oauth)/);
  if (!m || !m[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) {
    console.error('mcp-approval2: #app root missing in DOM');
    return;
  }

  // Reset any polling timers from previous routes
  stopApprovalPolling();

  const route = parseRoute();

  // Login is public — no session probe needed
  if (route === 'login') {
    renderLogin(root);
    return;
  }

  // All other routes require a session
  const session = await loadSession(api);
  if (!session) {
    renderLogin(root);
    return;
  }

  // Login-done — fire push-subscribe once per page-load (best-effort, no await
  // dependency on the render-path).
  void ensurePushSubscribed();

  switch (route) {
    case 'enroll-passkey':
      renderEnrollPasskey(root, api, session, () => {
        window.location.hash = '#/approvals';
      });
      return;
    case 'debug':
      renderDebugLog(root);
      return;
    case 'settings':
      await renderSettingsSafe(root, session);
      return;
    case 'tools':
      await renderToolsSafe(root, session);
      return;
    case 'tools-server-config': {
      const name = parseServerConfigName();
      if (!name) {
        window.location.hash = '#/tools/servers';
        return;
      }
      await renderServerConfigSafe(root, session, name);
      return;
    }
    case 'tools-server-oauth-callback': {
      const name = parseServerConfigName();
      if (!name) {
        window.location.hash = '#/tools/servers';
        return;
      }
      await renderServerOAuthCallbackSafe(root, session, name);
      return;
    }
    case 'admin':
      await renderAdminSafe(root, session);
      return;
    case 'storage':
      await renderStorageSafe(root, session);
      return;
    case 'storage-detail': {
      const id = parseStorageDetailId();
      if (!id) {
        window.location.hash = '#/storage';
        return;
      }
      await renderStorageDetailSafe(root, session, id);
      return;
    }
    case 'apps':
      await renderAppsSafe(root, session);
      return;
    case 'apps-detail': {
      const id = parseAppsDetailId();
      if (!id) {
        window.location.hash = '#/apps';
        return;
      }
      await renderAppDetailSafe(root, id);
      return;
    }
    case 'defaults':
      await renderDefaultsSafe(root, session);
      return;
    case 'writemode':
      await renderWritemodeSafe(root, session);
      return;
    case 'approval-detail': {
      const id = parseApprovalDetailId();
      if (!id) {
        window.location.hash = '#/approvals';
        return;
      }
      await renderApprovalDetailSafe(root, session, id);
      return;
    }
    case 'approvals':
    default:
      await renderApprovalSafe(root, api, session);
      return;
  }
}

async function renderDefaultsSafe(root: HTMLElement, s: Session): Promise<void> {
  try {
    await renderDefaultsTab(root, api, apiPrefs, s);
  } catch (err) {
    console.error('defaults render failed', err);
    renderSessionExpired(root);
  }
}

async function renderWritemodeSafe(root: HTMLElement, s: Session): Promise<void> {
  try {
    await renderWritemodeTab(root, api, s);
  } catch (err) {
    console.error('writemode render failed', err);
    renderSessionExpired(root);
  }
}

async function renderApprovalDetailSafe(
  root: HTMLElement,
  s: Session,
  id: string,
): Promise<void> {
  try {
    await renderApprovalDetail(root, api, s, id);
  } catch (err) {
    console.error('approval-detail render failed', err);
    renderSessionExpired(root);
  }
}

async function renderAppsSafe(root: HTMLElement, s: Session): Promise<void> {
  try {
    await renderAppsTab(root, apiApps, api, s);
  } catch (err) {
    console.error('apps render failed', err);
    renderSessionExpired(root);
  }
}

async function renderAppDetailSafe(root: HTMLElement, id: string): Promise<void> {
  try {
    await renderAppDetail(root, apiApps, id);
  } catch (err) {
    console.error('apps-detail render failed', err);
    renderSessionExpired(root);
  }
}

async function renderStorageSafe(root: HTMLElement, s: Session): Promise<void> {
  try {
    await renderStorageTab(root, apiStorage, api, s);
  } catch (err) {
    console.error('storage render failed', err);
    renderSessionExpired(root);
  }
}

async function renderStorageDetailSafe(
  root: HTMLElement,
  s: Session,
  id: string,
): Promise<void> {
  try {
    await renderStorageDetail(root, apiStorage, api, s, id);
  } catch (err) {
    console.error('storage-detail render failed', err);
    renderSessionExpired(root);
  }
}

async function renderApprovalSafe(root: HTMLElement, c: ApiClient, s: Session): Promise<void> {
  try {
    await renderApproval(root, c, s);
  } catch (err) {
    console.error('approval render failed', err);
    renderSessionExpired(root);
  }
}

async function renderSettingsSafe(root: HTMLElement, s: Session): Promise<void> {
  try {
    await renderSettings(root, api, s);
  } catch (err) {
    console.error('settings render failed', err);
    renderSessionExpired(root);
  }
}

async function renderToolsSafe(root: HTMLElement, s: Session): Promise<void> {
  try {
    await renderToolsTab(root, api, s);
  } catch (err) {
    console.error('tools render failed', err);
    renderSessionExpired(root);
  }
}

async function renderServerConfigSafe(
  root: HTMLElement,
  s: Session,
  serverName: string,
): Promise<void> {
  try {
    await renderServerConfig(root, api, s, serverName);
  } catch (err) {
    console.error('server-config render failed', err);
    renderSessionExpired(root);
  }
}

async function renderServerOAuthCallbackSafe(
  root: HTMLElement,
  s: Session,
  serverName: string,
): Promise<void> {
  try {
    await renderServerOAuthCallback(root, api, s, serverName);
  } catch (err) {
    console.error('server-oauth-callback render failed', err);
    renderSessionExpired(root);
  }
}

async function renderAdminSafe(root: HTMLElement, s: Session): Promise<void> {
  try {
    await renderAdminTab(root, api, s);
  } catch (err) {
    console.error('admin render failed', err);
    renderSessionExpired(root);
  }
}

window.addEventListener('hashchange', () => void boot());

// Single-Boot-Pattern: DOMContentLoaded UND der inline readyState-Check
// koennen beide feuern wenn das Script zwischen 'loading' und 'interactive'
// geladen wird. Das verursacht zwei parallele boot()-Aufrufe → zwei
// parallele /auth/refresh-Requests → Server-side refresh-token rotation
// markiert den ersten als "verbraucht", der zweite triggert dann
// refresh_replay_detected (401). Dedup via booted-flag.
let booted = false;
function bootOnce(): void {
  if (booted) return;
  booted = true;
  void boot();
}
window.addEventListener('DOMContentLoaded', bootOnce);
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  bootOnce();
}
