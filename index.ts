import { DurableObject } from 'cloudflare:workers';
import { MatrixBotDO, type BotMessage, type BotTimelineEvent } from '@ixo/matrix-bot-workers-sdk';

const BOT_INSTANCE_NAME = 'Matrix-Bot';
const REMINDER_INSTANCE_NAME = 'Reminders';
const INSPIRO_API_URL = 'https://inspirobot.me/api?generate=true';
const CATFACT_API_URL = 'https://catfact.ninja/fact';
const OPSEC_API_URL = 'https://opsec.usr40k.dev/';
const XKCD_URL = 'https://xkcd.com';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const BUNBUN_COUNT = 16;
const COOLDOWN_MS = 1_000;
const REMINDER_MAX_ATTEMPTS = 5;
const REMINDER_RETRY_MS = 10_000;
const MUTE_KEY_PREFIX = 'faith:muted:';
const OWN_DONE_PREFIX = 'faith:own-done:';
const OWN_COMMAND_MAX_AGE_MS = 60_000; // own commands older than this are replays (restart, backfill), not new

// the bot only works in these rooms, every other room is ignored and left out of /sync (see restrictSync).
// add room ids like '!abc123:matrix.anarchists.space' (element: room settings > advanced > internal room ID)
// and redeploy. an empty list means the bot is off everywhere
const ALLOWED_ROOMS = new Set<string>([
  // '!abc123:matrix.anarchists.space',
]);

const COMMAND_PREFIX = '!faith';
const KNOWN_COMMANDS = new Set([
  'help',
  'inspire',
  'catfact',
  'meow',
  'bark',
  'opsec',
  'remind',
  'bunbun',
  'coinflip',
  'rps',
  'xkcd',
]);

const REMIND_USAGE = `usage: ${COMMAND_PREFIX} remind <in 10 minutes | in 2 hours | in 3 days | 30/12/2026> <text...>`;
const REMIND_CLEAR_USAGE = `usage: ${COMMAND_PREFIX} remind clear [all]`;
const RPS_USAGE = `usage: ${COMMAND_PREFIX} rps <rock|paper|scissors>`;
const UNKNOWN_COMMAND = `unknown command, type ${COMMAND_PREFIX} for the command list`;

const HELP_COMMANDS = [
  ['inspire', 'random inspiring image'],
  ['catfact', 'random cat fact'],
  ['meow', 'random meow from 7w1 s MaaS'],
  ['bark', 'random bark from 7w1 s DaaS'],
  ['opsec', 'random opsec level'],
  [
    'remind <when> <text>',
    'post a reminder in this room\nwhen: in 10 minutes, in 2 hours, in 3 days or 30/12/2026 (same time of day)',
  ],
  ['bunbun', 'random bunbun image'],
  ['xkcd', 'random xkcd comic'],
  ['coinflip', 'flip a coin'],
  ['rps <rock|paper|scissors>', 'play rock paper scissors against the bot'],
  ['help', 'show this message'],
];

const HELP_INTRO = `all commands start with ${COMMAND_PREFIX}`;

// html clients get the table, the rest only see the intro (the event needs some body)
const HELP_HTML =
  `<p>${HELP_INTRO}</p><table><thead><tr><th>command</th><th>usage</th><th>what it does</th></tr></thead><tbody>` +
  HELP_COMMANDS.map(([usage, info]) => {
    const [name] = usage.split(' ');
    const full = escapeHtml(`${COMMAND_PREFIX} ${usage}`);
    const what = escapeHtml(info).replace(/\n/g, '<br>');
    return `<tr><td><code>${name}</code></td><td><code>${full}</code></td><td>${what}</td></tr>`;
  }).join('') +
  '</tbody></table>';

const RPS_CHOICES = ['rock', 'paper', 'scissors'];
const RPS_EMOJI = ['🪨', '📄', '✂️'];

// workers free plan: 50 subrequests per invocation. the sdk runs the whole /sync loop inside one
// keep-alive alarm (up to 5 min) and bills every fetch of the bot to it. once the budget is gone
// every fetch fails until that alarm ends. so count fetches and end the alarm's hold early: the
// alarm re-arms 1 s later with a fresh budget and the sync loop keeps running across the gap.
// subrequestPaths records which endpoints use the budget, it is logged on every rotation
const SUBREQUEST_ROTATE_AT = 35;
let subrequestCount = 0;
let subrequestPaths = new Map<string, number>();
let endAlarmHold: (() => void) | null = null;

// the sdk's /sync asks for every joined room. narrow its filter to ALLOWED_ROOMS so the homeserver
// never sends (and the bot never decrypts) events of other rooms. to-device events (room keys),
// account data and invites are not affected by the room filter and keep coming
function restrictSync(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/_matrix/client/v3/sync')) return url;

    const raw = parsed.searchParams.get('filter');
    if (!raw) return url;

    const filter = JSON.parse(raw) as { room?: { rooms?: string[] } };
    // the very first sync of an account already excludes every room to only get a token, leave it alone
    if (Array.isArray(filter.room?.rooms) && filter.room.rooms.length === 0) return url;

    filter.room = { ...filter.room, rooms: [...ALLOWED_ROOMS] };
    parsed.searchParams.set('filter', JSON.stringify(filter));
    return parsed.href;
  } catch {
    return url;
  }
}

// the bot never sends read receipts, those requests are answered locally
const RECEIPT_PATH = /\/rooms\/[^/]+\/(?:receipt\/|read_markers)/;
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (RECEIPT_PATH.test(url)) return Promise.resolve(Response.json({}));

  // the sdk builds its /sync url as a string
  if (typeof input === 'string') {
    url = restrictSync(url);
    input = url;
  }

  let path = url;
  try {
    path = new URL(url).pathname.replace(/\/(?:[!$#][^/]+|[A-Za-z0-9_-]{20,})/g, '/:id');
  } catch {}
  subrequestPaths.set(path, (subrequestPaths.get(path) ?? 0) + 1);

  if (++subrequestCount >= SUBREQUEST_ROTATE_AT) endAlarmHold?.();
  return realFetch(input, init);
};

const lastUse = new Map<string, number>();
// room id -> is the room end-to-end encrypted (the bot only works in unencrypted rooms)
const encryptedRooms = new Map<string, boolean>();

interface ImageFile {
  bytes: Uint8Array;
  mimetype: string;
  filename: string;
  caption?: string; // sent after the image
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// one reply per room per second, shared by every command
function rateLimited(roomId: string): boolean {
  const now = Date.now();
  if (now - (lastUse.get(roomId) ?? 0) < COOLDOWN_MS) return true;
  lastUse.set(roomId, now);
  return false;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function downloadImage(url: string, fallbackMime: string, name: string): Promise<ImageFile> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`image too large: ${bytes.byteLength} bytes`);

  const mimetype = res.headers.get('content-type')?.split(';')[0].trim() || fallbackMime;
  return { bytes, mimetype, filename: `${name}.${mimetype.split('/')[1]}` };
}

async function fetchInspiroImage(): Promise<ImageFile> {
  const api = await fetch(INSPIRO_API_URL);
  if (!api.ok) throw new Error(`inspirobot request failed: HTTP ${api.status}`);

  const url = (await api.text()).trim();
  if (!url.startsWith('https://')) throw new Error(`unexpected inspirobot response: ${url.slice(0, 80)}`);
  return downloadImage(url, 'image/jpeg', 'inspirobot');
}

async function fetchBunbunImage(assets: Fetcher): Promise<ImageFile> {
  const filename = `bunbun-${Math.floor(Math.random() * BUNBUN_COUNT) + 1}.webp`;
  // host doesn't matter, the assets binding only looks at the path
  const res = await assets.fetch(`https://assets.local/${filename}`);
  if (!res.ok) throw new Error(`${filename} not found: HTTP ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mimetype: 'image/webp', filename };
}

async function fetchXkcdImage(): Promise<ImageFile> {
  const { num: latest } = await getJson<{ num: number }>(`${XKCD_URL}/info.0.json`);
  let num = Math.floor(Math.random() * latest) + 1;
  if (num === 404) num++; // there is no xkcd 404, that's the joke

  const comic = await getJson<{ safe_title: string; img?: string }>(`${XKCD_URL}/${num}/info.0.json`);
  if (!comic.img?.startsWith('https://')) throw new Error(`xkcd ${num} has no image`);

  const image = await downloadImage(comic.img, 'image/png', `xkcd-${num}`);
  return { ...image, caption: `xkcd #${num}: ${comic.safe_title}` };
}

async function fetchCatFact(): Promise<string> {
  try {
    const { fact } = await getJson<{ fact?: string }>(CATFACT_API_URL);
    if (!fact) throw new Error('empty response');
    return fact;
  } catch (error) {
    throw new Error(`could not get cat fact: ${errorMessage(error)}`);
  }
}

// the service answers with json: { seed, numericSeed, mode, result, results: [result] }
async function fetchOpsec(): Promise<string> {
  try {
    const { result, results } = await getJson<{ result?: string; results?: string[] }>(OPSEC_API_URL);
    const text = (result ?? results?.[0] ?? '').trim();
    if (!text) throw new Error('empty response');
    return text;
  } catch (error) {
    throw new Error(`opsec service failed: ${errorMessage(error)}`);
  }
}

// meow and bark services: GET <base>/<kind> -> { <kind>: string }
async function fetchPet(kind: 'meow' | 'bark', baseUrl?: string): Promise<string> {
  if (!baseUrl) throw new Error(`${kind.toUpperCase()}_BASE_URL is not set in wrangler.toml`);
  try {
    const data = await getJson<Record<string, string | undefined>>(`${baseUrl.replace(/\/+$/, '')}/${kind}`);
    if (!data[kind]) throw new Error('empty response');
    return data[kind];
  } catch (error) {
    throw new Error(`${kind} service failed: ${errorMessage(error)}`);
  }
}

function flipCoin(): string {
  return `🪙 ${Math.random() < 0.5 ? 'heads' : 'tails'}`;
}

// every choice beats the one before it in the list (rock wraps around to scissors)
function playRps(args: string[]): string {
  const player = RPS_CHOICES.indexOf((args[0] ?? '').toLowerCase());
  if (args.length !== 1 || player < 0) return RPS_USAGE;

  const bot = Math.floor(Math.random() * RPS_CHOICES.length);
  const result = ["it's a tie!", 'you win!', 'I win!'][(player - bot + 3) % 3];
  return `you: ${RPS_EMOJI[player]} ${RPS_CHOICES[player]} | me: ${RPS_EMOJI[bot]} ${RPS_CHOICES[bot]} - ${result}`;
}

const DAY_MS = 86_400_000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const RELATIVE = /^in (\d+) (minute|hour|day)s?$/;
const ABSOLUTE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: DAY_MS };

// null if the date doesn't exist (month 13, feb 30, 25:00...)
function utcTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | null {
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(timestamp);
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return valid ? timestamp : null;
}

function parseWhen(input: string, now: number): number | null {
  const text = input.trim().toLowerCase();

  const relative = RELATIVE.exec(text);
  if (relative) {
    const total = Number(relative[1]) * UNIT_MS[relative[2] as keyof typeof UNIT_MS];
    if (total > 0 && now + total <= MAX_TIMESTAMP) return now + total;
  }

  // a date keeps the current time of day
  const absolute = ABSOLUTE.exec(text);
  if (absolute) {
    const [day, month, year] = absolute.slice(1).map(Number);
    const current = new Date(now);
    return utcTimestamp(year, month, day, current.getUTCHours(), current.getUTCMinutes(), current.getUTCSeconds());
  }

  return null;
}

// the time can be one word ("30/12/2026") or three ("in 10 minutes")
function extractReminder(args: string[], now: number): { due: number; text: string; when: string } | null {
  for (const size of [3, 1]) {
    if (args.length < size) continue;
    const when = args.slice(0, size).join(' ');
    const due = parseWhen(when, now);
    if (due !== null) return { due, text: args.slice(size).join(' '), when };
  }
  return null;
}

function getReminderStore(env: Env) {
  return env.REMINDER_DO.get(env.REMINDER_DO.idFromName(REMINDER_INSTANCE_NAME));
}

// admin only, drops the pending reminders of this room (or of every room with "all")
async function clearReminders(env: Env, roomId: string, args: string[], userId: string): Promise<string> {
  if (userId !== env.MATRIX_USER_ID) return 'only bot admins can clear reminders';
  const all = args[0]?.toLowerCase() === 'all';
  if (args.length > 1 || (args.length === 1 && !all)) return REMIND_CLEAR_USAGE;

  const count = await getReminderStore(env).clear(all ? null : roomId);
  return `cleared ${count} reminder${count === 1 ? '' : 's'}${all ? '' : ' in this room'}`;
}

async function createReminder(
  env: Env,
  roomId: string,
  threadId: string | null,
  args: string[],
  userId: string,
): Promise<string> {
  if (args[0]?.toLowerCase() === 'clear') return clearReminders(env, roomId, args.slice(1), userId);
  if (args.length < 2) return REMIND_USAGE;

  const now = Date.now();
  const reminder = extractReminder(args, now);
  if (!reminder) {
    throw new Error(`couldn't parse time "${args[0]}" (try "in 10 minutes" or "30/12/2026")`);
  }
  if (!reminder.text) return REMIND_USAGE;
  if (reminder.due <= now) throw new Error('that time is in the past, pick a future time');

  await getReminderStore(env).schedule(roomId, threadId, reminder.due, reminder.text, userId);
  const when = reminder.when.toLowerCase();
  return `ok, I'll remind you ${when.startsWith('in ') ? '' : 'on '}${when}`;
}

type ReminderRow = {
  id: number;
  room_id: string;
  thread_id: string | null;
  text: string;
  attempts: number;
  user_id: string | null;
};

export class ReminderStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, due INTEGER NOT NULL, room_id TEXT NOT NULL, thread_id TEXT, text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)',
    );
    // user_id was added later, this fails when the column already exists
    try {
      ctx.storage.sql.exec('ALTER TABLE reminders ADD COLUMN user_id TEXT');
    } catch {}
  }

  async schedule(roomId: string, threadId: string | null, due: number, text: string, userId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      'INSERT INTO reminders (due, room_id, thread_id, text, user_id) VALUES (?, ?, ?, ?, ?)',
      due,
      roomId,
      threadId,
      text,
      userId,
    );
    await this.scheduleNext();
  }

  // null clears every room
  async clear(roomId: string | null): Promise<number> {
    const sql = this.ctx.storage.sql;
    const where = roomId === null ? '' : ' WHERE room_id = ?';
    const params = roomId === null ? [] : [roomId];
    const { count } = sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM reminders${where}`, ...params).one();
    sql.exec(`DELETE FROM reminders${where}`, ...params);
    await this.scheduleNext();
    return count;
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const rows = sql.exec<ReminderRow>('SELECT * FROM reminders WHERE due <= ? ORDER BY due', now).toArray();
    const bot = getBot(this.env);

    for (const row of rows) {
      try {
        await bot.deliverReminder(row.room_id, row.thread_id, row.text, row.user_id);
        sql.exec('DELETE FROM reminders WHERE id = ?', row.id);
      } catch (error) {
        console.error('reminder delivery failed:', error);
        if (row.attempts + 1 >= REMINDER_MAX_ATTEMPTS) {
          sql.exec('DELETE FROM reminders WHERE id = ?', row.id);
        } else {
          sql.exec(
            'UPDATE reminders SET attempts = attempts + 1, due = ? WHERE id = ?',
            now + REMINDER_RETRY_MS,
            row.id,
          );
        }
      }
    }

    await this.scheduleNext();
  }

  private async scheduleNext(): Promise<void> {
    const { next_due } = this.ctx.storage.sql
      .exec<{ next_due: number | null }>('SELECT MIN(due) AS next_due FROM reminders')
      .one();
    if (next_due === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next_due);
  }
}

// invites, invite sweeps and room upgrade following are switched off with MATRIX_AUTOJOIN,
// MATRIX_INVITE_SWEEP and MATRIX_FOLLOW_ROOM_UPGRADES in wrangler.toml, so invites stay pending
// for the owner. being kicked or banned is only recorded by the sdk, it never tries to rejoin
export class MatrixBot extends MatrixBotDO {
  override async alarm(): Promise<void> {
    // new invocation, new budget
    subrequestCount = 0;
    subrequestPaths = new Map();
    // releaseHold is private in the sdk (pinned to 0.7.0); it ends this alarm's hold window
    const sdk = this as unknown as { releaseHold?: (() => void) | null };
    if (!('releaseHold' in sdk)) console.warn('sdk changed: releaseHold is gone, subrequest rotation is off');
    endAlarmHold = () => {
      if (!sdk.releaseHold) return;
      console.log(`rotating keep-alive alarm after ${subrequestCount} subrequests`, JSON.stringify([...subrequestPaths]));
      sdk.releaseHold();
    };
    return super.alarm();
  }

  private get cfg(): Env {
    return this.env as unknown as Env;
  }

  // the bot only works in rooms without end-to-end encryption. unknown counts as encrypted
  private async isEncrypted(roomId: string): Promise<boolean> {
    const cached = encryptedRooms.get(roomId);
    if (cached !== undefined) return cached;
    try {
      const encrypted = await this.isRoomEncrypted(roomId);
      encryptedRooms.set(roomId, encrypted);
      return encrypted;
    } catch (error) {
      console.error(`encryption check failed for ${roomId}:`, error);
      return true;
    }
  }

  async deliverReminder(roomId: string, threadId: string | null, text: string, userId: string | null): Promise<void> {
    await this.ensureStarted();
    const thread = threadId ?? undefined;
    if (!userId) {
      await this.sendNotice(roomId, `⏰ reminder: ${text}`, { threadId: thread });
      return;
    }
    const user = escapeHtml(userId);
    await this.sendText(roomId, `${userId} ⏰ reminder: ${text}`, {
      threadId: thread,
      mentions: [userId],
      formattedBody: `<a href="https://matrix.to/#/${user}">${user}</a> ⏰ reminder: ${escapeHtml(text)}`,
    });
  }

  // the sdk drops messages sent by the bot's own account before onMessage. the bot runs as the
  // admin's account, so commands typed by the admin are picked up here from the raw event instead.
  // replies are m.notice, so the bot never reacts to its own answers
  protected override async onEvent(event: BotTimelineEvent): Promise<void> {
    if (event.type !== 'm.room.message' || event.sender !== this.cfg.MATRIX_USER_ID) return;
    if (!ALLOWED_ROOMS.has(event.roomId)) return; // rooms are opt-in, see ALLOWED_ROOMS
    if (event.encrypted) return; // encrypted rooms are not supported

    const { msgtype, body } = event.content;
    if (msgtype !== 'm.text' || typeof body !== 'string') return;
    if (!body.trimStart().toLowerCase().startsWith(COMMAND_PREFIX)) return;
    if (Date.now() - event.ts > OWN_COMMAND_MAX_AGE_MS) return; // replayed after a restart or backfill

    const doneKey = OWN_DONE_PREFIX + event.eventId;
    if (await this.ctx.storage.get(doneKey)) return;
    await this.ctx.storage.put(doneKey, event.ts);

    await this.onMessage({
      roomId: event.roomId,
      sender: event.sender,
      ts: event.ts,
      body,
      msgtype,
      eventIds: [event.eventId],
      content: event.content,
      ...(event.threadRootId ? { threadRootId: event.threadRootId } : {}),
    });
  }

  protected override async onMessage(message: BotMessage): Promise<void> {
    if (message.msgtype !== 'm.text') return;

    const [prefix = '', subcommand = '', ...args] = (message.body ?? '').trim().split(/\s+/);
    if (prefix.toLowerCase() !== COMMAND_PREFIX) return;

    const { roomId, sender } = message;
    if (!ALLOWED_ROOMS.has(roomId)) return; // rooms are opt-in, see ALLOWED_ROOMS
    if (await this.isEncrypted(roomId)) return; // encrypted rooms are not supported, stay silent

    const command = subcommand.toLowerCase();
    const threadId = message.threadRootId;
    const muteKey = MUTE_KEY_PREFIX + roomId;
    const env = this.cfg;

    // admin (the bot's own account) only, before the cooldown and mute checks so it always works
    if (command === 'mute' || command === 'unmute') {
      if (sender !== env.MATRIX_USER_ID) return;
      if (command === 'mute') await this.ctx.storage.put(muteKey, true);
      else await this.ctx.storage.delete(muteKey);
      return;
    }

    if (rateLimited(roomId) || (await this.ctx.storage.get(muteKey))) return;

    const reply = (text: string) => this.sendNotice(roomId, text, { threadId });

    // a typo gets a pointer to the command list, not the whole list
    if (command && !KNOWN_COMMANDS.has(command)) {
      await reply(UNKNOWN_COMMAND).catch(() => {});
      return;
    }
    if (args.length > 0 && command !== 'remind' && command !== 'rps') return;

    const replyImage = async (load: () => Promise<ImageFile>, failure: string) => {
      try {
        const image = await load();
        await this.sendFile(roomId, image.bytes, {
          filename: image.filename,
          mimetype: image.mimetype,
          msgtype: 'm.image',
          body: image.filename,
          threadId,
        });
        if (image.caption) await reply(image.caption).catch(() => {});
      } catch (error) {
        console.error(`${command} command failed:`, error);
        await reply(failure).catch(() => {});
      }
    };

    const replyText = async (run: () => string | Promise<string>) => {
      try {
        await reply(await run());
      } catch (error) {
        console.error(`${command} command failed:`, error);
        await reply(errorMessage(error)).catch(() => {});
      }
    };

    switch (command) {
      case 'inspire':
        return replyImage(fetchInspiroImage, "Couldn't generate the image.");
      case 'bunbun':
        return replyImage(() => fetchBunbunImage(env.ASSETS), "Couldn't fetch image.");
      case 'xkcd':
        return replyImage(fetchXkcdImage, "Couldn't fetch comic.");
      case 'catfact':
        return replyText(fetchCatFact);
      case 'meow':
        return replyText(() => fetchPet('meow', env.MEOW_BASE_URL));
      case 'bark':
        return replyText(() => fetchPet('bark', env.BARK_BASE_URL));
      case 'opsec':
        return replyText(fetchOpsec);
      case 'coinflip':
        return replyText(flipCoin);
      case 'rps':
        return replyText(() => playRps(args));
      case 'remind':
        return replyText(() => createReminder(env, roomId, threadId ?? null, args, sender));
      default:
        // bare "!faith" or "!faith help"
        return void (await this.sendNotice(roomId, HELP_INTRO, { threadId, formattedBody: HELP_HTML }).catch(() => {}));
    }
  }
}

interface Env {
  BOT_DO: DurableObjectNamespace<MatrixBot>;
  REMINDER_DO: DurableObjectNamespace<ReminderStore>;
  MATRIX_USER_ID: string;
  MATRIX_ACCESS_TOKEN?: string;
  MEOW_BASE_URL?: string;
  BARK_BASE_URL?: string;
  ASSETS: Fetcher;
}

function getBot(env: Env) {
  return env.BOT_DO.get(env.BOT_DO.idFromName(BOT_INSTANCE_NAME));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/') return new Response('Not found', { status: 404 });

    if (!env.MATRIX_ACCESS_TOKEN) {
      console.error('MATRIX_ACCESS_TOKEN is not set');
      return Response.json({ ok: false, error: 'missing_configuration' }, { status: 500 });
    }

    try {
      const { started } = await getBot(env).ensureStarted();
      return Response.json({ ok: true, started });
    } catch (error) {
      console.error('bot failed to start:', error);
      return Response.json({ ok: false, error: 'start_failed' }, { status: 500 });
    }
  },
};
