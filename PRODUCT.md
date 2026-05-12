## Design Context

### Users
Developers ranging from terminal beginners (non-developers using Claude Code for the first time) to tmux power users. They're multitasking across multiple terminal sessions and need to know when background tasks finish without watching idle screens. Context: working inside VSCode (primary) or a standalone terminal app (secondary).

### Brand Personality
**Focused. Approachable. Capable.**

MouseTerm should feel like focused efficiency that cares about beginners and onboarding, without sacrificing anything that even the most extreme power user might want eventually. The interface should communicate: "everything is under control" — no clutter, no distraction, just the information you need when you need it.

### Aesthetic Direction

**Primary constraint: Feel native inside VSCode.** The current Catppuccin Mocha design is throwaway — built to get things running. The first design priority is making MouseTerm feel completely native within VSCode, respecting whatever theme the user has chosen. This means:
- Use VSCode's CSS variables and theme tokens, not hardcoded colors
- Match VSCode's spacing, typography, and interaction patterns
- Light mode and dark mode support from the start (inherited from user's VSCode theme)
- The webview should feel like a built-in VSCode feature, not a third-party panel

**After VSCode-native is achieved**, figure out the standalone terminal's visual identity separately.

**References:**
- VSCode itself — the gold standard for how MouseTerm should feel as an extension
- The tool should feel like a natural part of the editor, not a foreign embed

**Anti-references:**
- Generic SaaS (rounded cards, gradients, startup illustrations)
- Hacker aesthetic (green-on-black, Matrix vibes, intimidating to beginners)
- Electron bloat (Slack — heavy, slow-feeling, too much chrome)
- Overly playful (too many animations, emojis, mascots)

### Design Principles

1. **Native first** — Inside VSCode, MouseTerm should be indistinguishable from a built-in feature. Use the host's theme tokens, spacing, and conventions. Never fight the environment.

2. **Information density without intimidation** — Power users want dense layouts with many terminals visible. Beginners need to not feel overwhelmed. Solve this with progressive disclosure: simple by default, powerful when you explore.

3. **Status at a glance** — The core UX promise is "glance and know what's done." Status indicators must be scannable in under a second across many terminals. No reading required — use shape, color, and position.

4. **No chrome, all content** — Minimize UI chrome. Terminals are the content. Headers, tabs, and controls should be minimal and recede. Every pixel of chrome competes with terminal output.

5. **Theme-adaptive** — Never hardcode colors. Always derive from the host theme (VSCode variables, or a standalone theme system later). Support light and dark from day one.
