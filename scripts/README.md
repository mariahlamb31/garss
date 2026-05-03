# Scripts

## Sync EditREADME From Subscriptions

Run from the repository root:

```bash
node scripts/sync-editreadme-from-subscriptions.mjs
```

This is a shortcut for:

```bash
node garss-studio/scripts/sync-subscriptions-to-editreadme.mjs
```

Behavior:

- Reads `garss-studio/storage/subscriptions.json`
- Skips all subscriptions whose `id` starts with `rsshub-doc-`
- Writes the remaining normal subscriptions into the RSS table in `EditREADME.md`
- Preserves existing table rows when possible
- Converts `https://rsshub.v2fy.com` style RSSHub URLs to `http://rsshub:1200`

Preview without writing:

```bash
node scripts/sync-editreadme-from-subscriptions.mjs --dry-run
```
