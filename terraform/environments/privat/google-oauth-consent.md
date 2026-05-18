# Google OAuth Consent Screen — manuelle Scope-Konfiguration

> **Warum diese Datei und kein `.tf`?** Google's TF-Provider managed die
> Scope-Liste im OAuth-Consent-Screen NICHT. `google_iap_brand` setzt nur
> IAP-Branding, `clientauthconfig.googleapis.com` (seit 2024) managed nur
> OAuth-Clients (ID/Secret), nicht den Consent-Screen. Stand 2026-05-18 ist
> dies eines der wenigen GCP-Features die nur via **Console-UI** konfigurierbar
> sind — mehrfach von Google als "in Bearbeitung" markierter Feature-Request.
>
> Dieser Markdown ist der **Source-of-Truth** für die Scope-Liste die manuell
> in der Console gepflegt werden muss. Bei jedem neuen GCP-Projekt (Familie,
> Self-Host-für-Freunde, Business) muss diese Liste 1:1 eingetragen werden.

## Wo eintragen

1. https://console.cloud.google.com/auth/scopes (neue UI 2025) — oder via
   "APIs & Dienste" → "OAuth-Zustimmungsbildschirm" → Tab "Datenzugriff/Scopes"
2. "Hinzufügen oder entfernen" klicken
3. Scopes anhaken (Such-/Filter-Feld nutzen)
4. Speichern → "App-Eintragung aktualisieren"

## Scope-Bundle für mcp-approval2 (16 Scopes)

### Identity (3) — von jedem OAuth-Flow gebraucht

```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

### gcloud-Gateway (1) — für `mcp-gcloud` Worker + LLM (Vertex AI / Gemini)

```
https://www.googleapis.com/auth/cloud-platform
```

Dieser ein Scope deckt **fast alle** GCP-Resourcen ab:
- Compute Engine, BigQuery, Cloud Storage, Cloud SQL, IAM, KMS, ...
- **Vertex AI** (Gemini, Claude on Vertex, text-embedding-005, ...)
- **AI Platform** (legacy ML APIs)
- **Document AI**, **Speech-to-Text**, **Translation**, ...

Analog zu `gcloud auth login` Default-Scope. Sensitive scope — muss explizit
eingetragen werden.

### Generative Language API (Google AI Studio / Gemini) — optional (2-3)

Wenn du **OAuth-Zugriff** auf `generativelanguage.googleapis.com` willst
(Google AI Studio API, NICHT Vertex — Vertex ist von `cloud-platform`
abgedeckt). Die meisten User auth'en hier per API-Key statt OAuth — eine
reine Inferenz hat KEINEN OAuth-Scope. Nur fuer erweiterte Endpoints:

```
https://www.googleapis.com/auth/generative-language.tuning
https://www.googleapis.com/auth/generative-language.retriever
```

- `generative-language.tuning`: Fine-Tuning-Endpoints + Models-Listing (sensitive)
- `generative-language.retriever`: Semantic Retrieval API (Corpora, Documents)

**Achtung Fallstrick:** `https://www.googleapis.com/auth/generative-language`
(ohne Suffix) EXISTIERT NICHT bei Google. Google returnt
`invalid_scope` wenn du den anforderst.

**Voraussetzung:** Generative Language API im Projekt aktiviert
(https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com).

### gws-Gateway (12) — für `mcp-gws` Worker (Google Workspace)

**Calendar + Tasks (2)**
```
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/tasks
```

**Gmail (2)**
```
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/gmail.send
```

**Sheets + Docs + Slides + Forms (5)**
```
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/presentations
https://www.googleapis.com/auth/forms.body
https://www.googleapis.com/auth/forms.responses.readonly
```

**Drive (3)**
```
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/drive.activity.readonly
```

**Contacts (1)**
```
https://www.googleapis.com/auth/contacts
```

## Test-User vs Veröffentlichung

- **Testing-Modus** (default, ausreichend für Solo/Familie): du selbst + max 100
  Test-User in der App-Konfig auflisten. Keine Google-Verifikation nötig.
- **Production-Modus**: Verifikation durch Google nötig für Restricted Scopes
  (`gmail.modify`, `drive`, `contacts` — sensitive). 4-6 Wochen Prozess +
  Privacy-Policy + Security-Audit. Für Business-Mode später relevant.

## Voraussetzung: APIs aktivieren

Pro Projekt müssen folgende APIs einmalig aktiviert sein (Library):
https://console.cloud.google.com/apis/library

| Scope-Gruppe | Erforderliche APIs |
|---|---|
| OAuth Identity | (keine — eingebaut) |
| cloud-platform | Cloud Resource Manager API, Service Usage API, plus die spezifischen APIs die du nutzt (Compute, BigQuery, GCS, ...) |
| Calendar | Google Calendar API |
| Tasks | Tasks API |
| Gmail | Gmail API |
| Sheets | Google Sheets API |
| Docs | Google Docs API |
| Slides | Google Slides API |
| Forms | Google Forms API |
| Drive | Google Drive API + Drive Activity API |
| Contacts | People API |

## OAuth-Client Redirect-URIs

Im gleichen Projekt unter [APIs & Dienste → Anmeldedaten](https://console.cloud.google.com/apis/credentials):

```
https://mcp-approval2.fly.dev/oauth/sub-mcp-callback
https://mcp2.ai-toolhub.org/oauth/sub-mcp-callback
https://app2.ai-toolhub.org/oauth/sub-mcp-callback
```

Plus optional die Login-Callbacks falls derselbe Client für PWA-Login genutzt
wird:

```
https://mcp-approval2.fly.dev/auth/google/callback
https://mcp2.ai-toolhub.org/auth/google/callback
https://app2.ai-toolhub.org/auth/google/callback
```

## Drift-Check (manuell)

`gcloud auth list` zeigt nur die access-tokens des CLI-Users, nicht die
Consent-Screen-Config. Drift-Prüfung nur via Console-UI:

```bash
# Open Console
gcloud config get-value project
open "https://console.cloud.google.com/auth/scopes?project=$(gcloud config get-value project)"
```

Wenn Code-Updates in `apps/server/src/mcp/gateway/seed_satellites.ts` neue
Scopes hinzufügen, **muss diese Datei UND die Console-Config beide aktualisiert
werden**. Pull-Request-Reminder: bei Scope-Changes immer prüfen `git diff
apps/server/src/mcp/gateway/seed_satellites.ts` + diese Datei.
