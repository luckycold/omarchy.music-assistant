import {build} from 'esbuild';import {mkdir,copyFile,readdir,readFile,writeFile} from 'node:fs/promises';
await mkdir('dist/licenses',{recursive:true});
await build({entryPoints:['src/browser.ts'],outfile:'dist/browser.js',bundle:true,format:'iife',platform:'browser',target:['chrome120'],drop:['console'],legalComments:'linked',sourcemap:false});
await build({entryPoints:['src/daemon.ts'],outfile:'dist/daemon.mjs',bundle:true,format:'esm',platform:'node',target:['node22'],banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"},external:['bufferutil','utf-8-validate'],sourcemap:false});
await copyFile('src/vendor/frontend/LICENSE','dist/licenses/frontend-APACHE-2.0');
for(const pkg of ['@sendspin/sendspin-js','@scure/base','@noble/curves','@noble/hashes','@noble/ciphers','ws','libflacjs','opus-encdec']){
 try{for(const name of await readdir(`node_modules/${pkg}`)){if(/^(license|copying)/i.test(name))await copyFile(`node_modules/${pkg}/${name}`,`dist/licenses/${pkg.replaceAll('/','_')}-${name}`);}}catch{}
}
