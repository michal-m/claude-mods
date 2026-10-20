# claude-mods

A collection of personal mods for Claude — tweaks to Claude's interface and behaviour such as status lines, panes, slash commands and hooks.

## Layout

Each mod lives in its own top-level folder and is self-contained:

```
claude-mods/
├── README.md
├── .claude-plugin/marketplace.json   # lists every mod, so the repo is a marketplace
└── <mod-name>/
    ├── README.md   # what it does, how to install, how to configure
    └── ...         # the mod's files
```

## Mods

| Mod | Description |
| --- | --- |
| [usage-bar](usage-bar/) | One band above the prompt: context, 5h/7d limits, prompt cache with a keep-alive button, usage credits, subagents. |

## Installing

```
/plugin marketplace add michal-m/claude-mods
/plugin install <mod-name>@claude-mods
/reload-plugins
```

## Adding a mod

1. Create a new folder named after the mod (kebab-case).
2. Add a `README.md` inside it describing what it does and how to install it.
3. Add it to `plugins` in `.claude-plugin/marketplace.json`.
4. Add a row to the table above.

## License

[Apache-2.0](LICENSE).
