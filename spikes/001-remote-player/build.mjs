import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/main.ts'],outfile:'dist/spike.js',bundle:true,format:'iife',platform:'browser',target:['chrome120'],drop:['console'],sourcemap:false});
await copyFile('index.html','dist/index.html');
