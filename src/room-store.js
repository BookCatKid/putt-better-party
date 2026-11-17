import {Database} from 'bun:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {Room} from './room.js';

export class RoomStore {
 constructor(filename){
  if(filename!==':memory:'){mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});}
  this.db=new Database(filename,{create:true});
  if(filename!==':memory:')chmodSync(filename,0o600);
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS rooms(code TEXT PRIMARY KEY, updated INTEGER NOT NULL, payload TEXT NOT NULL)');
  this.put=this.db.prepare('INSERT INTO rooms VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET updated=excluded.updated,payload=excluded.payload');
  this.del=this.db.prepare('DELETE FROM rooms WHERE code=?');
 }
 save(room){this.put.run(room.code,room.lastActivity,JSON.stringify(room.checkpoint()))}
 remove(code){this.del.run(code)}
 load(catalog,options={},now=Date.now()){
  this.db.query('DELETE FROM rooms WHERE updated<?').run(now-1800000);
  const rooms=new Map();
  for(const row of this.db.query('SELECT payload FROM rooms').all()){
   try{
    const data=JSON.parse(row.payload);
    if(data.version!==1)continue;
    const room=new Room(data.code,catalog,{...options,onChange:r=>this.save(r)});
    room.restore(data);
    rooms.set(room.code,room);
    this.save(room);
   }catch(e){console.error('Could not recover a stored room:',e.message)}
  }
  return rooms;
 }
 close(){this.db.close()}
}
