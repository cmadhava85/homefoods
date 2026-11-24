# Incidents

**Audience:** on-call / ops  
**Companion:** [RUNBOOK.md](./RUNBOOK.md) (playbooks) · [OPS_READINESS.md](./OPS_READINESS.md) · [OBSERVABILITY.md](./OBSERVABILITY.md)

How we declare, staff, communicate, and learn from production incidents. Under pressure start with [Declare an incident](#declare-an-incident), then the matching playbook in [RUNBOOK.md §6](./RUNBOOK.md#6-incident-playbooks).

---

## Severity matrix

| Sev | When | Examples | Response target | Comms |
|-----|------|----------|-----------------|-------|
| **SEV1** | Ordering or payments down **during a service window** (lunch ~11:30–14:00 IST or dinner ~20:30–22:00 IST), or data loss / money at risk | Checkout 5xx, Payment Links fail, schema drift breaking `/kitchens` / `/me/*`, DB unreachable | Ack **≤ 5 min**; mitigate or kill-switch **≤ 15 min**; customer/cook WA within **30 min** | Investigating → Mitigated → Resolved (+ refund notice if owed) |
| **SEV2** | Core path degraded but not fully down; notifications or settlement broken; outage **outside** service window | WhatsApp silent, outbox backlog, EOD / Scheduler miss, Route/settlement stuck, elevated 5xx with partial success | Ack **≤ 30 min**; mitigate **≤ 2 h**; status note if customers are waiting | Investigating → Mitigated → Resolved as needed |
| **SEV3** | Cosmetic, non-blocking, or single-user | UI glitch, wrong copy, one kitchen photo 404, non-critical Admin polish | Next business day; track as GitHub issue | Optional; no blast WA |

Escalate **up** a severity if the lunch/dinner window opens while the issue is still open, or if money/trust is at risk.

---

## On-call roster

Fill names/phones when a second maintainer exists. Hours cover the lunch and dinner service windows (IST).

| Role | Person | Mobile / WhatsApp | Coverage |
|------|--------|-------------------|----------|
| **Primary** | `[NAME]` | `[+91-…]` | Mon–Sun **07:30–14:00** and **20:30–22:00** IST |
| **Backup** | `[NAME]` | `[+91-…]` | Same windows; takes over if primary does not ack within target |
| **Escalation (owner)** | `@cmadhava85` | `[+91-…]` | Always; product + deploy authority |

Primary owns ack, severity call, kill-switches, and customer/cook comms. Backup pages if primary misses the ack target. Outside coverage windows, SEV1 still pages primary → backup → owner.

---

## Declare an incident

1. **Pick severity** using the matrix above (default SEV1 if unsure during a service window).
2. **Open a GitHub issue** with the [Incident template](../.github/ISSUE_TEMPLATE/incident.yml); labels `incident` + `sev1` / `sev2` / `sev3`.
3. **Ack in the issue** (who owns it, start time IST/UTC).
4. **Stabilize first** — Admin feature flags / Mark paid / pause cook / Cloud Run previous revision — see [RUNBOOK.md §12](./RUNBOOK.md#12-escalation-order).
5. **Vendor check** if external (table below).
6. **Customer/cook WA** with the templates below when users are blocked.
7. **Resolve** — restore service, confirm smoke, post Resolved (+ Refund if owed).
8. **Postmortem** within **3 business days** for SEV1 (and SEV2 if recurring); append under [Incident log](#incident-log).

---

## Vendor escalation

| Vendor | Use for | Portal / status | Support contact | Notes |
|--------|---------|-----------------|-----------------|-------|
| **Razorpay** | Payment Links, webhooks, refunds, Route | Dashboard · [status.razorpay.com](https://status.razorpay.com) | `[support ticket URL / email]` · phone `[…]` | Keep txn ids / Payment Link ids ready |
| **Meta (WhatsApp)** | Cloud API / WABA outbound & inbound | Meta Business Suite · [developers.facebook.com](https://developers.facebook.com) | `[Business Support case URL]` | Template / phone number id; check allowlist |
| **GCP** | Cloud Run, Cloud SQL, Logging, Scheduler | Cloud Console · [status.cloud.google.com](https://status.cloud.google.com) | Support plan: `[Basic / Standard / Enhanced — TBD]` · case `[…]` | Project id, revision, region `asia-south1` |
| **DNS / domain** | Apex, `api.`, TLS | Registrar: `[TBD]` · DNS: `[Cloud DNS / other]` | Registrar support `[…]` | TTL, cert expiry |

Update placeholders when vendor contracts or support plans change.

---

## WhatsApp comms templates

Send from the ops / support number. Keep lean; one message per stage. Replace bracketed fields.

### Investigating (SEV1 / customer-visible SEV2)

```text
LocalMeals: We're looking into an issue affecting [ordering / payments / notifications] since ~[HH:MM IST]. New orders may fail until we fix it. We'll update you here. Ref: [incident issue # / short id].
```

### Mitigated

```text
LocalMeals: The [ordering / payments / notifications] issue is mitigated. You can try again now. If something still fails, reply with your order id (LM-…) or phone. Ref: [#].
```

### Resolved

```text
LocalMeals: The issue from [date ~HH:MM IST] is resolved. Sorry for the trouble — thank you for your patience. Ref: [#].
```

### Refund notice

```text
LocalMeals: We've issued a refund of ₹[amount] for order [LM-…]. It should appear in [1–5 / 5–7] business days depending on your bank. Questions? Reply here. Ref: [#].
```

### Cook desk (investigating / mitigated)

```text
LocalMeals cook desk: Platform issue affecting [accept paid / go LIVE / settlements] since ~[HH:MM IST]. [Investigating / Mitigated — please retry]. We'll confirm when fully clear. Ref: [#].
```

---

## Branch protection (`main`) — manual

GitHub Settings → Branches → Branch protection rule for `main` (do this in the UI; not in Terraform yet):

1. **Require a pull request** before merging (no direct pushes).
2. **Require status checks to pass** — at least the CI workflow that gates deploy (`ci` / required jobs from `.github/workflows/ci.yml`).
3. **Require conversation resolution** before merge (recommended).
4. **Require review from Code Owners** — enable once a **second maintainer** exists (today [CODEOWNERS](../.github/CODEOWNERS) is a single owner; requiring owners with only one person creates a bus-factor lock).
5. Do **not** allow force pushes or deletions on `main`.
6. Restrict who can push / dismiss reviews to maintainers.

Until a second maintainer is onboarded: keep PR + CI required; treat CODEOWNERS as advisory review requests only.

---

## GitHub labels

Create these labels in the repo (Issues → Labels) if missing:

| Label | Color suggestion | Use |
|-------|------------------|-----|
| `incident` | `#B60205` | All production incidents |
| `sev1` | `#D93F0B` | SEV1 |
| `sev2` | `#FBCA04` | SEV2 |
| `sev3` | `#0E8A16` | SEV3 |
| `recurring` | `#5319E7` | Same class of failure seen before — track systemic fix |

Use the [Incident issue template](../.github/ISSUE_TEMPLATE/incident.yml) so sev labels are offered at open time.

---

## Postmortem template

Copy into a new section under [Incident log](#incident-log) after SEV1 (and notable SEV2).

```markdown
### YYYY-MM-DD — [short title] (SEV#)

| | |
|---|---|
| **Duration** | start → end (UTC + IST) |
| **Impact** | who / what broke |
| **Detect** | how we found out |
| **Owners** | primary / contributors |

#### Timeline (UTC)

| Time | Event |
|------|-------|
| … | … |

#### Root cause

…

#### Detection gap

…

#### What went well

- …

#### What went poorly

- …

#### Action items

| Action | Links to | Owner | Done |
|--------|----------|-------|------|
| … | OPS P0-x / issue # | … | [ ] |
```

---

## Incident log

### 2026-11-23 — Schema drift after manual API deploy (SEV1)

| | |
|---|---|
| **Duration** | Errors **06:29–06:48 UTC** (~12:00–12:18 IST); revision live from **06:01 UTC** |
| **Impact** | Browse/order broken: `/kitchens*` and `/me/*` returned failures during lunch window (customers could not list kitchens or load “my” data) |
| **Detect** | Reactive — errors observed in logs / user path; **no** paging (alerting not configured) |
| **Owners** | Solo ops |

#### Timeline (UTC)

| Time | Event |
|------|-------|
| **06:01** | Cloud Run revision **`localmeals-api-00032`** created (manual deploy; pipeline deploys that day had failed — migrate job + candidate smoke skipped) |
| **06:01–06:28** | New code serving against DB schema missing columns expected by the revision |
| **06:29** | Errors begin on **`/kitchens`** and **`/me/*`** (e.g. `column "late_orders_enabled" does not exist`, surfaced as client 400s) |
| **06:29–06:48** | Lunch-window outage ~19 minutes |
| **06:48** | Errors stop (schema/code brought back in sync — migration and/or rollback) |

#### Root cause

Manual Cloud Run deploy shipped API code **ahead of** the database migration. Expand-only migration policy assumes the pipeline migrate job runs before traffic; that path was bypassed.

#### Detection gap

No production alerting (uptime / 5xx / log metrics). Faults were classified as **400** without server logs/stacks, so even a 5xx-based alert would have missed them. See [OPS_READINESS.md](./OPS_READINESS.md) **P0-2**, **P0-3**.

#### What went well

- Issue was contained to ~19 minutes of error burst once visible.
- Root cause identifiable from revision create time vs pipeline history.

#### What went poorly

- Deploy outside the pipeline skipped migrations and smoke.
- No on-call page; lunch traffic hit a broken browse path.
- User-facing errors looked like bad requests, hiding the outage from ops heuristics.

#### Action items

| Action | Links to | Owner | Done |
|--------|----------|-------|------|
| Configure alert channels + uptime/5xx policies; test-fire | [OPS P0-2](./OPS_READINESS.md#p0-2--no-alerting-exists-in-production) | Ops | [ ] |
| Unclassified errors → 500 + log stack; generic client message + `requestId` | [OPS P0-3](./OPS_READINESS.md#p0-3--server-faults-become-400s-are-not-logged-and-leak-internals) | Eng | [ ] |
| Restrict deploy to pipeline SA; fail readiness when migrations lag code; remove manual-migration instructions | [OPS P1-4](./OPS_READINESS.md#p1-4--manual-deploy-bypassed-migrations-root-cause-of-23-nov-outage) | Eng / Ops | [ ] |
| Named on-call + this incident process | [OPS P1-10](./OPS_READINESS.md#p1-10--ownership-on-call-escalation-incident-process) | Ops | [x] |
