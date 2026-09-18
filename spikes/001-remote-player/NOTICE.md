# Third-party notices and provenance

`src/vendor/frontend/{transport,signaling,crypto-utils,webrtc-transport}.ts` are
unmodified copies from Music Assistant frontend 2.17.297, commit
`e779b9d359e47cd210c2801f16a0ce6263571903`:
https://github.com/music-assistant/frontend/tree/e779b9d359e47cd210c2801f16a0ce6263571903/src/plugins/remote

They remain under the upstream Apache License 2.0, retained at
`src/vendor/frontend/LICENSE`. The surrounding plugin's MIT license does not
replace the license of these files. See upstream for authorship/history.

The npm package `@sendspin/sendspin-js` 5.0.0 is the official Sendspin browser SDK.
Its dependency licenses are retained in installed packages; browser build output
retains esbuild's generated legal notices where applicable. Build artifacts and
node_modules are not committed.

Integration reference (not copied):
https://github.com/music-assistant/frontend/blob/e779b9d359e47cd210c2801f16a0ce6263571903/src/plugins/sendspin-connection.ts
https://github.com/music-assistant/frontend/blob/e779b9d359e47cd210c2801f16a0ce6263571903/src/components/SendspinPlayer.vue

This experiment does not claim to be an official Music Assistant client.
