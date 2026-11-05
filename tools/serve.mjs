import http from 'node:http';
import {existsSync} from 'node:fs';
import {readFile,realpath,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createEditor} from './editor.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const mounts={'/ymir/':path.resolve(root),'/trinity/':path.resolve(root,'node_modules/trinity')};
const types={
  '.html':'text/html',
  '.js':'text/javascript',
  '.mjs':'text/javascript',
  '.cjs':'text/javascript',
  '.json':'application/json',
  '.bin':'application/octet-stream',
  '.vert':'text/plain',
  '.frag':'text/plain',
  '.glsl':'text/plain',
  '.css':'text/css',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg',
  '.svg':'image/svg+xml',
  '.ico':'image/x-icon'
};
export function createAssetServer({libraryRoot=root}={}){
  const editor=createEditor(libraryRoot);
  const resolvedLib=path.resolve(libraryRoot);
  const resolvedRoot=path.resolve(root);
  const publicMounts={...mounts,'/ymir/':resolvedLib};
  return http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost');
      if(await editor(req,res,url))return;
      if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
      let pathname=decodeURIComponent(url.pathname);
      if(pathname==='/'){res.writeHead(302,{location:'/ymir/browser/'});res.end();return;}
      if(pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
      const prefix=Object.keys(publicMounts).find(p=>pathname.startsWith(p));
      if(!prefix){res.writeHead(404);res.end('Not found');return;}
      const base=await realpath(publicMounts[prefix]);
      let file=path.resolve(base,pathname.slice(prefix.length));
      if(file!==base&&!file.startsWith(base+path.sep))throw new Error('Outside asset root');
      // Never expose git internals, hidden files, or symlink escapes.
      if(path.relative(base,file).split(path.sep).some(s=>s.startsWith('.')))throw new Error('Hidden file');
      let targetFile;
      try{
        let f=file;
        if((await stat(f)).isDirectory())f=path.join(f,'index.html');
        f=await realpath(f);
        if(!f.startsWith(base+path.sep))throw new Error('Symlink escape');
        targetFile=f;
      }catch(err){
        if(prefix==='/ymir/'&&resolvedLib!==resolvedRoot){
          const fallbackBase=await realpath(resolvedRoot);
          let fb=path.resolve(fallbackBase,pathname.slice(prefix.length));
          if(fb!==fallbackBase&&!fb.startsWith(fallbackBase+path.sep))throw err;
          if(path.relative(fallbackBase,fb).split(path.sep).some(s=>s.startsWith('.')))throw err;
          if((await stat(fb)).isDirectory())fb=path.join(fb,'index.html');
          fb=await realpath(fb);
          if(!fb.startsWith(fallbackBase+path.sep))throw err;
          targetFile=fb;
        }else{
          throw err;
        }
      }
      res.writeHead(200,{'content-type':types[path.extname(targetFile)]??'application/octet-stream','cache-control':'no-store'});
      if(req.method==='HEAD'){res.end();return;}
      res.end(await readFile(targetFile));
    }catch{res.writeHead(404);res.end('Not found');}
  });
}
function parseArgs(args){
  const options={};
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--library'||arg==='-l'){
      options.library=args[++i];
    }else if(arg.startsWith('--library=')){
      options.library=arg.slice(10);
    }else if(arg==='--port'||arg==='-p'){
      options.port=Number(args[++i]);
    }else if(arg.startsWith('--port=')){
      options.port=Number(arg.slice(7));
    }else if(/^\d+$/.test(arg)){
      options.port=Number(arg);
    }
  }
  return options;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const cliArgs=parseArgs(process.argv.slice(2));
  const defaultShare=path.join(process.env.HOME??'','.local','share','ymir');
  const configuredLibrary=cliArgs.library??process.env.YMIR_LIBRARY;
  let libraryRoot;
  if(configuredLibrary){
    libraryRoot=path.resolve(configuredLibrary);
  }else if(existsSync(defaultShare)){
    libraryRoot=path.resolve(defaultShare);
  }else{
    libraryRoot=path.resolve(root);
  }
  const port=Number(cliArgs.port??process.env.PORT??4174);
  const server=createAssetServer({libraryRoot});
  server.listen(port,'127.0.0.1',()=>console.log(`Ymir browser: http://127.0.0.1:${server.address().port}/`));
}
