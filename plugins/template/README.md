# Plugin template

`@openplans/plugin-template` is a small working plugin to copy when you start your own. It reads
no data, reaches no host and adds no tables. It registers one of each common kind:

| Kind           | Registration                                                                     |
| -------------- | -------------------------------------------------------------------------------- |
| Public route   | `GET /template/hello?name=Ada` answers `{"greeting":"hello, Ada"}`, cached 60 s  |
| MCP tool       | `template_hello`, the same greeting, read-only                                   |
| Worker command | `worker template hello` counts its runs in the plugin's `ctx.state`              |
| Event handler  | a non-durable `snapshot.activated` handler that logs the source id               |

The option `greeting` changes the first word. It takes 1 to 40 characters and defaults to
`hello`. A `name` must be letters, spaces or hyphens, up to 40 characters. Anything else gets a
400 from the route and an error envelope from the tool.

Turn it on with:

```sh
OPENPLANS_PLUGINS=@openplans/plugin-template
```

`tests/template.test.ts` uses the test kit in `src/plugins/testing/` and the core's worker and
MCP code. It checks the manifest, each registration, the route, the tool, the handler and a
worker run against PGlite, and plants one mutant, a wrong route path, to prove the route check
fails.

The [plugin guide](../../docs/plugins.md#start-from-the-template) walks through copying and
renaming it. Run its tests from the OpenPlans root:

```sh
npm run build:plugins
npx vitest run plugins/template
```
