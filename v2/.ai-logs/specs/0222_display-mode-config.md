# Spec: Configurable Display Mode & Margin

## Current Issues

### 1. `noTmux` misnomer forces single-line
- `display-only.ts:606`: `noTmux = !paneWidth || paneWidth <= 0`
- Shell wrapper sets `STATUSLINE_WIDTH=$COLUMNS` even outside tmux
- So `noTmux` is rarely true — but the variable name is misleading
- **Real issue**: When Claude Code invokes `display-only.ts` directly (bypassing shell wrapper), `STATUSLINE_WIDTH` is unset → forced single-line

### 2. Margin wastes 25% on narrow terminals
```
width=80 → margin=20 → effective=60 (25% wasted!)
width=100 → margin=15 → effective=85
width=120 → margin=18 → effective=102
```
The 25% margin for ≤80 was designed for tmux right-side overlays. Outside tmux, this margin is entirely wasted.

### 3. No user control over display mode
- Can't force multi-line in non-tmux terminal
- Can't adjust margin for different layouts
- Can't disable margin entirely when not using tmux overlays

## Proposed Config Extension

Add to `~/.claude/session-health/config.json`:

```
{
  "components": { ... existing ... },
  "display": {
    "mode": "auto",        // "auto" | "multiline" | "singleline"
    "marginPercent": null,  // null=auto, 0=no margin, 5-25=custom
    "maxLines": 6           // max output lines (existing MAX_LINES)
  }
}
```

### Mode Behavior
| Mode | Behavior |
|------|----------|
| `auto` (default) | Current logic: multi-line if STATUSLINE_WIDTH>30, single-line otherwise |
| `multiline` | Always multi-line. Width = STATUSLINE_WIDTH or COLUMNS or 120 fallback |
| `singleline` | Always single-line (max 240 chars) |

### Margin Behavior
| marginPercent | Behavior |
|---------------|----------|
| `null` (default) | Current auto logic (25% for ≤80, min(25,15%) for >80) |
| `0` | No margin — use full width (best for non-tmux terminals) |
| `5-25` | Fixed percentage margin |

## Changes

### `display-only.ts`
1. Extend `ComponentsConfig` → new `DisplayConfig` interface
2. Read `display` section from config
3. Replace `noTmux` logic with mode-aware selection
4. Pass `marginPercent` to formatter

### `statusline-formatter.ts`
1. `formatForWidth(health, width, marginPercent?)` — accept optional margin override
2. `formatAllVariants(health, marginPercent?)` — pass through

### Shell wrapper (`statusline-bulletproof.sh`)
- Already correct — sets `STATUSLINE_WIDTH=$COLUMNS` outside tmux
- No changes needed

## Migration
- All new fields are optional with backward-compatible defaults
- Existing config files continue working unchanged
