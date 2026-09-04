# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Dormouse serves people who juggle concurrent terminal work: coding agents, builds, development servers, scripts, and interactive tools. Its primary audience spans terminal beginners—including non-developers using a coding agent for the first time—to tmux power users who already have strong keyboard habits.

Users work mainly inside VS Code or one of its forks, or in the standalone desktop app. They may move away from the computer while work continues and need to know what requires attention, then continue a live terminal session from their phone.

## Product Purpose

Dormouse is a mouse-friendly multitasking terminal for VS Code and the desktop. It keeps many concurrent sessions visible and manageable, makes unattended work report when it needs the user, and lets the user resume a running terminal from Dormouse Pocket.

Success means a user can start and organize concurrent work, leave without monitoring idle output, notice the right completion or request at a glance or through a phone notification, and return directly to the relevant session.

## Positioning

Dormouse combines a real tiling terminal layout, tmux-compatible keyboard control, first-class mouse interaction, and an attention model built around terminal protocols, command completion, and watched-command quiet. Minimized sessions remain present as status-bearing Doors instead of disappearing into tabs.

The same Session can be operated locally in VS Code or the standalone app and continued from a phone through Pocket. Agent-drivable browser panes share the local tiling environment with the terminals that serve them, so people and coding agents act in the same visible workspace.

## Operating Context

- VS Code is the primary desktop host; the Tauri standalone app is the secondary host and supports macOS, Windows, and Linux.
- The browser playground runs the real interface with a fake terminal adapter so people can learn Dormouse without installing it.
- Every Dormouse-launched terminal has the `dor` CLI on its `PATH`, allowing users, scripts, and coding agents to inspect and operate surfaces.
- Dormouse Pocket is an installable web app. A user pairs it explicitly with a Host, selects a running terminal pane, sees it live, and sends terminal input.
- Pocket remote control requires the user's computer to remain awake and online and requires a coordinating server. The server can be self-hosted; a managed Dormouse Hosted option is planned.

## Capabilities and Constraints

- Users can split, resize, swap, zoom, minimize, reattach, and close panes with the mouse, Dormouse shortcuts, or tmux-compatible shortcuts.
- Alerts originate from standard terminal notification protocols, unattended command exits, or an opt-in rule that notices when a named command becomes quiet. An alert becomes a durable TODO until the user clears it.
- Opt-in spoken alarms can announce an unattended pane locally. Push notifications can reach a paired phone while Pocket is backgrounded or closed.
- Pocket protocol v1 lists terminal panes and attaches to one terminal at a time for live output, input, and resizing. It does not remotely mutate the desktop layout or attach to browser surfaces.
- Browser panes can sit beside terminal panes and can be driven through an existing `agent-browser` installation; Dormouse does not bundle a browser.
- Local terminal use requires no server. Remote access is authorized by the Host after explicit pairing; terminal traffic is end-to-end encrypted through the coordinating server.
- Terminals and their processes remain on the user's computer. Pocket and Hosted do not move or run those sessions in the cloud.
- The coordinating server is available for self-hosting under FSL-1.1-MIT and free for internal use. Managed hosting and ElevenLabs voice are planned paid conveniences; pricing and launch dates are undecided.

## Brand Commitments

The product name is **Dormouse**. Its personality is **Focused. Approachable. Capable.** It should communicate “everything is under control”: no clutter or intimidation, without sacrificing depth for expert users.

The product welcomes mouse users, touch users, and hotkey experts without treating one input style as less legitimate. Inside VS Code, the product must feel native to the host and respect the user's chosen theme. It rejects generic SaaS ornament, hacker clichés, bloated desktop chrome, and playfulness that competes with the work.

## Evidence on Hand

- `website/src/pages/Home.tsx` contains the public product narrative, download paths, and working feature demonstrations.
- `website/src/pages/PlaygroundDesktop.tsx` and `website/src/components/PocketTerminalExperience.tsx` provide interactive desktop and phone demonstrations.
- `website/src/assets/` contains product videos, the Dormouse identity assets, and a Pocket phone mockup. `website/public/og-image.jpg` is the public social image.
- `vscode-ext/README.md` is the canonical public product guide, and `docs/specs/` records the implemented behavior and security boundaries.
- Published distribution links exist for the Visual Studio Marketplace, Open VSX, and standalone release downloads.
- The public security specification, audit contract, supply-chain inventory, self-host guide, changelog, and generated CLI reference are available through the website.

No testimonials, customer logos, adoption metrics, performance benchmarks, pricing, or launch dates are on hand. Future product work must not fabricate them.

## Product Principles

1. **Wake the user only when needed.** Work may run unattended; Dormouse should surface the session that needs attention without demanding continuous monitoring.
2. **Make power approachable.** Mouse, touch, and progressive disclosure make the terminal usable immediately while tmux-compatible controls preserve expert speed.
3. **Keep status attached to the work.** Attention, TODO, identity, and continuity survive minimize, host boundaries, and the move from computer to phone.
4. **Share one operational model.** VS Code, standalone, the playground, automation, and Pocket should expose the same underlying Sessions and terminology within each surface's capabilities.
5. **Keep control with the user.** Local use has no server dependency; remote access is explicit, Host-authorized, end-to-end encrypted, and leaves terminal processes on the user's computer.

## Accessibility & Inclusion

Core workflows must support mouse and keyboard use, and Pocket must provide touch-sized controls. Important status cannot rely on color alone. Motion must respect reduced-motion preferences, layouts must tolerate zoom and narrow viewports, and theme integration must remain legible across light, dark, and high-contrast environments.
