# 0025 — Desktop stays on Tauri; phones and tablets get native apps

Status: Accepted
Date: 2026-11-20

## Context

In November 2026 the shell was ported to NSH, a cross-platform native shell, as a test
(branch `port/nsh`, baseline 1.0.15, now archived as tag `archive/port-nsh`). The port
ran, but NSH had no tray, no self-update and no single-instance support. It still needed
a run on every operating system, and every platform keeps problems of its own.

With the host as the only owner of state ([0014](0014-three-layers-single-owner.md)), a
UI shell only renders host snapshots and sends commands. Agents make a shell cheap to
write for each platform, so one cross-platform layer saves little. What it costs is the
compromises it makes to fit every platform.

## Decision

- Windows, macOS and Linux keep the Tauri shell.
- iPhone, iPad and similar devices get native apps. They are designed for how those
  devices are used, not ported from the desktop UI.
- Every app is a client of the host's `/v1` HTTP and SSE contract
  ([`../design/host-layer.md`](../design/host-layer.md)). The host stays free of layout.
- Each app is checked on its own platform against the same host contract.
- NSH is not used.

## Does not mean

- No mobile app is scheduled; this only fixes the direction when one is built.
- The desktop UI ([`../design/ui-layer.md`](../design/ui-layer.md)) is not the mobile
  design. A mobile app has its own UI document.
- Web and remote access stay one browser client ([0021](0021-web-and-remote-are-one-client.md));
  a native app does not replace it.
- The desktop shell does not move off Tauri while Tauri is enough for the three systems.
