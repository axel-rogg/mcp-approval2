/**
 * Typed fetch-Client zu mcp-approval2-API.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3 (Auth), §5 (Credentials).
 *
 * Same-origin: PWA wird unter demselben Host wie der Hono-Server ausgeliefert
 * (Custom-Domain), Cookies sind `SameSite=Lax`. Im Dev-Server proxyt Vite die
 * `/auth/*`, `/v1/*`, `/oauth/*` Pfade an :8787 (siehe vite.config.ts).
 *
 * Error-Handling: Server liefert `{ error: { code, message, details? } }` mit
 * HTTP-Status. Wir parsen das in `ApiError`.
 */

export type CredentialKind = 'oauth_refresh' | 'api_token' | 'password' | 'service_account';

export interface Session {
  readonly userId: string;
  readonly email: string;
  readonly role: 'admin' | 'member';
  readonly sessionId: string;
  readonly expiresAt: number;
}

export interface PendingApproval {
  readonly id: string;
  readonly toolName: string;
  readonly sensitivity: 'write' | 'danger';
  readonly displayTemplate?: string;
  readonly displayRendered?: string | null;
  readonly input: Record<string, unknown>;
  readonly requestedAt: number;
  readonly status: 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'expired';
  readonly requiresPrf?: boolean;
  readonly allowCredentialIdsB64?: ReadonlyArray<string>;
  readonly challengeB64?: string;
  readonly approvedAt?: number | null;
  readonly rejectedAt?: number | null;
  readonly expiredAt?: number | null;
  /** Original-Ablauf-Zeit (vor Lazy-Flip); UI nutzt es als Fallback. */
  readonly expiresAt?: number | null;
  /** Wie oft hat der User die TTL verlaengert (0..3). Aus Mig 0025. */
  readonly extensionCount?: number;
  /**
   * Attribution-Snapshot (PLAN-tool-defaults-v2.md Phase A). Pro Feld in
   * `input`, woher der Wert kam (User-Input vs Tool-Default-System).
   * Aus Mig 0027.
   */
  readonly defaultsApplied?: ReadonlyArray<{
    readonly field: string;
    readonly from: 'user-input' | 'tool-default';
    readonly profile?: string;
  }>;
}

export interface CredentialMeta {
  readonly id: string;
  readonly ownerId: string;
  readonly provider: string;
  readonly kind: CredentialKind;
  readonly label: string;
  readonly prfEnabled: boolean;
  readonly prfCredentialIdB64: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: number;
  readonly rotatedAt: number | null;
  readonly lastUsedAt: number | null;
  readonly expiresAt: number | null;
}

export interface InventoryNativeTool {
  readonly name: string;
  readonly description: string;
  readonly sensitivity: 'read' | 'write' | 'danger';
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
}

export interface InventoryGatewayTool {
  readonly name: string;
  readonly description: string | null;
  readonly sensitivity: 'read' | 'write' | 'danger';
  /**
   * JSON-Schema des Tool-Inputs (Phase B, PLAN-tool-defaults-v2.md). Wird
   * vom Defaults-Tab fuer den Field-Picker konsumiert. `null` wenn nicht
   * verfuegbar.
   */
  readonly inputSchema?: Record<string, unknown> | null;
}

export interface InventoryRequiredCredential {
  readonly provider: string;
  readonly kind: string | null;
}

export interface InventoryGateway {
  readonly name: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly toolsCachedAt: number | null;
  readonly tools: ReadonlyArray<InventoryGatewayTool>;
  readonly requiredCredentials: ReadonlyArray<InventoryRequiredCredential>;
  /** Phase 2: pro-Server config-schema vom Worker via tools/list._meta. */
  readonly configSchema?: Record<string, unknown> | null;
  /** Phase 4: TRUE wenn dieser Server vom aktuellen User selbst angelegt wurde. */
  readonly isUserOwned?: boolean;
}

export interface ServerConfigResponse {
  readonly fields: Record<string, { value: string; isSecret: boolean; updatedAt: number }>;
}

export interface AddUserServerArgs {
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly authMode?: 'service_bearer' | 'oauth';
  readonly serviceTokenPlain?: string;
  readonly configSchema?: Record<string, unknown>;
  readonly enableSubscription?: boolean;
}

export interface AddUserServerResult {
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly authMode: string;
  readonly ownerUserId: string;
  readonly subscribed: boolean;
}

export type ToolDefaultValueKind =
  | 'text'
  | 'json'
  | 'number'
  | 'boolean'
  | 'enum';

export interface ToolDefaultHint {
  readonly userId: string;
  readonly subMcpName: string;
  readonly toolName: string;
  readonly fieldName: string;
  readonly hintText: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ToolDefaultProfile {
  readonly userId: string;
  readonly subMcpName: string;
  readonly profileName: string;
  readonly description: string;
  readonly isActive: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ToolDefault {
  readonly userId: string;
  readonly subMcpName: string;
  /** Phase C: per-Profil isoliert. Default `'default'`. */
  readonly profileName: string;
  readonly toolName: string;
  readonly fieldName: string;
  /** Phase B: typed (string|number|boolean|object|array|null). */
  readonly value: unknown;
  readonly valueKind: ToolDefaultValueKind;
  readonly isSecret: boolean;
  /** Set wenn das Feld nicht (mehr) im aktuellen Tool-Schema vorkommt. */
  readonly orphanSince: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InventoryAvailableServer {
  readonly name: string;
  readonly displayName: string;
  readonly toolsCount: number;
  readonly requiredCredentials: ReadonlyArray<InventoryRequiredCredential>;
}

export interface InventoryResponse {
  readonly native: ReadonlyArray<InventoryNativeTool>;
  readonly gateways: ReadonlyArray<InventoryGateway>;
  /** Catalog-Defaults die der User noch nicht aktiviert hat. */
  readonly available?: ReadonlyArray<InventoryAvailableServer>;
}

export interface RediscoverGatewayResult {
  readonly subMcpName: string;
  readonly count: number;
  readonly error?: string;
}

export interface RediscoverGatewaysResponse {
  readonly results: ReadonlyArray<RediscoverGatewayResult>;
  readonly registered: number;
  readonly deregistered: number;
  readonly total_tools: number;
  readonly per_sub_mcp: Record<string, number>;
  readonly skipped: ReadonlyArray<string>;
}

export interface ApiClient {
  // Auth
  getSession(): Promise<Session | null>;
  logout(): Promise<void>;

  // Approvals
  listApprovals(args?: {
    status?: 'pending' | 'approved' | 'rejected' | 'expired';
    /** Multi-Filter (Archive-View) — Server akzeptiert CSV. */
    statusIn?: ReadonlyArray<'pending' | 'approved' | 'rejected' | 'expired'>;
    /** Archive-Zeitfenster: `Date.now() - 24*3600*1000`. */
    sinceMs?: number;
    limit?: number;
  }): Promise<PendingApproval[]>;
  getApproval(id: string): Promise<PendingApproval>;
  approveApproval(args: {
    id: string;
    /** Vollstaendige WebAuthn-Assertion fuer Server-Side-Verify (SEC-001). */
    credentialIdB64: string;
    authenticatorDataB64: string;
    clientDataJsonB64: string;
    signatureB64: string;
    userHandleB64?: string;
    prfSessionId?: string;
  }): Promise<void>;
  rejectApproval(args: { id: string; reason?: string }): Promise<void>;
  /**
   * Verlaengert die TTL eines pending-Approvals um `minutes` (5, 10 oder 15).
   * Max 3 Extensions pro Approval (server enforced).
   */
  extendApproval(args: { id: string; minutes: 5 | 10 | 15 }): Promise<PendingApproval>;
  pollResult(approvalId: string): Promise<unknown>;
  getApprovalChallenge(id: string): Promise<{ challengeB64: string; allowCredentialIdsB64: string[] }>;

  // Inventory (Tools/Servers)
  listInventory(): Promise<InventoryResponse>;
  rediscoverGateways(name?: string): Promise<RediscoverGatewaysResponse>;
  /**
   * Toggle per-user-subscription auf einen Sub-MCP-Server.
   * PATCH /v1/me/servers/:name/subscription
   */
  setServerSubscription(name: string, enabled: boolean): Promise<void>;
  /** Phase 2: GET /v1/me/servers/:name/config */
  getServerConfig(name: string): Promise<ServerConfigResponse>;
  /** Phase 2: PUT /v1/me/servers/:name/config/:key */
  setServerConfig(name: string, key: string, value: string): Promise<void>;
  /** Phase 2: DELETE /v1/me/servers/:name/config/:key */
  deleteServerConfig(name: string, key: string): Promise<void>;
  /** Phase 3: OAuth-Authorize start (pre-registered). */
  startServerOAuth(name: string, redirectUri: string): Promise<{ authorizeUrl: string; state: string }>;
  /** Phase 3: OAuth-Callback (state + code aus dem Provider-Redirect). */
  completeServerOAuth(name: string, state: string, code: string): Promise<void>;
  /** Phase 4: User-Added-Server registrieren. */
  addUserServer(args: AddUserServerArgs): Promise<AddUserServerResult>;
  /** Phase 4: User-Added-Server entfernen (catalog-defaults werden 404). */
  deleteUserServer(name: string): Promise<void>;
  /** Phase D UX-Refactor: per-Tool Defaults listen. */
  listToolDefaults(name: string): Promise<ReadonlyArray<ToolDefault>>;
  /** Phase B (typed): per-Tool Default upserten. value ist beliebiger JSON-Type. */
  setToolDefault(args: {
    serverName: string;
    toolName: string;
    fieldName: string;
    value: unknown;
    valueKind?: ToolDefaultValueKind;
    profile?: string;
    isSecret?: boolean;
  }): Promise<ToolDefault>;
  /** Phase B: per-Tool Default entfernen (optional profile-scoped). */
  deleteToolDefault(args: {
    serverName: string;
    toolName: string;
    fieldName: string;
    profile?: string;
  }): Promise<void>;
  /** Phase C: Profile listen pro Server. */
  listProfiles(serverName: string): Promise<ReadonlyArray<ToolDefaultProfile>>;
  /** Phase C: neues Profil anlegen, optional aus copyFrom kopieren + aktivieren. */
  createProfile(args: {
    serverName: string;
    name: string;
    description?: string;
    copyFrom?: string;
    activate?: boolean;
  }): Promise<ToolDefaultProfile>;
  /** Phase C: Profil als aktiv setzen (flip-flop atomar). */
  activateProfile(serverName: string, profileName: string): Promise<void>;
  /** Phase C: Profil + alle Defaults loeschen. Refuse wenn aktiv. */
  deleteProfile(serverName: string, profileName: string): Promise<void>;
  /** Phase E: Hints fuer alle Tools eines Servers listen. */
  listHints(serverName: string): Promise<ReadonlyArray<ToolDefaultHint>>;
  /**
   * Phase E: Hint setzen oder loeschen (empty-string = delete, Convention
   * mit Backend-Route).
   */
  setHint(args: {
    serverName: string;
    toolName: string;
    fieldName: string;
    hintText: string;
  }): Promise<ToolDefaultHint | null>;
  /** Phase E: Hint explizit loeschen. */
  deleteHint(args: {
    serverName: string;
    toolName: string;
    fieldName: string;
  }): Promise<void>;

  // Credentials
  listCredentials(): Promise<CredentialMeta[]>;
  addCredential(args: {
    provider: string;
    kind: CredentialKind;
    label: string;
    secret: string;
    prfSessionId?: string;
  }): Promise<CredentialMeta>;
  deleteCredential(id: string): Promise<void>;
  storePrfSession(args: { prfOutput: string; ttlSec?: number }): Promise<{ sessionId: string }>;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ServerError {
  readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown };
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    // Empty body — some 204-style routes
    if (res.ok) return undefined as T;
    throw new ApiError(res.status, 'http_error', `HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(res.status, 'invalid_json', `Non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const err = (body as ServerError).error;
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? `HTTP ${res.status}`,
      err?.details,
    );
  }
  return body as T;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  readonly body?: unknown;
  readonly query?: Record<string, string | undefined>;
}

function buildUrl(base: string, path: string, query?: Record<string, string | undefined>): string {
  const u = new URL(path, base.endsWith('/') ? base : `${base}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, v);
    }
  }
  return u.toString();
}

export function createApiClient(baseUrl?: string): ApiClient {
  const base = baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787');

  // Aktueller access-token (JWT) aus dem letzten erfolgreichen /auth/refresh.
  // /v1/*-Routen verlangen `Authorization: Bearer <token>` (siehe
  // apps/server/src/middleware/auth.ts) — ohne header → 401.
  // session_jwt-Cookie auf Server-Seite ist NUR fuer die OAuth-Authorize-
  // Facade, nicht fuer /v1/. Daher Bearer-Header pflichtig.
  let currentAccessToken: string | null = null;
  let lastSession: Session | null = null;

  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (currentAccessToken) headers['authorization'] = `Bearer ${currentAccessToken}`;
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      credentials: 'include',
      headers,
    };
    if (opts.body !== undefined) {
      init.headers = { ...init.headers, 'content-type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    let res = await fetch(buildUrl(base, path, opts.query), init);
    // Auto-retry on 401: token expired or freshly-reset. Try one refresh +
    // retry. Avoids the user seeing a session-expired screen after 30 min.
    if (res.status === 401 && currentAccessToken) {
      const fresh = await doRefresh();
      if (fresh) {
        const headers2: Record<string, string> = { ...headers, authorization: `Bearer ${fresh}` };
        if (opts.body !== undefined) headers2['content-type'] = 'application/json';
        res = await fetch(buildUrl(base, path, opts.query), { ...init, headers: headers2 });
      }
    }
    return parseJson<T>(res);
  }

  // Belt-and-suspenders in-flight dedup: auch wenn der API-Client direkt
  // (ohne loadSession-Wrapper) mehrmals parallel aufgerufen wird, geht nur
  // EIN POST /auth/refresh raus. Refresh-token-rotation am Server invalidiert
  // den alten Token bei der ersten Antwort — paralleler 2. Call wuerde
  // refresh_replay_detected (401) triggern.
  let refreshInflight: Promise<Session | null> | null = null;

  // Internal refresh helper: macht den /auth/refresh-Call mit Dedup. Setzt
  // currentAccessToken bei Erfolg. Returns die fresh-token-string (oder null).
  // Wird auch von der request()-401-Retry verwendet.
  async function doRefresh(): Promise<string | null> {
    if (refreshInflight) {
      await refreshInflight;
      return currentAccessToken;
    }
    refreshInflight = (async () => {
      try {
        const res = await fetch(buildUrl(base, '/auth/refresh'), {
          method: 'POST',
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          currentAccessToken = null;
          lastSession = null;
          return null;
        }
        const body = (await res.json()) as {
          accessToken: string;
          expiresAt: number;
          sessionId: string;
          user?: { id: string; email: string; role: 'admin' | 'member' };
        };
        currentAccessToken = body.accessToken;
        lastSession = {
          userId: body.user?.id ?? '',
          email: body.user?.email ?? '',
          role: body.user?.role ?? ('member' as const),
          sessionId: body.sessionId,
          expiresAt: body.expiresAt,
        };
        return lastSession;
      } catch {
        currentAccessToken = null;
        lastSession = null;
        return null;
      }
    })().finally(() => {
      refreshInflight = null;
    });
    await refreshInflight;
    return currentAccessToken;
  }
  return {
    async getSession() {
      // doRefresh() dedupliziert intern + setzt currentAccessToken.
      // Returns null wenn refresh fail't, sonst Session-Object (aus dem
      // letzten body.user / body.sessionId).
      await doRefresh();
      // Wir muessen die Session-Daten nochmal aus dem letzten Refresh holen.
      // Da doRefresh die Body-Daten weggeworfen hat (nur accessToken behalten),
      // nochmal kurz lesen via einem separaten Probe-Request waere doppelt-
      // arbeit. Stattdessen: doRefresh wurde so umgebaut dass es das Session-
      // Object via lastSession-cache zurueckgibt.
      return lastSession;
    },

    async logout() {
      await request<{ ok: true }>('/auth/logout', { method: 'POST' });
    },

    async listApprovals(args) {
      // Server-route ist /v1/approvals (list) mit query-filter — NICHT
      // /v1/approvals/pending. Letzteres trifft auf /v1/approvals/:id und
      // Postgres wirft "invalid input syntax for type uuid: pending".
      const query: Record<string, string | undefined> = {};
      if (args?.statusIn && args.statusIn.length > 0) {
        query['statusIn'] = args.statusIn.join(',');
      } else if (args?.status) {
        query['status'] = args.status;
      }
      if (args?.sinceMs !== undefined) query['sinceMs'] = String(args.sinceMs);
      if (args?.limit !== undefined) query['limit'] = String(args.limit);
      const out = await request<{ approvals: PendingApproval[] }>('/v1/approvals', {
        query,
      });
      return out.approvals;
    },

    async getApproval(id) {
      // Server returnt { approval: ... } — nicht { item: ... }.
      const out = await request<{ approval: PendingApproval }>(`/v1/approvals/${encodeURIComponent(id)}`);
      return out.approval;
    },

    async getApprovalChallenge(id) {
      return request<{ challengeB64: string; allowCredentialIdsB64: string[] }>(
        `/v1/approvals/${encodeURIComponent(id)}/challenge`,
        { method: 'POST' },
      );
    },

    async approveApproval(args) {
      // Server-route ist /v1/approvals/:id/approve (NICHT /sign — alter Pfad,
      // existiert auf v2 nicht mehr). SEC-001: senden die vollstaendige
      // WebAuthn-Assertion damit der Server gegen die in
      // pending_approvals.approval_challenge gespeicherte Challenge verifizieren
      // kann.
      await request<{ approval: unknown; resume_error: string | null }>(
        `/v1/approvals/${encodeURIComponent(args.id)}/approve`,
        {
          method: 'POST',
          body: {
            credentialIdB64: args.credentialIdB64,
            authenticatorDataB64: args.authenticatorDataB64,
            clientDataJsonB64: args.clientDataJsonB64,
            signatureB64: args.signatureB64,
            ...(args.userHandleB64 ? { userHandleB64: args.userHandleB64 } : {}),
            ...(args.prfSessionId ? { prfSessionId: args.prfSessionId } : {}),
          },
        },
      );
    },

    async rejectApproval(args) {
      await request<{ ok: true }>(`/v1/approvals/${encodeURIComponent(args.id)}/reject`, {
        method: 'POST',
        body: args.reason ? { reason: args.reason } : undefined,
      });
    },

    async extendApproval(args) {
      const out = await request<{ approval: PendingApproval }>(
        `/v1/approvals/${encodeURIComponent(args.id)}/extend`,
        {
          method: 'POST',
          body: { minutes: args.minutes },
        },
      );
      return out.approval;
    },

    async pollResult(approvalId) {
      const out = await request<{ result?: unknown; status: string }>(
        `/v1/approvals/${encodeURIComponent(approvalId)}/result`,
      );
      return out.result;
    },

    async listInventory() {
      return await request<InventoryResponse>('/v1/inventory');
    },

    async rediscoverGateways(name?: string) {
      return await request<RediscoverGatewaysResponse>(
        '/v1/gateways/rediscover',
        {
          method: 'POST',
          body: name ? { name } : {},
        },
      );
    },

    async setServerSubscription(name: string, enabled: boolean) {
      await request<void>(`/v1/me/servers/${encodeURIComponent(name)}/subscription`, {
        method: 'PATCH',
        body: { enabled },
      });
    },

    async getServerConfig(name: string) {
      return await request<ServerConfigResponse>(
        `/v1/me/servers/${encodeURIComponent(name)}/config`,
      );
    },

    async setServerConfig(name: string, key: string, value: string) {
      await request<void>(
        `/v1/me/servers/${encodeURIComponent(name)}/config/${encodeURIComponent(key)}`,
        { method: 'PUT', body: { value } },
      );
    },

    async deleteServerConfig(name: string, key: string) {
      await request<void>(
        `/v1/me/servers/${encodeURIComponent(name)}/config/${encodeURIComponent(key)}`,
        { method: 'DELETE' },
      );
    },

    async startServerOAuth(name: string, redirectUri: string) {
      return await request<{ authorizeUrl: string; state: string }>(
        `/v1/me/servers/${encodeURIComponent(name)}/oauth/start`,
        { method: 'POST', body: { redirectUri } },
      );
    },

    async completeServerOAuth(name: string, state: string, code: string) {
      await request<void>(
        `/v1/me/servers/${encodeURIComponent(name)}/oauth/callback`,
        { method: 'POST', body: { state, code } },
      );
    },

    async addUserServer(args: AddUserServerArgs) {
      return await request<AddUserServerResult>('/v1/me/servers', {
        method: 'POST',
        body: args,
      });
    },

    async deleteUserServer(name: string) {
      await request<void>(`/v1/me/servers/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
    },

    async listToolDefaults(name: string) {
      const out = await request<{ defaults: ToolDefault[] }>(
        `/v1/me/servers/${encodeURIComponent(name)}/tool-defaults`,
      );
      return out.defaults;
    },

    async setToolDefault(args) {
      const body: Record<string, unknown> = { value: args.value };
      if (args.valueKind !== undefined) body['valueKind'] = args.valueKind;
      if (args.profile !== undefined) body['profile'] = args.profile;
      if (args.isSecret !== undefined) body['isSecret'] = args.isSecret;
      return await request<ToolDefault>(
        `/v1/me/servers/${encodeURIComponent(args.serverName)}/tool-defaults/${encodeURIComponent(args.toolName)}/${encodeURIComponent(args.fieldName)}`,
        { method: 'PUT', body },
      );
    },

    async deleteToolDefault(args) {
      const q = args.profile ? `?profile=${encodeURIComponent(args.profile)}` : '';
      await request<void>(
        `/v1/me/servers/${encodeURIComponent(args.serverName)}/tool-defaults/${encodeURIComponent(args.toolName)}/${encodeURIComponent(args.fieldName)}${q}`,
        { method: 'DELETE' },
      );
    },

    async listProfiles(serverName) {
      const out = await request<{ profiles: ToolDefaultProfile[] }>(
        `/v1/me/servers/${encodeURIComponent(serverName)}/default-profiles`,
      );
      return out.profiles;
    },

    async createProfile(args) {
      const body: Record<string, unknown> = { name: args.name };
      if (args.description !== undefined) body['description'] = args.description;
      if (args.copyFrom !== undefined) body['copyFrom'] = args.copyFrom;
      if (args.activate !== undefined) body['activate'] = args.activate;
      return await request<ToolDefaultProfile>(
        `/v1/me/servers/${encodeURIComponent(args.serverName)}/default-profiles`,
        { method: 'POST', body },
      );
    },

    async activateProfile(serverName, profileName) {
      await request<void>(
        `/v1/me/servers/${encodeURIComponent(serverName)}/default-profiles/${encodeURIComponent(profileName)}/activate`,
        { method: 'POST' },
      );
    },

    async deleteProfile(serverName, profileName) {
      await request<void>(
        `/v1/me/servers/${encodeURIComponent(serverName)}/default-profiles/${encodeURIComponent(profileName)}`,
        { method: 'DELETE' },
      );
    },

    async listHints(serverName) {
      const out = await request<{ hints: ToolDefaultHint[] }>(
        `/v1/me/servers/${encodeURIComponent(serverName)}/tool-hints`,
      );
      return out.hints;
    },

    async setHint(args) {
      // Empty-String-Convention: PUT mit hintText='' → 204 (Backend delete).
      const path = `/v1/me/servers/${encodeURIComponent(args.serverName)}/tool-hints/${encodeURIComponent(args.toolName)}/${encodeURIComponent(args.fieldName)}`;
      if (args.hintText === '') {
        await request<void>(path, { method: 'PUT', body: { hintText: '' } });
        return null;
      }
      return await request<ToolDefaultHint>(path, {
        method: 'PUT',
        body: { hintText: args.hintText },
      });
    },

    async deleteHint(args) {
      await request<void>(
        `/v1/me/servers/${encodeURIComponent(args.serverName)}/tool-hints/${encodeURIComponent(args.toolName)}/${encodeURIComponent(args.fieldName)}`,
        { method: 'DELETE' },
      );
    },

    async listCredentials() {
      const out = await request<{ credentials: CredentialMeta[] }>('/v1/credentials');
      return out.credentials;
    },

    async addCredential(args) {
      const out = await request<{ credential: CredentialMeta }>('/v1/credentials', {
        method: 'POST',
        body: {
          provider: args.provider,
          kind: args.kind,
          label: args.label,
          secret: args.secret,
          ...(args.prfSessionId ? { prfSessionId: args.prfSessionId } : {}),
        },
      });
      return out.credential;
    },

    async deleteCredential(id) {
      await request<{ ok: true }>(`/v1/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    async storePrfSession(args) {
      const out = await request<{ prfSessionId: string; ttlSec: number }>(
        '/v1/credentials/prf-session',
        {
          method: 'POST',
          body: {
            prfOutputB64: args.prfOutput,
            ...(args.ttlSec !== undefined ? { ttlSec: args.ttlSec } : {}),
          },
        },
      );
      return { sessionId: out.prfSessionId };
    },
  };
}
