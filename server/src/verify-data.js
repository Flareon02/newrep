import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import { config } from './config.js';

async function walk(dir,out=[]){
  let entries;
  try{entries=await fs.readdir(dir,{withFileTypes:true});}
  catch(error){if(error.code==='ENOENT')return out;throw error;}
  for(const entry of entries){
    const target=path.join(dir,entry.name);
    if(entry.isDirectory())await walk(target,out);
    else if(entry.isFile()&&(entry.name.endsWith('.json')||entry.name.endsWith('.json.bak')))out.push(target);
  }
  return out;
}
async function parse(file){return JSON.parse(await fs.readFile(file,'utf8'));}

const root=path.resolve(config.dataDir),files=await walk(root),primary=new Set(files.filter(f=>f.endsWith('.json'))),backups=new Set(files.filter(f=>f.endsWith('.json.bak'))),keys=new Set([...primary,...[...backups].map(f=>f.slice(0,-4))]);
let valid=0,recoverable=0,backupOnly=0;const errors=[];
for(const file of [...keys].sort()){
  const backup=file+'.bak';
  try{await parse(file);valid++;continue;}catch(primaryError){
    try{await parse(backup);recoverable++;if(!primary.has(file))backupOnly++;console.error(`[data-check] recoverable: ${path.relative(root,file)} -> .bak`);}
    catch(backupError){
      if(primary.has(file)||backups.has(backup))errors.push({file:path.relative(root,file),primary:primaryError.message,backup:backupError.message});
    }
  }
}
let sqlite=null;const dbFile=path.join(root,'monitor-v2.sqlite3');
try{
  await fs.access(dbFile);
  let db;try{
    db=new DatabaseSync(dbFile,{readOnly:true});const row=db.prepare('PRAGMA quick_check').get(),check=String(Object.values(row||{})[0]||'');const version=db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value||null;
    sqlite={present:true,ok:check.toLowerCase()==='ok',quickCheck:check,schemaVersion:version};if(!sqlite.ok)errors.push({file:'monitor-v2.sqlite3',sqlite:check||'quick_check failed'});
  }finally{try{db?.close();}catch{}}
}catch(error){if(error?.code!=='ENOENT'){sqlite={present:true,ok:false,error:error.message};errors.push({file:'monitor-v2.sqlite3',sqlite:error.message});}else sqlite={present:false,ok:true};}
const result={ok:errors.length===0,root,jsonFiles:keys.size,valid,recoverable,backupOnly,sqlite,errors};
console.log(JSON.stringify(result));
if(errors.length)process.exitCode=2;
