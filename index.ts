import { DurableObject } from 'cloudflare:workers';
import { MatrixBotDO, type BotMessage } from '@ixo/matrix-bot-workers-sdk';

const BOT_INSTANCE_NAME = 'Matrix-Bot';
const REMINDER_INSTANCE_NAME = 'Reminders';
const INSPIRO_API_URL = 'https://inspirobot.me/api?generate=true';
const CATFACT_API_URL = 'https://catfact.ninja/fact';
const XKCD_URL = 'https://xkcd.com';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const BUNBUN_COUNT = 16;
const COOLDOWN_MS = 1_000;
const REMINDER_MAX_ATTEMPTS = 5;
const REMINDER_RETRY_MS = 10_000;
const MUTE_KEY_PREFIX = 'faith:muted:';

// can invite the bot and mute/unmute it
const BOT_ADMINS = new Set([
  '@fatih:federated.nexus',
  '@usr40k:usr40k.dev',
  '@angeline:matrix.anarchists.space',
  '@cj:foxnet.systems',
]);

const COMMAND_PREFIX = '!faith';
const KNOWN_COMMANDS = new Set([
  'help',
  'inspire',
  'catfact',
  'meow',
  'bark',
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

// the bot never sends read receipts, those requests are answered locally
const RECEIPT_PATH = /\/rooms\/[^/]+\/(?:receipt\/|read_markers)/;
const SYNC_PATH = /\/_matrix\/client\/(?:v\d+|r0)\/sync$/;
const BOT_USER_ID = '@lulz:federated.nexus'; // same as MATRIX_USER_ID in wrangler.toml
const realFetch = globalThis.fetch.bind(globalThis);

// typing, read receipts and presence wake every long-poll /sync for nothing, and on the
// free plan each /sync is one of the 50 subrequests an invocation gets
const slimFilters = new Map<string, string>();
let slimLogged = false;

const NOISY_TIMELINE = [
  'm.reaction',
  'm.room.redaction',
  'm.room.name',
  'm.room.topic',
  'm.room.avatar',
  'm.room.pinned_events',
];

function slimFilter(base: any): string {
  const none = { not_types: ['*'] };
  const filter = { ...base };
  const room = filter.room ?? {};
  filter.presence = { ...filter.presence, ...none };
  filter.room = {
    ...room,
    ephemeral: { ...room.ephemeral, ...none },
    account_data: { ...room.account_data, ...none },
    timeline: { ...room.timeline, not_types: [...(room.timeline?.not_types ?? []), ...NOISY_TIMELINE] },
  };
  return JSON.stringify(filter);
}

async function slimSyncUrl(url: string, init?: RequestInit): Promise<string> {
  const u = new URL(url);
  if (!SYNC_PATH.test(u.pathname)) return url;

  const current = u.searchParams.get('filter');
  let slim: string | undefined;
  if (!current) {
    slim = slimFilter({});
  } else if (current.startsWith('{')) {
    slim = slimFilter(JSON.parse(current));
  } else {
    slim = slimFilters.get(current);
    if (slim === undefined) {
      slim = '';
      try {
        const auth = new Headers(init?.headers).get('authorization');
        const stored = `${u.origin}/_matrix/client/v3/user/${encodeURIComponent(BOT_USER_ID)}/filter/${encodeURIComponent(current)}`;
        const res = await realFetch(stored, auth ? { headers: { authorization: auth } } : undefined);
        if (res.ok) {
          slim = slimFilter(await res.json());
        } else {
          res.body?.cancel();
          console.log(`sync filter: stored filter ${current} not readable (HTTP ${res.status})`);
        }
      } catch (error) {
        console.log(`sync filter: stored filter ${current} not readable: ${errorMessage(error)}`);
      }
      slimFilters.set(current, slim);
    }
  }

  if (!slim) return url;
  if (!slimLogged) {
    slimLogged = true;
    console.log('sync filter: presence, typing and receipts are off');
  }
  u.searchParams.set('filter', slim);
  return u.toString();
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (RECEIPT_PATH.test(url)) return Response.json({});

  const slim = await slimSyncUrl(url, init).catch(() => url);
  if (slim === url) return realFetch(input, init);
  return realFetch(input instanceof Request ? new Request(slim, input) : slim, init);
};

const lastUse = new Map<string, number>();
const approvedRooms = new Set<string>();
let enforcing = false;

interface ImageFile {
  bytes: Uint8Array;
  mimetype: string;
  filename: string;
  caption?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

async function fetchInspiroImage(): Promise<ImageFile> {
  const api = await fetch(INSPIRO_API_URL);
  if (!api.ok) throw new Error(`inspirobot request failed: HTTP ${api.status}`);

  const url = (await api.text()).trim();
  if (!url.startsWith('https://')) throw new Error(`unexpected inspirobot response: ${url.slice(0, 80)}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`image too large: ${bytes.byteLength} bytes`);

  const mimetype = res.headers.get('content-type')?.split(';')[0].trim() || 'image/jpeg';
  return { bytes, mimetype, filename: `inspirobot.${mimetype === 'image/png' ? 'png' : 'jpg'}` };
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

  const res = await fetch(comic.img);
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`image too large: ${bytes.byteLength} bytes`);

  const mimetype = res.headers.get('content-type')?.split(';')[0].trim() || 'image/png';
  const caption = `xkcd #${num}: ${comic.safe_title}`;
  return { bytes, mimetype, filename: `xkcd-${num}.${mimetype.split('/')[1]}`, caption };
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

async function fetchMeow(baseUrl?: string): Promise<string> {
  if (!baseUrl) throw new Error('MEOW_BASE_URL is not set in wrangler.toml');
  try {
    const { meow } = await getJson<{ meow?: string }>(`${baseUrl.replace(/\/+$/, '')}/meow`);
    if (!meow) throw new Error('empty response');
    return `${meow}`;
  } catch (error) {
    throw new Error(`meow service failed: ${errorMessage(error)}`);
  }
}

async function fetchBark(baseUrl?: string): Promise<string> {
  if (!baseUrl) throw new Error('BARK_BASE_URL is not set in wrangler.toml');
  try {
    const { bark } = await getJson<{ bark?: string }>(`${baseUrl.replace(/\/+$/, '')}/bark`);
    if (!bark) throw new Error('empty response');
    return `${bark}`;
  } catch (error) {
    throw new Error(`bark service failed: ${errorMessage(error)}`);
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

// admin only, drops the pending reminders of this room (or of every room with "all")
async function clearReminders(env: Env, roomId: string, args: string[], userId: string): Promise<string> {
  if (!BOT_ADMINS.has(userId)) return 'only bot admins can clear reminders';
  const all = args[0]?.toLowerCase() === 'all';
  if (args.length > 1 || (args.length === 1 && !all)) return REMIND_CLEAR_USAGE;

  const store = env.REMINDER_DO.get(env.REMINDER_DO.idFromName(REMINDER_INSTANCE_NAME));
  const count = await store.clear(all ? null : roomId);
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

  const store = env.REMINDER_DO.get(env.REMINDER_DO.idFromName(REMINDER_INSTANCE_NAME));
  await store.schedule(roomId, threadId, reminder.due, reminder.text, userId);
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

export class MatrixBot extends MatrixBotDO {
  protected override async shouldJoinRoom(roomId: string, inviter: string): Promise<boolean> {
    if (!BOT_ADMINS.has(inviter)) {
      console.log(`Rejected invite to ${roomId} from unauthorized user: ${inviter}`);
      return false; // enforceRoomPolicy() declines the pending invite
    }
    console.log(`Accepted invite to ${roomId} from trusted user: ${inviter}`);
    return true;
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

  protected override async onStarted(): Promise<void> {
    await this.enforceRoomPolicy();
  }

  // leaves rooms (and declines invites) that didn't come from an admin. if the inviter
  // is unknown (joined before the sdk recorded it) the room stays as long as an admin is in it
  async enforceRoomPolicy(): Promise<void> {
    if (enforcing) return;
    enforcing = true;
    try {
      const rooms = this.ctx.storage.sql
        .exec<{ room_id: string; membership: string; inviter: string | null }>(
          "SELECT room_id, membership, inviter FROM bot_rooms WHERE membership IN ('join', 'invite')",
        )
        .toArray();

      for (const { room_id: roomId, membership, inviter } of rooms) {
        try {
          if (inviter && BOT_ADMINS.has(inviter)) continue;
          if (membership === 'join' && !inviter && (await this.hasAdminMember(roomId))) continue;
          console.log(`Leaving ${roomId} (${membership}): inviter is ${inviter || 'unknown'}, not an admin`);
          await this.leaveRoom(roomId);
        } catch (error) {
          console.error(`room policy check failed for ${roomId}:`, error);
        }
      }
    } finally {
      enforcing = false;
    }
  }

  private async hasAdminMember(roomId: string): Promise<boolean> {
    if (approvedRooms.has(roomId)) return true;
    const members = await this.getJoinedRoomMembers(roomId);
    const found = members.some((userId) => BOT_ADMINS.has(userId));
    if (found) approvedRooms.add(roomId);
    return found;
  }

  protected override async onMessage(message: BotMessage): Promise<void> {
    if (message.msgtype !== 'm.text') return;

    const [prefix = '', subcommand = '', ...args] = (message.body ?? '').trim().split(/\s+/);
    if (prefix.toLowerCase() !== COMMAND_PREFIX) return;

    const command = subcommand.toLowerCase();
    const { roomId, sender } = message;
    const threadId = message.threadRootId;
    const muteKey = MUTE_KEY_PREFIX + roomId;

    // before the cooldown and mute checks so it always works
    if (command === 'mute' || command === 'unmute') {
      if (!BOT_ADMINS.has(sender)) return;
      if (command === 'mute') await this.ctx.storage.put(muteKey, true);
      else await this.ctx.storage.delete(muteKey);
      return;
    }

    if (rateLimited(roomId) || (await this.ctx.storage.get(muteKey))) return;

    const reply = (text: string) => this.sendNotice(roomId, text, { threadId });
    const replyHelp = () => this.sendNotice(roomId, HELP_INTRO, { threadId, formattedBody: HELP_HTML }).catch(() => {});

    // a typo gets a pointer to the command list, not the whole list
    if (command && !KNOWN_COMMANDS.has(command)) {
      await reply(UNKNOWN_COMMAND).catch(() => {});
      return;
    }
    if (args.length > 0 && command !== 'remind' && command !== 'rps') return;

    const env = this.env as unknown as Env;

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
        return replyText(() => fetchMeow(env.MEOW_BASE_URL));
      case 'bark':
        return replyText(() => fetchBark(env.BARK_BASE_URL));
      case 'coinflip':
        return replyText(flipCoin);
      case 'rps':
        return replyText(() => playRps(args));
      case 'remind':
        return replyText(() => createReminder(env, roomId, threadId ?? null, args, sender));
      default:
        // bare "!faith" or "!faith help"
        return replyHelp();
    }
  }
}

interface Env {
  BOT_DO: DurableObjectNamespace<MatrixBot>;
  REMINDER_DO: DurableObjectNamespace<ReminderStore>;
  MATRIX_PASSWORD?: string;
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

    if (!env.MATRIX_PASSWORD) {
      console.error('MATRIX_PASSWORD is not set');
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

  // keeps the bot running and sweeps rooms it shouldn't be in
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (!env.MATRIX_PASSWORD) return;
    try {
      const bot = getBot(env);
      await bot.ensureStarted();
      await bot.enforceRoomPolicy();
    } catch (error) {
      console.error('scheduled tick failed:', error);
    }
  },
};
