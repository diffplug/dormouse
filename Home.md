# Dormouse

So many terminals.
Which ones need attention?
A *dormouse* knows when to wake.

Multitasking terminal for mice (and hotkey wizards too)

## Soft as a mouse, sharp as a tmux

Upgrade your VS Code or native terminal with a flexible multipane layout. Minimize the tasks you're not watching to a compact status indicator.

Do it all with the mouse, or keep your hands on the keyboard with tmux keybinds.

## Stop watching terminals spin

Dormouse tracks activity the same way you do — visual motion. When a pane stops changing for two seconds, it marks the task complete and alerts you.

Works with any CLI tool that prints to a terminal — no plugins, no configuration. Also supports `BEL` and `OSC 9/99/777` for seamless integration with TUI-forward applications.

## Newlines and copy paste like you meant

You're used to doing `Shift+Enter` to get a newline in the browser, but it's broken in your terminal? Not anymore. Dormouse works the way a user would expect, no arcane terminal knowledge required!

Click and drag in a "mouse conformant" terminal doesn't select text; it sends escape code `\e[<0;x;yM`. And `Ctrl+C` doesn't copy; it asks your program to kill itself.

## Get Dormouse

A dormouse knows when to wake up. Multitasking terminal for mice.

[Try it in the Playground](/playground)

### VS Code Extension

Also works in Cursor, Windsurf, Antigravity, or any other VS Code fork.

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=diffplug.dormouse)
- [Open VSX Registry](https://open-vsx.org/extension/diffplug/dormouse)

### Standalone App

Don't settle for your operating system's built-in terminal, get a nice one!

- Mac Silicon
- Windows x64
- Linux x64
- [Other](https://github.com/diffplug/dormouse/issues/8)

#### Installing on Mac

1. Double-click the downloaded .tar.gz to extract Dormouse.app
2. Drag Dormouse.app to Applications

#### Installing on Windows

1. Double-click the downloaded Dormouse-windows-x64-setup.exe
2. If SmartScreen appears: More info → Run anyway

#### Installing on Linux

1. Make executable: `chmod +x Dormouse-linux-x86_64.AppImage`
2. Run from terminal or double-click to launch

## Walk away. Keep going.

Coming next: [Dormouse Pocket](/pocket). Tether a terminal session to your phone over WebRTC and take a stroll — the Dormouse alert system buzzes you if there's anything to do. A hosted auto-pairing service comes later, so you can just leave and keep working, no "I'm walking away" dance.

Open source and free to self-host, or pay us a little bit and you can use ours. We'll discount for early adopters, so don't miss out!

**Notify me when Pocket ships.** This signs you up for my personal devlog [nedshed.dev](https://nedshed.dev) on Substack. The next post will be the launch post, you can unsubscribe any time.

---

Built by [nedshed.dev](https://nedshed.dev) (the labs division of [DiffPlug LLC](https://diffplug.com)).

- [Dependencies](/dependencies)
- [Report an issue](https://github.com/diffplug/dormouse/issues)
