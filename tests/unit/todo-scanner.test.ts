import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { findTodos, scanTodos, TODO_FILE_LIMIT } from '../../src/services/todo/scanner';
import { GitExecutor } from '../../src/git/executor';

describe('TODO comment parsing',()=>{
 it('finds inline and multiline comments, preserving UTF-16 coordinates and skipping strings',()=>{
  const text='package demo\nconst a = "TODO: not a comment"\nconst raw = `\n// TODO: not a comment either\n`\nvar a = 1 // TODO: 上线检查\n/*\n FIXME: 修复\n*/\n// TODOOne is not a tag\n';
  expect(findTodos(text,'model.go')).toEqual([
   {line:5,column:13,endColumn:23,tag:'TODO',text:'TODO: 上线检查'},
   {line:7,column:1,endColumn:10,tag:'FIXME',text:'FIXME: 修复'},
  ]);
 });
 it('supports common comment styles without mistaking string contents for TODOs',()=>{
  expect(findTodos('x = "# TODO" # TODO: yes\n"""\n# FIXME: no\n"""','a.py').map(x=>x.text)).toEqual(['TODO: yes']);
  expect(findTodos('<!-- TODO: fix -->\n<div title="TODO: no">','a.html').map(x=>x.text)).toEqual(['TODO: fix']);
  expect(findTodos("select 'TODO'; -- FIXME: query",'a.sql').map(x=>x.text)).toEqual(['FIXME: query']);
  expect(findTodos('{"TODO":"no"}','a.json')).toEqual([]);
 });

});
let root:string;
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'intelligit-todos-'));
 execFileSync('git',['init','-q'],{cwd:root});
});
afterEach(()=>rm(root,{recursive:true,force:true}));
it('respects Git ignore, excludes bulky folders, uses unsaved snapshots and bounds large files',async()=>{
 await writeFile(join(root,'.gitignore'),'ignored.go\n');
 await writeFile(join(root,'ignored.go'),'// TODO: ignored');
 await writeFile(join(root,'main.go'),'// TODO: disk');
 await mkdir(join(root,'vendor'));await writeFile(join(root,'vendor','a.go'),'// TODO: vendor');
 await writeFile(join(root,'large.go'),'// TODO: huge\n'+'x'.repeat(TODO_FILE_LIMIT));
 const result=await scanTodos(root,new GitExecutor(root),new Map([['main.go','// FIXME: unsaved']]),new AbortController().signal);
 expect(result.files.map(x=>x.path)).toEqual(['main.go']);
 expect(result.files[0].matches[0].text).toBe('FIXME: unsaved');
 expect(result.limited).toBe(false);
});
it('filters the scope before scanning and does not follow symlinks outside the project',async()=>{
 await writeFile(join(root,'a.go'),'// TODO: A');await mkdir(join(root,'sub'));await writeFile(join(root,'sub','b.go'),'// TODO: B');
 const outside=await mkdtemp(join(tmpdir(),'intelligit-outside-'));
 try{
  await writeFile(join(outside,'outside.go'),'// TODO: outside');await symlink(join(outside,'outside.go'),join(root,'link.go'));
  const all=await scanTodos(root,new GitExecutor(root),new Map(),new AbortController().signal);
  expect(all.files.map(x=>x.path)).toEqual(['a.go','sub/b.go']);
  const scoped=await scanTodos(root,new GitExecutor(root),new Map(),new AbortController().signal,p=>p.startsWith('sub/'));
  expect(scoped.files.map(x=>x.path)).toEqual(['sub/b.go']);
 }finally{await rm(outside,{recursive:true,force:true});}
});

it('includes Godot, template comments and lowercase markers like GoLand', () => {
 expect(findTodos('# todo: generated client\nvar x="TODO: string"','client.gd').map(m=>m.text)).toEqual(['todo: generated client']);
 expect(findTodos('{{!--\nTODO: template parent\n--}}\n{{! fixme: description }}\n# TODO: generated code','model.handlebars').map(m=>m.tag)).toEqual(['TODO','FIXME','TODO']);
 expect(findTodos('const x = `escaped \\` // TODO: string`;\n// todo: actual','file.js').map(m=>m.text)).toEqual(['todo: actual']);
});

it('streams files above the old size limit, keeps chunk boundaries and allows cancellation', async () => {
 const {readTodoPreview}=await import('../../src/services/todo/scanner');
 const prefix='// padding\n'.repeat(110000);
 await writeFile(join(root,'large.js'),prefix+'/*\nTODO: large source\n*/\n');
 let ticks=0;const timer=setInterval(()=>ticks++,1);
 try{
  const result=await scanTodos(root,new GitExecutor(root),new Map(),new AbortController().signal);
  expect(result.files[0].matches[0]).toMatchObject({line:110001,text:'TODO: large source'});
  expect(result.skipped).toEqual([]);expect(ticks).toBeGreaterThan(0);
  expect(await readTodoPreview(root,'large.js',110000,110002)).toEqual(['/*','TODO: large source','*/']);
  const abort=new AbortController();setTimeout(()=>abort.abort(),5);
  const cancelled=await scanTodos(root,new GitExecutor(root),new Map(),abort.signal).catch(()=>({files:[]}));
  expect(cancelled.files).toEqual([]);
 }finally{clearInterval(timer);}
});

it('reports oversized inputs instead of silently returning an incomplete count',async()=>{
 await writeFile(join(root,'giant.go'),'x'.repeat(17*1024*1024));
 await writeFile(join(root,'long.go'),'// TODO: '+'x'.repeat(600*1024));
 const result=await scanTodos(root,new GitExecutor(root),new Map(),new AbortController().signal);
 expect(result.files).toEqual([]);
 expect(result.skipped).toEqual(expect.arrayContaining([
  {path:'giant.go',reason:'文件超过 16 MiB'},
  {path:'long.go',reason:'单行超过 512 KiB'},
 ]));
});
