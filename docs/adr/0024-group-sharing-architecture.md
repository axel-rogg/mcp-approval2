# ADR-0024: Group-basiertes Document-Sharing — Crypto- und Atomicity-Architektur

**Status:** Accepted
**Date:** 2026-05-17
**Deciders:** Axel + Claude + Crypto-Specialist-Subagent (Pre-Build-Review)
**Plan-Reference:** [mcp-knowledge2/docs/plans/active/PLAN-sharing-group-phase-1.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/plans/active/PLAN-sharing-group-phase-1.md) · [mcp-knowledge2/docs/security/CRYPTO-REVIEW-GROUP-SHARING-2026-05-17.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/security/CRYPTO-REVIEW-GROUP-SHARING-2026-05-17.md) · ADR-0014 · ADR-0016

## Context and Problem Statement

mcp-knowledge2 hat heute eine `share_grants(resource_id, granted_to=user_id, scope='read'|'write')`-Tabelle, aber Body-Decrypt für non-Owner wirft `501 shared-body-not-implemented` — Body ist mit Owner-DEK + AAD `objects|<owner_id>|<object_id>` verschlüsselt. Damit ist Sharing heute eine reine Metadaten-Sichtbarkeit, nicht echter Daten-Zugriff.

Firma-Use-Case (siehe ADR-0023 — Shared Codebase, Isolated Environments): Teams müssen Skills + zugehörige Dokumente gemeinsam lesen können. Auto-Cascade bei neuen Skill-Resources ist Erwartungs-konform. Family-Modus braucht das nicht (informelles Teilen reicht), Self-Host-für-Freunde + Corporate-Modi brauchen es als Default-Feature.

Vier Architektur-Entscheidungen müssen vor dem ersten Schema-Commit getroffen werden:
1. Sharing-Granularität: 1:1-pro-User oder Group-only?
2. Body-Encryption-Pattern: wrap-per-User, Group-Master-Key, oder Proxy-Re-Encryption?
3. AAD-Pattern für Multi-Recipient: Owner-ID rein/raus, Group-ID rein/raus?
4. Member-Remove-Atomicity: einzelne TX oder Multi-Step mit Recovery?

## Considered Options

### Sharing-Granularität
- **A:** Hybrid (1:1-User-Grants ODER Group-Grants)
- **B:** Group-only (1:1 wird ad-hoc-Group mit 2 Members)
- **C:** Nur 1:1 (keine Groups)

### Body-Encryption-Pattern
- **A:** Wrap-per-Recipient (Object-DEK N-mal pro Recipient gewrapped)
- **B:** Group-Master-Key (Object-DEK mit Group-Master gewrapped, Group-Master pro Member gewrapped)
- **C:** Proxy-Re-Encryption (Server kann Ciphertext für Recipient re-encrypten ohne Plaintext zu sehen)
- **D:** End-to-End-Hand-off via PWA (Owner-Browser entschlüsselt + re-encryptet client-side)

### AAD-Pattern für Multi-Recipient
- **A:** Status quo `objects|<owner_id>|<object_id>` — bricht bei Owner-Transfer
- **B:** `objects-v2|<object_id>` (kein Owner im AAD)
- **C:** `objects|<group_id>|<object_id>` — bricht bei Cross-Group-Share

### Member-Remove-Atomicity
- **A:** Eine TX mit `FOR UPDATE` auf `groups.id`, Re-Wraps in Memory
- **B:** Multi-Step mit async Worker, eventually-consistent
- **C:** Optimistic Locking ohne TX

## Decision Outcome

**Chosen options:**

1. **Sharing-Granularität: Option B (Group-only).** 1:1-Sharing wird intern als ad-hoc-2-Member-Group implementiert (PWA-Convenience), Tool-Surface kennt nur `share_with_group`. Begründung: Firma denkt in Teams, nicht in 1:1-Tupeln. Maintenance ist Mengenlehre statt Buchhaltung — Member-Add/Remove ist eine Operation statt N Document-Grant-Manipulationen.

2. **Body-Encryption-Pattern: Option B (Group-Master-Key).** Object-DEK ist random pro Object (`per_object`-Scheme), wrapped mit Group-Master. Group-Master ist mit GCP-KMS gewrapped (Variante C aus dem Crypto-Review) + Process-Cache (TTL 5min). Pro-Member wird Group-Master separat mit Member-KEK gewrapped. Begründung: Member-Remove-Kosten sind `O(remaining_members)` Wraps statt `O(remaining_members × shared_objects)` — Body bleibt eingefroren.

3. **AAD-Pattern: Option B (`objects-v2|<object_id>`)** für `dek_scheme='per_object'`. Legacy-Objects mit `dek_scheme='owner_hkdf'` behalten altes AAD `objects|<owner_id>|<object_id>`. Discriminator über `objects.dek_scheme`-Spalte. Begründung: Owner-Transfer + Cross-Group-Share funktionieren ohne Re-Encrypt. Replay-Schutz bleibt durch Object-ID-Binding + Per-Object-DEK (kein cross-user-derivable).

4. **Member-Remove-Atomicity: Option A (Eine TX mit `FOR UPDATE` auf `groups.id`).** Re-Wraps sind reine Memory-Operationen nach 1× KMS-Wrap des neuen Masters → Lock-Window <100ms bei realistic Sizes (M=50 Members, N=200 Grants). Hard-Cap `MAX_GRANTS_PER_GROUP=1000` für Phase 1 — bei Überschreitung RAISE EXCEPTION, async Worker kommt in Phase 2+.

**Cascade-Hook bei `addObjectRef(role='skill_resource')`:** parent-Skill wird mit `FOR UPDATE` gelockt, alle aktiven Group-Shares des Parents werden auf das Child kopiert (mit `via_cascade_from_object_id=parent_id` als Audit-Spur). Diamond-Cascade-Safety über `UNIQUE(resource_id, granted_to_group_id, via_cascade_from_object_id)`-Index.

**Lock-Hierarchy** zur Deadlock-Vermeidung: `groups.id < objects.id < share_grants.id` strikt.

**Forward-Secrecy:** best-effort durch Master-Rotation, NICHT crypto-erzwingbar. Bereits gecachte Bodies bleiben für removed Members lesbar (Memory-Capture, kein Crypto-Bug). User-Caveat in PWA-UI Pflicht: "Mitglied verliert ab jetzt Zugriff — bereits heruntergeladene Inhalte kann das System nicht zurückrufen."

**Read-Audit:** Pro Group toggle-bar (`groups.read_audit_enabled`). Default OFF. Wenn ON: jeder Body-Read von non-Owner schreibt `share.read`-Event. Members beim Beitritt benachrichtigt.

## Consequences

### Gut
- **Group-only-Architektur** ist langfristig richtig — kein 1:1-Provisorium das später migriert werden müsste.
- **Per-Object-DEK + Group-Master** skaliert bei Member-Add/Remove über große Group-Bestände — Body bleibt immer eingefroren.
- **AAD-v2 ohne Owner-ID** macht Owner-Transfer + Cross-Group-Share zukunftsfähig ohne Body-Re-Encrypt.
- **Eine-TX-Member-Remove** ist crash-recovery-trivial (Postgres rollbackt alles).
- **Lazy-Migration** kostet nichts solange ein Object nie geteilt wird — Family-Modus zahlt 0 Migration-Last.

### Schlecht / Risiken
- **Mixed-State-Schema** während der Übergangszeit (`owner_hkdf` und `per_object` Objects parallel). Code-Pfade müssen dispatched werden, Tests brauchen beide Pfade.
- **Group-Master-Cache (5min TTL) im Process-Memory** ist ein PII-Vektor wenn der Worker kompromittiert ist. Mitigation = kurze TTL + Cache-Invalidate bei Member-Remove. Bleibt im Threat-Modell als "kompromittierter Worker sieht plaintext Bodies zur Call-Zeit" — kein neuer Vektor, gleicher Vektor wie heute.
- **KMS-Call-Volumen** steigt: 1× pro Group-Master-Cache-Miss. Bei 100 Groups × 1 Cache-Miss / 5min = 1200 KMS-Calls/Stunde — unkritisch.
- **Forward-Secrecy ist Erwartungsmanagement**, nicht Crypto-Garantie. Muss klar kommuniziert werden.
- **Cross-Group-Cross-Compromise:** wenn dasselbe Object in Group-X und Group-Y geteilt ist und Group-X-Master leakt, ist das Object auch in Group-Y kompromittiert (Object-DEK identisch). By-design, nicht durch AAD verhinderbar.
- **Hard-Cap 1000 Grants/Group** für Phase 1 — bei Corporate-Scale (>1000 Skills in einer Marketing-Group) muss in Phase 2 ein async Re-Wrap-Worker gebaut werden.

### Follow-up-Decisions
- **Phase 2:** Write/Co-Edit für non-Owner, Email-Invite-Workflow, Group-Owner-Transfer
- **Phase 3:** Crypto-Shredding (echtes "Vergessen"), Group-Nesting, async Re-Wrap-Worker
- **Phase 4+:** Cross-Instance-Federation, Per-User-Master-Keys

## Pros and Cons of the Options

### Sharing-Granularität

**A — Hybrid (User-Grants + Group-Grants)**
- + flexibel
- − doppelte Code-Pfade (User vs Group)
- − Tool-Surface unnötig komplex

**B — Group-only ✅**
- + klare Mengen-Operationen
- + Tool-Surface stark typisiert
- + 1:1 als auto-generierte ad-hoc-Group hat dieselbe UX
- − keine direkte 1:1-Tool-Variante

**C — Nur 1:1**
- + minimaler Schema-Aufwand
- − skaliert nicht für Firma-Use-Case
- − muss später refactored werden

### Body-Encryption-Pattern

**A — Wrap-per-Recipient**
- + einfach für 1:1
- − Member-Remove-Kosten: `O(remaining × objects)` Wraps + Re-Encrypts
- − Skaliert nicht bei größeren Bundles

**B — Group-Master-Key ✅**
- + Member-Remove-Kosten `O(remaining)` Wraps, Body bleibt
- + Add-Member ist 1 Wrap
- + Pro-Object-DEK random → kein cross-user-derivable
- − 3 Decrypt-Operationen pro Read (member-kek → group-master → object-dek)
- − Group-Master-Cache braucht TTL-Management

**C — Proxy-Re-Encryption**
- + theoretisch optimal (Server sieht nie Plaintext-DEK)
- − exotische Crypto (Sahai-Waters etc.) — Library-Auswahl, Performance, Audit
- − ~2-3 Wochen Build vs ~1 Tag für B

**D — E2E-Hand-off via PWA**
- + Server sieht nie Plaintext-Body
- − Owner muss online sein wenn Share initiiert wird
- − UX-Killer auf Mobile

### AAD-Pattern

**A — `objects|<owner_id>|<object_id>` (Status quo)**
- + bestehend
- − bricht bei Owner-Transfer
- − redundant bei Per-Object-DEK (DEK ist objektspezifisch)

**B — `objects-v2|<object_id>` ✅**
- + Owner-Transfer ohne Re-Encrypt
- + Cross-Group-Share ohne Re-Encrypt
- + Replay-Schutz durch Object-ID-Binding
- − neuer RecordType nötig, Domain-Separation per `dek_scheme`
- − Tests müssen beide Pfade abdecken

**C — `objects|<group_id>|<object_id>`**
- − bricht bei Cross-Group-Share: gleiches Object in 2 Groups → 2 verschiedene AADs → 2 verschiedene Object-DEKs → Re-Encrypt pro Group
- − inkompatibel mit Per-Object-DEK-Architektur

### Member-Remove-Atomicity

**A — Eine TX mit `FOR UPDATE` auf groups.id ✅**
- + Postgres rollbackt alles bei Crash
- + Re-Wraps sind Memory-Ops nach 1× KMS-Wrap
- + Lock-Window <100ms für realistic Sizes
- − bei >1000 Grants: Lock-Window steigt → Hard-Cap MAX_GRANTS_PER_GROUP=1000

**B — Multi-Step async Worker**
- + skaliert für sehr große Groups
- − Recovery-Complexity (inkonsistente States)
- − Worker-Failure-Modes (was wenn Worker crashed mid-rotation)
- − im Phase-1-Scope nicht nötig

**C — Optimistic Locking ohne TX**
- − Race-Conditions zwischen Re-Wraps
- − keine garantierte Atomicity

## Cross-References

- [ADR-0014 — Sharing-Logik im Storage-Service](0014-sharing-logic-in-storage-service.md): Sharing lebt in KC2, nicht in approval2.
- [ADR-0016 — Docs/Skills/Apps teilbar, Credentials nicht](0016-shareable-docs-skills-apps.md): definiert was teilbar ist; ADR-0024 sagt wie.
- [ADR-0017 — Admin hat keinen User-Daten-Zugriff](0017-admin-no-user-data-access.md): bleibt valide — Admin sieht weiterhin nicht Bodies anderer User. Group-Membership ist eigener Trust-Pfad, kein Admin-Bypass.
- [ADR-0022 — Portable Adapter-Layer](0022-portable-adapter-layer.md): Group-Master-Wrap nutzt KMS-Adapter, Provider-Switch via Env-Var.
- [ADR-0023 — Shared Codebase, Isolated Environments](0023-shared-codebase-isolated-environments.md): Phase-1-Group-Sharing wird im Family-Modus deployed (mit feature-flag-default-off) aber primär für Self-Host + Corporate gebaut.
- [THREAT-MODEL.md](../../THREAT-MODEL.md): Trilemma E2EE × Search × Sharing bleibt — Phase 1 wählt "Sharing erlaubt, Search auf Plaintext-Title/Description weiterhin möglich, Body-Encryption mit Operator-Trust".
- [PLAN-sharing-group-phase-1.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/plans/active/PLAN-sharing-group-phase-1.md) (cross-repo): konkreter Build-Plan mit Schema-Migration + Code-Pfaden.
