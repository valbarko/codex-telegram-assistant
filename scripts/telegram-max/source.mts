/** A dedicated read-only bot session; never starts a second Bot API poller. */
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {open, mkdir, readFile, readdir, rename, copyFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {configure, createClient} from 'tdl';
import {getTdjson} from 'prebuilt-tdlib';
import {readConfiguration} from '../../src/configuration.ts';
import {loadTelegramReaderCredentials} from '../../src/telegram-reader-keychain.ts';

const run = promisify(execFile);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function primary(content: any): any {
  if (content._ === 'messagePhoto') {
    const size = [...content.photo.sizes].sort((a:any,b:any) => b.width*b.height-a.width*a.height)[0];
    return {file: size.photo, type: 'image', name: '.jpg'};
  }
  const types: Record<string, string[]> = {
    messageVideo:['video','video','video','.mp4'], messageVideoNote:['video_note','video','video','.mp4'],
    messageAnimation:['animation','animation','video','.mp4'], messageAudio:['audio','audio','audio','.mp3'],
    messageVoiceNote:['voice_note','voice','audio','.ogg'], messageDocument:['document','document','file','.bin'],
  };
  const type = types[content._];
  if (!type) return undefined;
  return {file: content[type[0]][type[1]], type: type[2], name: content[type[0]].file_name || type[3]};
}

export function sourceVersion(message: any): string {
  const content = message.content;
  const media = primary(content);
  const poll = content.poll;
  return hash({type: content._, edited_at:message.edit_date||0, album: String(message.media_album_id || '0'),
    formatted: content.text || content.caption || null,
    media: media ? {type: media.type, unique: media.file.remote?.unique_id,
      size: media.file.size, name: media.name} : null,
    poll: poll ? {question: poll.question, options: poll.options.map((o:any) => o.text), type: poll.type} : null});
}

export async function atomic(file: string, value: unknown): Promise<void> {
  const temporary = file + '.tmp';
  const stream = await open(temporary, 'w', 0o600);
  try {await stream.writeFile(JSON.stringify(value)); await stream.sync();} finally {await stream.close();}
  await rename(temporary, file);
  const directory = await open(path.dirname(file), 'r');
  try {await directory.sync();} finally {await directory.close();}
}

async function json(file: string, fallback?: any): Promise<any> {
  try {return JSON.parse(await readFile(file, 'utf8'));} catch (error:any) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function serve(root: string, once = false): Promise<void> {
  process.umask(0o077);
  const cfg = readConfiguration();
  const settings = await json(path.join(root, 'settings.json'));
  if (settings.source_chat !== -1002359399843 || settings.max_chat !== -70978688537928
      || settings.delay_seconds < 3600 || settings.interval_seconds < 3600) throw Error('Invalid policy');
  if (settings.owner_id && !cfg.allowedUsers.has(settings.owner_id)) throw Error('Unexpected alert owner');
  await mkdir(path.join(root,'inbox'), {recursive:true,mode:0o700});
  await mkdir(path.join(root,'media'), {recursive:true,mode:0o700});
  const credentials = await loadTelegramReaderCredentials();
  if (!credentials) throw Error('Bot transport credentials unavailable');
  configure({tdjson:getTdjson(),verbosityLevel:0});
  const session = path.join(root, 'source-bot');
  await mkdir(session,{recursive:true,mode:0o700});
  const client = createClient({apiId:credentials.apiId,apiHash:credentials.apiHash,
    databaseDirectory:path.join(session,'tdlib'),filesDirectory:path.join(session,'files'),
    databaseEncryptionKey:credentials.databaseEncryptionKey,skipOldUpdates:false,
    tdlibParameters:{use_message_database:false,use_chat_info_database:false,
      use_file_database:false,use_secret_chats:false}});
  let ready = false, stopping = false, connectionReady = false;
  let disconnectedAt = Date.now(), needsCatchup = false;
  let operations = Promise.resolve();
  let work: Promise<void> | undefined;
  let lastAlert = '';
  let validationError = false;

  const ingest = async (message:any): Promise<void> => {
    if (message.chat_id !== settings.source_chat || message.id / 1048576 <= settings.baseline_id) return;
    if (/^messageChat|^messageSupergroup|^messagePinMessage$/u.test(message.content._)) return;
    const ident = message.id / 1048576;
    if (!Number.isSafeInteger(ident)) throw Error('Unexpected source identifier');
    const file = path.join(root, 'inbox', ident + '.json');
    const previous = await json(file);
    const version = sourceVersion(message);
    const changed = previous?.version !== version || previous?.deleted;
    const now = Date.now()/1000;
    const value = {source_chat:settings.source_chat,id:ident,td_id:message.id,
      date:message.date,edit_date:message.edit_date,media_album_id:message.media_album_id,
      content:message.content,reply_to:message.reply_to,version,deleted:false,
      quiet_since: changed ? Math.max(now,message.date,message.edit_date||0) : previous.quiet_since,
      observed_at:previous?.observed_at || now,validated_at:now,
      ...(previous?.media_version === version ? {media:previous.media,media_version:version} : {})};
    await atomic(file,value);
  };

  const enqueue = (action: () => Promise<void>): void => {
    operations = operations.then(action).catch(async () => {
      ready = false; validationError = true;
      await atomic(path.join(root,'source-ready.json'),{at:Date.now()/1000,ready:false,source_chat:settings.source_chat});
      console.error('Source processing failed; public writes blocked');
    });
  };
  client.on('error', () => {ready=false; connectionReady=false; console.error('Source connection unavailable');});
  client.on('update', (update:any) => {
    if (update._ === 'updateConnectionState') {
      connectionReady = update.state._ === 'connectionStateReady';
      if (!connectionReady && !disconnectedAt) disconnectedAt=Date.now();
      if (connectionReady && disconnectedAt) {
        if (Date.now()-disconnectedAt>5*60_000) needsCatchup=true;
        disconnectedAt=0;
      }
      if (!connectionReady) enqueue(async()=>{
        await atomic(path.join(root,'source-ready.json'),{at:Date.now()/1000,ready:false,source_chat:settings.source_chat});
      });
    }
    if (update._ === 'updateNewMessage') enqueue(() => ingest(update.message));
    if (['updateMessageContent','updateMessageEdited'].includes(update._) && update.chat_id === settings.source_chat) {
      enqueue(async () => {
        const message = await client.invoke({_: 'getMessage',chat_id:settings.source_chat,message_id:update.message_id});
        await ingest(message);
      });
    }
    if (update._ === 'updateDeleteMessages' && update.chat_id === settings.source_chat && update.is_permanent) {
      enqueue(async () => {
        for (const id of update.message_ids) {
          const file=path.join(root,'inbox',id/1048576+'.json');
          const row=await json(file);
          if (row) await atomic(file,{...row,deleted:true,quiet_since:Date.now()/1000,validated_at:Date.now()/1000});
        }
      });
    }
  });
  const stop = (): void => {stopping=true; ready=false;};
  process.on('SIGTERM',stop); process.on('SIGINT',stop);
  try {
    await client.loginAsBot(cfg.telegramToken);
    const me = await client.invoke({_: 'getMe'});
    if (me.id !== settings.source_bot_id) throw Error('Unexpected source bot');
    const chat = await client.invoke({_: 'searchPublicChat',username:'valbarkoclub'});
    if (chat.id !== settings.source_chat) throw Error('Unexpected source channel');
    const member:any = await client.invoke({_: 'getChatMember',chat_id:chat.id,
      member_id:{_: 'messageSenderUser',user_id:me.id}});
    if (member.status._ !== 'chatMemberStatusAdministrator' || member.status.rights.can_post_messages) {
      throw Error('Source bot must have read-only administrator access');
    }
    const recover = async (): Promise<any> => {
      ready=false;
      await atomic(path.join(root,'source-ready.json'),{at:Date.now()/1000,ready:false,source_chat:settings.source_chat});
      // Recover authoritative history after restarts and long sleep/offline
      // periods, including gaps beyond Bot API update retention.
      await run(path.resolve(import.meta.dirname,'../../node_modules/.bin/tsx'),
        [path.join(import.meta.dirname,'catchup.mts'),root],{cwd:path.resolve(import.meta.dirname,'../..'),timeout:100_000,maxBuffer:64*1024});
      const recovered=await json(path.join(root,'catchup.json'));
      if (!recovered.complete || recovered.source_chat!==settings.source_chat) throw Error('Incomplete source catch-up');
      // TDLib numeric file IDs belong to their own session.
      for (const message of recovered.messages) enqueue(async()=>{
        const current:any=await client.invoke({_: 'getMessage',chat_id:chat.id,message_id:message.id});
        if (sourceVersion(current)!==sourceVersion(message) && current.edit_date<=message.edit_date) {
          throw Error('Source versions disagree; restart with an empty message cache');
        }
        await ingest(current);
      });
      await operations;
      ready=true;needsCatchup=false;
      return recovered;
    };
    let caught=await recover();
    ready = true;
    console.log('Source bot connected; authoritative catch-up complete');
    let lastCheck = 0;
    while (!stopping) {
      if (validationError) throw Error('Source processing failed');
      if (Date.now()-lastCheck >= 25_000) {
        if (needsCatchup || (lastCheck && Date.now()-lastCheck>5*60_000)) {
          // A fresh process also discards the bot's in-memory message cache.
          // The next authoritative catch-up must not be overwritten by old
          // cached content after an extended offline period.
          throw Error('Restart required after a long source gap');
        }
        lastCheck = Date.now();
        // Read the current version of every queued/publication message. This
        // also renews the short freshness lease while a worker uploads media.
        const files = (await readdir(path.join(root,'inbox'))).filter(f=>/^\d+\.json$/u.test(f));
        for (const file of files) {
          const row=await json(path.join(root,'inbox',file));
          if (row.deleted) continue;
          try {
            const message = await client.invoke({_: 'getMessage',chat_id:chat.id,message_id:row.td_id});
            enqueue(()=>ingest(message));
          } catch (error:any) {
            if (error.message !== 'Message not found') throw error;
            enqueue(async()=>{
              const latest=await json(path.join(root,'inbox',file));
              await atomic(path.join(root,'inbox',file),{...latest,deleted:true,quiet_since:Date.now()/1000,validated_at:Date.now()/1000});
            });
          }
        }
        await operations;
        for (const file of files) {
          const row=await json(path.join(root,'inbox',file));
          if (row.deleted || row.media_version===row.version || Date.now()/1000<row.quiet_since+settings.delay_seconds) continue;
          const item=primary(row.content);
          if (!item) continue;
          const downloaded:any=await client.invoke({_: 'downloadFile',file_id:item.file.id,priority:1,offset:0,limit:0,synchronous:true});
          if (!downloaded.local?.is_downloading_completed) throw Error('Source download incomplete');
          const extension=path.extname(item.name)||(item.name.startsWith('.')?item.name:'.bin');
          if (!/^\.[\p{L}\p{N}]{1,12}$/u.test(extension)) throw Error('Unsupported file extension');
          const relative=path.join('media',row.id+'-'+row.version.slice(0,16)+extension.toLowerCase());
          const destination=path.join(root,relative);
          await copyFile(downloaded.local.path,destination);
          const bytes=(await stat(destination)).size;
          if (item.file.size && bytes!==item.file.size) throw Error('Source media size mismatch');
          const media={path:relative,type:item.type,bytes,original_name:item.name,
            source_type:row.content._,sha256:createHash('sha256').update(await readFile(destination)).digest('hex')};
          enqueue(async()=>{
            const latest=await json(path.join(root,'inbox',file));
            if (latest.version===row.version && !latest.deleted) {
              await atomic(path.join(root,'inbox',file),{...latest,media,media_version:row.version});
            }
          });
        }
        await client.invoke({_: 'getMe'});
        const membership:any=await client.invoke({_: 'getChatMember',chat_id:chat.id,
          member_id:{_: 'messageSenderUser',user_id:me.id}});
        if (membership.status._!=='chatMemberStatusAdministrator' || membership.status.rights.can_post_messages) {
          throw Error('Source membership changed');
        }
        await operations;
        await atomic(path.join(root,'source-ready.json'),{at:Date.now()/1000,ready:ready&&connectionReady,
          source_chat:chat.id,bot_id:me.id,watched:files.length,catchup_at:caught.at});
        if (!work && connectionReady) {
          work=(async()=>{
            const response=await run(settings.python || '/opt/homebrew/bin/python3',
              [path.join(import.meta.dirname,'worker.py'),'--root',root],{timeout:20*60_000,maxBuffer:64*1024});
            const health=JSON.parse(response.stdout.trim());
            if (health.status === 'blocked') {
              const alert=hash(health);
              if (alert!==lastAlert && settings.owner_id) {
                // Owner-only operational alert. Never echo provider errors,
                // post text, tokens, or signed upload locations.
                const text='Автоперенос Telegram → Max остановлен на проверке. Очередь сохранена; повторная отправка заблокирована, чтобы не создать дубль. Проверить нужно журнал переноса на Mac.';
                const api=await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`,
                  {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:settings.owner_id,text})});
                const result:any=await api.json();
                if (result.ok) lastAlert=alert;
              }
            } else lastAlert='';
          })().catch(()=>console.error('Worker unavailable; durable queue retained')).finally(()=>{work=undefined;});
        }
      }
      if (once) {await work;break;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  } finally {
    ready=false;
    await atomic(path.join(root,'source-ready.json'),{at:Date.now()/1000,ready:false,source_chat:settings.source_chat});
    await operations;
    if (work) await work;
    await client.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const root=process.argv[2];
  if (!root) {console.error('Private state directory required');process.exitCode=1;}
  else await serve(path.resolve(root),process.argv.includes('--once')).catch(async()=>{
    console.error('Telegram → MAX source stopped safely; launchd will retry');process.exitCode=1;
    try {
      const cfg=readConfiguration();
      const settings=await json(path.join(root,'settings.json'));
      const previous=await json(path.join(root,'source-alert.json'),{});
      if (!settings.enabled || !cfg.allowedUsers.has(settings.owner_id)
          || Date.now()-(previous.at||0)<6*60*60_000) return;
      const text='Автоперенос Telegram → Max приостановлен: не удалось проверить исходный канал. Очередь сохранена. Напиши «проверь автоперенос», чтобы разобраться с причиной.';
      const response=await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`,
        {method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10_000),
          body:JSON.stringify({chat_id:settings.owner_id,text})});
      const result:any=await response.json();
      if (result.ok) await atomic(path.join(root,'source-alert.json'),{at:Date.now()});
    } catch { /* No provider errors, tokens or request URLs enter logs. */ }
  });
}
