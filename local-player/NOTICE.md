# Third-party notices

Vendored `src/vendor/frontend/` modules are from Music Assistant frontend
2.17.297, commit `e779b9d359e47cd210c2801f16a0ce6263571903`:
https://github.com/music-assistant/frontend/tree/e779b9d359e47cd210c2801f16a0ce6263571903/src/plugins/remote
Apache-2.0 license retained at `src/vendor/frontend/LICENSE`.
Local changes: removed unused HTTP proxy support, explicit ICE transport policy,
sanitized selected-candidate counters,
disabled inner signaling reconnect (the session supervisor owns retry),
connection-generation cancellation guards and connection-wait teardown, and bounded
chunk reassembly (validated metadata/base64, 8 MiB aggregate decoded-byte budget,
32 groups, 1024 chunks per group, 30-second expiry with teardown cleanup).

SDK `@sendspin/sendspin-js` is pinned to 5.0.0. npm package licenses are retained
in node_modules; build copies dependency license files to dist/licenses and
preserves esbuild legal comments. The installer includes these notices/licenses.

This is not an official Music Assistant client.
