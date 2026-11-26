---
title: "Launch Checklist"
quip_id: "LAUNCHlist01"
quip_url: "https://acme.quip.com/LAUNCHlist01"
quip_type: "document"
created: "2026-02-20T09:00:00.000Z"
updated: "2026-03-03T11:00:00.000Z"
author: "Jane Doe"
folder: "Private/Projects/Website Relaunch"
embeds:
  - "countdown"
exported: "2026-03-06T09:30:00.000Z"
exporter: "Quipendo 0.1.0"
---

# Launch Checklist

Everything that has to be true before the domain points at the new site. Questions go to **Jane Doe**; DNS access is with **Carlos Mendes**. Part of the [Project Plan](Website%20Relaunch%20-%20Project%20Plan.md).

**Countdown**

Launch day

Tuesday 14 April 2026

39 days to go

## Before launch

- Content
  - [x] Copy approved by the client
  - [x] Photos licensed
  - [ ] Alt text on every image
- Technical
  - [x] Redirect map reviewed
  - [ ] Load test at 5x normal traffic
  - [ ] Backups verified
- People
  - [x] Support team briefed
  - [ ] Out-of-hours contact list sent

## Launch day

1. Freeze content in the CMS.
2. Run `make deploy ENV=production`.
3. Switch DNS to the new site (the TTL is 300 s).
4. Check the **top 20 pages** and the checkout.
5. Tell the client at **10:00**.

## After launch

- Review the analytics on 2026-04-21.
- Retire the old server by 2026-05-14.
- Run the retrospective: [Retro: Sprint 12](../../../Team%20Shared/Meeting%20Notes/Retro%20-%20Sprint%2012.md).
