# Memory Usage Badges

GNOME Shell extension that displays RAM usage badges on app icons in the Dash and Overview.

## Screenshots

### Low Memory Usage
![Low memory usage example](screenshots/Low-memory-usage.png)

### High Memory Usage
![Heavy app memory usage](screenshots/app-heavy.png)

## Features

- Shows memory usage as compact badges above app icons
- Aggregates memory across all related processes using cgroup detection
- Color-coded: black for normal usage, red for high memory (≥ 2 GB)
- Updates every 2.5 seconds
- Minimal performance overhead

## Compatibility

GNOME Shell 47+

Note: Extension shows badges on all app icons created with AppDisplay.AppIcon, including Dash, Overview app grid, and search results.

## Installation

```bash
cd ~/.local/share/gnome-shell/extensions/
cp -r /path/to/overview-app-memory@gnome-shell-extensions .
```

Then restart GNOME Shell:
- X11: `Alt+F2`, type `r`, press Enter
- Wayland: Log out and log back in

Enable the extension:
```bash
gnome-extensions enable overview-app-memory@gnome-shell-extensions
```

## Technical Details

### Memory Calculation

Uses PSS (Proportional Set Size) when available, falls back to VmRSS. Aggregates across all related processes by:
- Matching cgroup paths
- Matching executable paths
- Following parent process hierarchy

### Implementation

Monkey-patches `AppDisplay.AppIcon._init` to inject `St.Label` badges. Memory updates run via `GLib.timeout_add` at 2.5 second intervals. Proper cleanup on disable removes all injected UI elements and restores original AppIcon behavior.

## Troubleshooting

Check logs for errors:
```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Verify extension is enabled:
```bash
gnome-extensions list --enabled | grep overview-app-memory
```

## License

MIT
