import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { GitExecutor } from '../../src/git/executor';
import { GitOps } from '../../src/git/operations';
let root: string;
const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'intelligit-blame-'));
 git('init','-q');git('config','user.name','Alice');git('config','user.email','alice@example.invalid');git('config','commit.gpgsign','false');
 await writeFile(join(root,'file.go'),'package main\nfunc answer() int {\n return 1\n}\n');
 git('add','.');git('-c','core.hooksPath=/dev/null','commit','-qm','initial');
});
afterEach(()=>rm(root,{recursive:true,force:true}));
it('blames the unsaved snapshot with shifted lines without touching the working file or index',async()=>{
 const before=await readFile(join(root,'file.go'),'utf8'); const tree=git('write-tree');
 const result=await new GitOps(new GitExecutor(root)).getBlame('file.go',{contents:'// inserted\n'+before.replace('return 1','return 2')});
 expect(result[0].isUncommitted).toBe(true);
 expect(result[2]).toMatchObject({line:2,author:'Alice',authorEmail:'alice@example.invalid'});
 expect(result[3].isUncommitted).toBe(true);
 expect(await readFile(join(root,'file.go'),'utf8')).toBe(before);expect(git('write-tree')).toBe(tree);
});
it('rejects an already cancelled request and untracked files',async()=>{
 const ops=new GitOps(new GitExecutor(root)); const abort=new AbortController(); abort.abort();
 await expect(ops.getBlame('file.go',{contents:'',signal:abort.signal})).rejects.toThrow();
 await expect(ops.getBlame('new.go',{contents:'package main'})).rejects.toThrow();
});
