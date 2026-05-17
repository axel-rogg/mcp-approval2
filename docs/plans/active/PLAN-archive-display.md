## PLAN-archive-display — Archiv-Anzeige optimieren analog v1

⚠️ **Status: Draft + Evaluiert** (2026-05-17)

### Symptom

Archive-Liste in `#/approvals?view=archive` zeigt jeden Eintrag mit:
- inline-styled DIV
- voll-langer (nicht-truncated) `displayRendered`-String inkl. `=== Label ===`-Marker
- Status-Badge inline rechts

Resultat: pro Archive-Eintrag 4-8 Zeilen senkrechter Platz, Mono-Klasse fehlt,
keine Konsistenz mit Pending-Cards.

### Wie v1 (mcp-approval) das löst

**Ein gemeinsames Card-Schema** für Pending + Archive, nur unterschiedliche
Sub-Modifier:

```
.approval-card           — base (block link, border, padding, hover-effect)
.approval-card.pending   — border-left accent
.approval-card.history   — transparent bg, tighter padding
.approval-card.st-approved  — green ✓-icon color
.approval-card.st-rejected  — red ✗-icon color
.approval-card.st-expired   — gray ⌛-icon color
```

**Card-Aufbau** (beide Modi, 2 Zeilen):

| | row1 (baseline-flex) | row2 (mono, 1-line, ellipsis) |
|---|---|---|
| pending | tool-name · ttl (rechts) | shortDisplay (1-line) |
| history | st-icon ✓✗⌛ · tool-name · decided-at (rechts) | shortDisplay (1-line) |

**shortDisplay()** (existiert in `approval-quick.ts:53`):
- Nimmt `displayRendered`
- Strippt `=== Label ===`-Marker
- Collapsed Whitespace zu Single-Space
- Fallback: Input-Field-Names

**Detail-View** (auf Klick) macht `parseSections()` + collapsible long bodies
in `<details>` (existiert in `approval-sections.ts`).

### Gap-Analyse v2 aktuell

| Element | Pending-Card | Archive-Card (aktuell) | Soll |
|---|---|---|---|
| CSS-Klasse `approval-card` | ✅ | ❌ inline-styles | ✅ |
| `shortDisplay()`-Truncate | ✅ | ❌ voller Display-String | ✅ |
| `mono`-Klasse fuer row2 | ✅ | ❌ | ✅ |
| Status-Icon | n/a | ❌ (nur Badge-Pill) | ✅ (✓✗⌛) |
| Decided-Time rechts in row1 | n/a | ❌ (in row2 vermischt) | ✅ |
| CSS-Klasse `history` | n/a | ❌ | ✅ |
| CSS-Klasse `st-{status}` | n/a | ❌ | ✅ |
| WYSIWYS-konform (canonical string) | ✅ | ✅ (display-rendered, aber unsauber gerendert) | ✅ |

### Sinnvolle Optionen

#### **Option A — 1:1 v1-Port der history-Card** *(empfohlen)*

- Archive-Card nutzt `<a class="approval-card history st-{status}">` + bestehende v1-CSS
- row1: ✓/✗/⌛-Icon · tool-name · decided-at (rechts)
- row2: `mono` + ellipsis, output von `shortDisplay()`
- Klick führt zu Detail-View (existing, schon read-only fuer non-pending)
- **Aufwand**: ~20 min (PWA-only, CSS gibt's schon teilweise)
- **Vorteil**: identische Optik zu Pending-Cards, konsistente UX, kompakt (2 Zeilen)
- **Nachteil**: muss bei kleinem screen evtl. tool-name-overflow gut handeln

#### **Option B — A + Filter-Pills oben**

- Wie A
- Plus: oben drei Filter-Pills `Alle (N) · ✓ Approved (n) · ✗ Rejected (n) · ⌛ Expired (n)`
- Klick filtert clientseitig (kein neuer Server-Call, Items sind eh schon da)
- **Aufwand**: +15 min
- **Vorteil**: schnelles Schalten auf einen Status-Filter
- **Nachteil**: zusätzliche UX-Schicht; bei <10 Items overkill

#### **Option C — Inline-Sections in der Liste**

- Jede Archive-Card öffnet sich automatisch (kein Klick) als full sectioned view
- Wie Detail-View aber kompakter (sec-card-compact aus v1)
- **Aufwand**: ~40 min
- **Vorteil**: kein Klick nötig
- **Nachteil**: bei 50+ Items kilometer-lange Seite, scroll-heavy

#### **Option D — Suche/Filter-Input + Option A**

- Wie A
- Plus Volltext-Filter-Input über `tool_name` + `displayRendered`
- **Aufwand**: +30 min
- **Vorteil**: Bei viel Archive-Traffic finden via tippen
- **Nachteil**: Suchterm-Highlighting, fuzzy-vs-substring-Entscheidung

### Empfehlung

**Option A umsetzen jetzt** — kleinster Patch, größter Lesbarkeits-Gewinn,
konsistent mit Pending-Cards. v1 ist seit Monaten in Production damit — die
UX ist erprobt.

Option B (Filter-Pills) kann später kommen wenn ein Tester sagt "ich will
nur die expired sehen". Option D wenn ein Tester sagt "ich finde meinen
gestrigen call nicht". Option C verwerfen — zu viel Vertikal-Klau.

### Slice-Aufteilung Option A

| # | Datei | Änderung | Aufwand |
|---|---|---|---|
| 1 | `apps/web/src/approval-quick.ts` | `shortDisplay()` exportieren (currently inline) | 1 min |
| 2 | `apps/web/src/approval.ts` | `renderArchiveCard()` umschreiben mit v1-CSS-Klassen + shortDisplay | 10 min |
| 3 | `apps/web/src/styles.css` (oder wo immer die approval-card-CSS lebt) | sicherstellen dass `.approval-card.history.st-{status}`-Klassen styled sind; fehlende ergaenzen | 5-10 min |
| 4 | Build + visuell verifizieren | hard-refresh, archive ansehen | 5 min |

**Total**: ~25-30 min, einer Commit.

### Akzeptanzkriterien

- [ ] Archive-Card ist 2 Zeilen hoch (kompakt wie v1)
- [ ] Status-Icon vorne in row1 (✓ grün / ✗ rot / ⌛ grau)
- [ ] Decided-Time rechts in row1 (heute = HH:MM, sonst Tag.Monat HH:MM)
- [ ] Display-String in row2, mono, ellipsis bei überlauf, `===`-Marker entfernt
- [ ] Klick führt zur (bestehenden) read-only Detail-View
- [ ] Hover wechselt border-color analog Pending-Cards
